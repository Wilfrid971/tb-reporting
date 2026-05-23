const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authMiddleware, SECRET } = require('../middleware/auth');
const { listDatabases, getUserPool } = require('../../config/database');

const router = express.Router();

// Société du tiers système (TIRTYPE='S') — utilisée pour l'en-tête
// Essaie TIRSOCIETE puis TIRRS1 (selon la version du schéma Wavesoft)
async function fetchSociete(user) {
  try {
    const pool = await getUserPool(user);
    for (const col of ['TIRSOCIETE', 'TIRRS1']) {
      try {
        const r = await pool.request().query(
          `SELECT TOP 1 RTRIM(${col}) AS societe FROM TIERS WHERE TIRTYPE='S' AND ${col} IS NOT NULL`
        );
        if (r.recordset[0]?.societe) return r.recordset[0].societe;
      } catch { /* colonne absente — essai suivant */ }
    }
    return null;
  } catch (e) {
    console.warn('[Auth/fetchSociete]', e.message);
    return null;
  }
}

const USERS_FILE = path.join(__dirname, '../../data/users.json');
const GROUPS_FILE = path.join(__dirname, '../../data/groups.json');

function readUsers() { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
function writeUsers(d) { fs.writeFileSync(USERS_FILE, JSON.stringify(d, null, 2)); }
function readGroups() { return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')); }
function writeGroups(d) { fs.writeFileSync(GROUPS_FILE, JSON.stringify(d, null, 2)); }

// ── Bases de données disponibles (public) ─────────────────────────────────────
router.get('/databases', async (req, res) => {
  try {
    const dbs = await listDatabases();
    res.json(dbs);
  } catch (err) {
    console.error('[Auth/databases]', err.message);
    res.status(500).json({ error: 'Impossible de lister les bases de données : ' + err.message });
  }
});

// ── Login ──────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password, database, connId } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Identifiants manquants' });

  const users = readUsers();
  const usernameLc = String(username).toLowerCase();
  const user = users.find(u => u && typeof u.username === 'string' && u.username.toLowerCase() === usernameLc && u.active !== false);
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });
  if (!user.password) return res.status(401).json({ error: 'Compte mal configuré (mot de passe absent)' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Identifiants incorrects' });

  const groups = readGroups();
  const group = groups.find(g => g.id === user.group) || { pages: [], dashboards: [], reports: [] };

  const effectiveConnId = connId && connId !== 'default' ? connId : null;
  const societe = await fetchSociete({ database, connId: effectiveConnId });

  const payload = {
    id: user.id,
    username: user.username,
    group: user.group,
    groupName: group.name,
    pages: group.pages,
    pagePerms: group.pagePerms || {},
    dashboards: group.dashboards,
    reports: group.reports,
    ...(database ? { database } : {}),
    ...(effectiveConnId ? { connId: effectiveConnId } : {}),
    ...(societe ? { societe } : {})
  };

  const token = jwt.sign(payload, SECRET, { expiresIn: '12h' });
  res.json({ token, user: payload });
});

// ── Me ─────────────────────────────────────────────────────────────────────────
// Retourne les droits *à jour* (relus depuis groups.json) et réémet un JWT
// — permet aux clients de rafraîchir leur session sans déconnexion/reconnexion
// quand un admin modifie les droits du groupe.
router.get('/me', authMiddleware, async (req, res) => {
  const users = readUsers();
  const u = users.find(x => x.id === req.user.id);
  if (!u || u.active === false) return res.status(401).json({ error: 'Compte désactivé' });

  const groups = readGroups();
  const group = groups.find(g => g.id === req.user.group) || { pages: [], pagePerms: {}, dashboards: [], reports: [] };
  const societe = req.user.societe || await fetchSociete(req.user);

  const payload = {
    id: req.user.id,
    username: req.user.username,
    group: req.user.group,
    groupName: group.name,
    pages: group.pages || [],
    pagePerms: group.pagePerms || {},
    dashboards: group.dashboards || [],
    reports: group.reports || [],
    ...(req.user.database ? { database: req.user.database } : {}),
    ...(req.user.connId ? { connId: req.user.connId } : {}),
    ...(societe ? { societe } : {})
  };

  // Session glissante 12h : à chaque /me on réémet un token frais avec les
  // droits courants — les UI peuvent ainsi détecter révocations et nouvelles permissions.
  const token = jwt.sign(payload, SECRET, { expiresIn: '12h' });
  res.json({ ...payload, token });
});

// ── Users CRUD (admin only) ────────────────────────────────────────────────────
router.get('/users', authMiddleware, (req, res) => {
  if (!hasAdminAccess(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const users = readUsers().map(u => ({ id: u.id, username: u.username, group: u.group, active: u.active !== false }));
  res.json(users);
});

router.post('/users', authMiddleware, async (req, res) => {
  if (!hasAdminAccess(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { username, password, group } = req.body || {};
  if (!username || !password || !group) return res.status(400).json({ error: 'Champs manquants' });
  const users = readUsers();
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Utilisateur déjà existant' });
  const hashed = await bcrypt.hash(password, 10);
  const newUser = { id: 'usr-' + Date.now(), username, password: hashed, group, active: true };
  users.push(newUser);
  writeUsers(users);
  res.json({ id: newUser.id, username, group, active: true });
});

router.put('/users/:id', authMiddleware, async (req, res) => {
  if (!hasAdminAccess(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Introuvable' });
  const { username, password, group, active } = req.body || {};
  if (username) users[idx].username = username;
  if (password) users[idx].password = await bcrypt.hash(password, 10);
  if (group) users[idx].group = group;
  if (active !== undefined) users[idx].active = active;
  writeUsers(users);
  res.json({ id: users[idx].id, username: users[idx].username, group: users[idx].group, active: users[idx].active });
});

router.delete('/users/:id', authMiddleware, (req, res) => {
  if (!hasAdminAccess(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });
  let users = readUsers();
  const before = users.length;
  users = users.filter(u => u.id !== req.params.id);
  if (users.length === before) return res.status(404).json({ error: 'Introuvable' });
  writeUsers(users);
  res.json({ ok: true });
});

// ── Groups CRUD (admin only) ───────────────────────────────────────────────────
router.get('/groups', authMiddleware, (req, res) => {
  if (!hasAdminAccess(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(readGroups());
});

router.post('/groups', authMiddleware, (req, res) => {
  if (!hasAdminAccess(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { name, pages, dashboards, reports } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom manquant' });
  const groups = readGroups();
  const { pagePerms } = req.body || {};
  const g = { id: 'grp-' + Date.now(), name, pages: pages || [], pagePerms: pagePerms || {}, dashboards: dashboards || [], reports: reports || [] };
  groups.push(g);
  writeGroups(groups);
  res.json(g);
});

router.put('/groups/:id', authMiddleware, (req, res) => {
  if (!hasAdminAccess(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const groups = readGroups();
  const idx = groups.findIndex(g => g.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Introuvable' });
  const { name, pages, pagePerms, dashboards, reports } = req.body || {};
  if (name) groups[idx].name = name;
  if (pages) groups[idx].pages = pages;
  if (pagePerms !== undefined) groups[idx].pagePerms = pagePerms;
  if (dashboards) groups[idx].dashboards = dashboards;
  if (reports) groups[idx].reports = reports;
  writeGroups(groups);
  res.json(groups[idx]);
});

router.delete('/groups/:id', authMiddleware, (req, res) => {
  if (!hasAdminAccess(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  if (req.params.id === 'grp-admin') return res.status(400).json({ error: 'Impossible de supprimer le groupe Administrateurs' });
  let groups = readGroups();
  const before = groups.length;
  groups = groups.filter(g => g.id !== req.params.id);
  if (groups.length === before) return res.status(404).json({ error: 'Introuvable' });
  writeGroups(groups);
  res.json({ ok: true });
});

function hasAdminAccess(user) {
  const groups = readGroups();
  const g = groups.find(x => x.id === user.group);
  return g && (g.pages.includes('*') || g.pages.includes('backoffice'));
}

module.exports = router;

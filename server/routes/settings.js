const express    = require('express');
const router     = express.Router();
const fs         = require('fs');
const path       = require('path');
const nodemailer = require('nodemailer');
const { testConnectionWith, resetPool, resetConnPool, listAllDatabases } = require('../../config/database');

const SETTINGS_FILE = path.join(__dirname, '../../data/settings.json');

const DEFAULTS = {
  db: {
    type: 'sqlserver', server: '', database: '', port: 1433,
    trusted: false, user: '', password: '',
    encrypt: false, trustCert: true
  },
  as400: {
    host: '', database: '', user: '', password: '',
    port: 446, ssl: false, driver: 'IBM i Access ODBC Driver'
  },
  smtp: {
    preset: 'custom', host: '', port: 587, secure: false,
    user: '', password: '', from: ''
  },
  theme:    { name: 'dark' },
  app:      { dateFormat: 'DD/MM/YYYY' },
  calcul:   { pr: 'PLVCRUMP', mg: 'sf' },
  periodes: { nbExercices: 5, nbAnneesCal: 5 },
  loginDatabases: [], // [{ name: "WAVESOFT_PROD", alias: "Principal" }] — [] = toutes exposées
};

function read() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function write(data) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}
function masked(s) {
  const m = JSON.parse(JSON.stringify(s));
  if (m.db?.password)    m.db.password    = '***';
  if (m.as400?.password) m.as400.password = '***';
  if (m.smtp?.password)  m.smtp.password  = '***';
  return m;
}

// GET — paramètres (mots de passe masqués)
router.get('/', (req, res) => res.json(masked(read())));

// PUT — sauvegarde (conserve le MDP existant si '***')
router.put('/', async (req, res) => {
  const cur  = read();
  const body = req.body;
  const keep = (section, key) => {
    // Section non modifiée dans le body → garde la valeur courante
    if (!body[section] || body[section][key] === undefined) return cur[section]?.[key] ?? '';
    // Marqueur "***" → garde la valeur courante (l'UI ne renvoie jamais le mdp en clair)
    if (body[section][key] === '***') return cur[section]?.[key] ?? '';
    return body[section][key];
  };

  const merged = {
    db: {
      ...cur.db, ...(body.db || {}),
      password: keep('db', 'password'),
    },
    as400: {
      ...cur.as400, ...(body.as400 || {}),
      password: keep('as400', 'password'),
    },
    smtp: {
      ...cur.smtp, ...(body.smtp || {}),
      password: keep('smtp', 'password'),
    },
    theme:    body.theme    ? { ...cur.theme,    ...body.theme    } : cur.theme,
    app:      body.app      ? { ...cur.app,      ...body.app      } : cur.app,
    calcul:   body.calcul   ? { ...cur.calcul,   ...body.calcul   } : cur.calcul,
    periodes: body.periodes ? { ...cur.periodes, ...body.periodes } : (cur.periodes || DEFAULTS.periodes),
    loginDatabases: Array.isArray(body.loginDatabases)
      ? body.loginDatabases
          .filter(e => e && typeof e.name === 'string' && e.name.trim())
          .map(e => ({ name: e.name.trim(), alias: (e.alias || '').trim() }))
      : (cur.loginDatabases || []),
  };
  write(merged);
  if (body.db) await resetPool();
  res.json({ ok: true, settings: masked(merged) });
});

// GET /databases-available — liste brute des bases détectées sur l'instance SQL
// Sert à peupler l'UI de sélection "Bases autorisées au login"
router.get('/databases-available', async (req, res) => {
  try {
    const dbs = await listAllDatabases();
    res.json(dbs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /test-db — teste la connexion SQL Server
router.post('/test-db', async (req, res) => {
  const cur   = read();
  const dbCfg = { ...cur.db, ...(req.body?.db || {}) };
  if (dbCfg.password === '***') dbCfg.password = cur.db.password;
  try {
    const info = await testConnectionWith(dbCfg);
    res.json({ ok: true, server: info.srv, database: info.db, time: info.now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /test-email — envoie un email de test
router.post('/test-email', async (req, res) => {
  const cur  = read();
  const smtp = { ...cur.smtp, ...(req.body?.smtp || {}) };
  if (smtp.password === '***') smtp.password = cur.smtp.password;
  const to = req.body?.to || smtp.user;
  if (!smtp.host || !smtp.user) return res.status(400).json({ ok: false, error: 'SMTP non configuré' });
  try {
    const t = nodemailer.createTransport({
      host: smtp.host,
      port: parseInt(smtp.port) || 587,
      secure: smtp.secure === true || smtp.secure === 'true',
      auth: { user: smtp.user, pass: smtp.password },
      family: 4,
    });
    await t.sendMail({
      from: smtp.from || smtp.user,
      to,
      subject: 'Test TB Reporting — Configuration email',
      html: `<div style="font-family:Arial;padding:24px">
        <h2 style="color:#1a237e;margin-bottom:8px">✅ Configuration email fonctionnelle</h2>
        <p>Serveur&nbsp;: <strong>${smtp.host}:${smtp.port}</strong></p>
        <p>Compte&nbsp;&nbsp;: <strong>${smtp.user}</strong></p>
        <p style="color:#666;font-size:12px;margin-top:16px">Envoyé le ${new Date().toLocaleString('fr-FR')}</p>
      </div>`
    });
    res.json({ ok: true, to });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Connexions multi-serveurs ──────────────────────────────────────────────────

const CONNS_FILE = path.join(__dirname, '../../data/connections.json');

function readConns() {
  try { return JSON.parse(fs.readFileSync(CONNS_FILE, 'utf8')); } catch { return []; }
}
function writeConns(data) {
  fs.mkdirSync(path.dirname(CONNS_FILE), { recursive: true });
  fs.writeFileSync(CONNS_FILE, JSON.stringify(data, null, 2));
}
function maskedConn(c) { return { ...c, password: c.password ? '***' : '' }; }

router.get('/connections', (req, res) => res.json(readConns().map(maskedConn)));

router.post('/connections', (req, res) => {
  const conns = readConns();
  const conn = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label:    req.body.label    || 'Nouvelle connexion',
    server:   req.body.server   || '',
    port:     parseInt(req.body.port) || 1433,
    database: req.body.database || '',
    trusted:  req.body.trusted === true || req.body.trusted === 'true',
    user:     req.body.user     || '',
    password: req.body.password || '',
    encrypt:  req.body.encrypt  === true || req.body.encrypt === 'true',
    trustCert:req.body.trustCert !== false && req.body.trustCert !== 'false',
  };
  conns.push(conn);
  writeConns(conns);
  res.json({ ok: true, conn: maskedConn(conn) });
});

router.put('/connections/:id', (req, res) => {
  const conns = readConns();
  const idx = conns.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Connexion introuvable' });
  const cur = conns[idx];
  const b = req.body;
  conns[idx] = {
    ...cur,
    label:    b.label    !== undefined ? b.label    : cur.label,
    server:   b.server   !== undefined ? b.server   : cur.server,
    port:     b.port     !== undefined ? (parseInt(b.port) || cur.port) : cur.port,
    database: b.database !== undefined ? b.database : cur.database,
    trusted:  b.trusted  !== undefined ? (b.trusted === true || b.trusted === 'true') : cur.trusted,
    user:     b.user     !== undefined ? b.user     : cur.user,
    password: b.password === '***'     ? cur.password : (b.password !== undefined ? b.password : cur.password),
    encrypt:  b.encrypt  !== undefined ? (b.encrypt === true || b.encrypt === 'true') : cur.encrypt,
    trustCert:b.trustCert!== undefined ? (b.trustCert !== false && b.trustCert !== 'false') : cur.trustCert,
  };
  writeConns(conns);
  resetConnPool(req.params.id).catch(() => {});
  res.json({ ok: true, conn: maskedConn(conns[idx]) });
});

router.delete('/connections/:id', async (req, res) => {
  const conns = readConns();
  const idx = conns.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Connexion introuvable' });
  conns.splice(idx, 1);
  writeConns(conns);
  await resetConnPool(req.params.id).catch(() => {});
  res.json({ ok: true });
});

router.post('/connections/:id/test', async (req, res) => {
  const conns = readConns();
  const conn  = conns.find(c => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connexion introuvable' });
  try {
    const info = await testConnectionWith(conn);
    res.json({ ok: true, server: info.srv, database: info.db, time: info.now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

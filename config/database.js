const sql  = require('mssql');
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

// DATEFORMAT ymd forcé au niveau du pool (option tedious `dateFormat`).
// Les serveurs SQL Server en locale française interprètent par défaut les
// varchar ISO `YYYY-MM-DD` comme DMY (Msg 242 sur certaines valeurs).
// Défini dans `buildConfig` ci-dessous → session-scoped, pas d'impact sur
// les connexions Wavesoft/ERP ni les autres applications.

const SETTINGS_FILE = path.join(__dirname, '../data/settings.json');
const CONNS_FILE    = path.join(__dirname, '../data/connections.json');

function loadConnections() {
  try { return JSON.parse(fs.readFileSync(CONNS_FILE, 'utf8')); } catch { return []; }
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

function buildConfig(override) {
  const db = override || loadSettings().db || {};
  const trusted = db.trusted !== undefined ? db.trusted : (process.env.DB_TRUSTED_CONNECTION === 'true');
  const cfg = {
    server:   db.server   || process.env.DB_SERVER,
    port:     parseInt(db.port) || parseInt(process.env.DB_PORT) || 1433,
    database: db.database || process.env.DB_DATABASE,
    options: {
      encrypt:               db.encrypt   !== undefined ? db.encrypt   : (process.env.DB_ENCRYPT === 'true'),
      trustServerCertificate:db.trustCert !== undefined ? db.trustCert : (process.env.DB_TRUST_SERVER_CERTIFICATE === 'true'),
      trustedConnection: trusted,
      dateFormat: 'ymd',
    },
    connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 30000,
    requestTimeout:    parseInt(process.env.DB_REQUEST_TIMEOUT)    || 30000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };
  if (!trusted) {
    cfg.user     = db.user     || process.env.DB_USER;
    cfg.password = db.password || process.env.DB_PASSWORD;
  }
  return cfg;
}

// Pool par base de données — on utilise ConnectionPool, jamais sql.connect()
const pools = {};

async function getPool(database) {
  const settings = loadSettings().db || {};
  const db = database || settings.database || process.env.DB_DATABASE;
  if (!pools[db]) {
    const cfg = buildConfig({ ...settings, database: db });
    const auth = cfg.options.trustedConnection ? 'Windows' : `SQL (${cfg.user})`;
    console.log(`[DB] Connexion ${cfg.server}/${db} — ${auth}`);
    const pool = new sql.ConnectionPool(cfg);
    await pool.connect();
    pool.on('error', err => {
      console.error(`[DB] Erreur pool ${db}:`, err.message);
      delete pools[db];
    });
    pools[db] = pool;
    console.log(`[DB] Connecté à ${db}.`);
  }
  return pools[db];
}

// Pools nommés — connexions multi-serveurs
const connPools = {};

async function getConnPool(connId, dbOverride = null) {
  if (!connId || connId === 'default') return getPool(dbOverride);
  const cacheKey = dbOverride ? `${connId}::${dbOverride}` : connId;
  if (connPools[cacheKey]) return connPools[cacheKey];
  const conn = loadConnections().find(c => c.id === connId);
  if (!conn) throw new Error(`Connexion inconnue : ${connId}`);
  const effectiveConn = dbOverride ? { ...conn, database: dbOverride } : conn;
  const cfg = buildConfig(effectiveConn);
  const auth = cfg.options.trustedConnection ? 'Windows' : `SQL (${cfg.user})`;
  console.log(`[DB] Connexion [${cacheKey}] ${cfg.server}/${cfg.database} — ${auth}`);
  const pool = new sql.ConnectionPool(cfg);
  await pool.connect();
  pool.on('error', err => { console.error(`[DB] Erreur pool [${cacheKey}]:`, err.message); delete connPools[cacheKey]; });
  connPools[cacheKey] = pool;
  console.log(`[DB] Connecté [${cacheKey}].`);
  return pool;
}

async function getUserPool(user) {
  const connId = user?.connId;
  const database = user?.database;
  if (!connId || connId === 'default') return getPool(database);
  return getConnPool(connId, database);
}

async function getConnPools(dbsParam, userOrDatabase) {
  // Rétro-compat : userOrDatabase peut être une string (database) ou un objet user
  const user = (typeof userOrDatabase === 'string' || userOrDatabase == null)
    ? { database: userOrDatabase || undefined }
    : userOrDatabase;
  const defaultEntry = async () => ({ pool: await getUserPool(user), label: 'Défaut', id: 'default' });
  if (!dbsParam) return [await defaultEntry()];
  const ids = String(dbsParam).split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return [await defaultEntry()];
  const conns = loadConnections();
  return Promise.all(ids.map(async id => {
    if (id === 'default') return await defaultEntry();
    const conn = conns.find(c => c.id === id);
    return { pool: await getConnPool(id), label: conn?.label || id, id };
  }));
}

async function resetConnPool(connId) {
  if (connId) {
    if (connPools[connId]) { try { await connPools[connId].close(); } catch {} delete connPools[connId]; }
  } else {
    for (const id of Object.keys(connPools)) { try { await connPools[id].close(); } catch {} delete connPools[id]; }
  }
}

async function resetPool(database) {
  if (database) {
    if (pools[database]) { try { await pools[database].close(); } catch {} delete pools[database]; }
  } else {
    for (const db of Object.keys(pools)) {
      try { await pools[db].close(); } catch {}
      delete pools[db];
    }
  }
}

async function testConnectionWith(dbConfig) {
  const cfg = buildConfig(dbConfig);
  const pool = new sql.ConnectionPool(cfg);
  await pool.connect();
  try {
    const r = await pool.request().query('SELECT GETDATE() AS now, DB_NAME() AS db, @@SERVERNAME AS srv');
    return r.recordset[0];
  } finally {
    await pool.close();
  }
}

// Récupère le libellé société d'une base (essaie TIRSOCIETE puis TIRRS1)
async function _fetchSocieteLabel(pool, dbName) {
  const ref = dbName ? `[${dbName}].dbo.TIERS` : 'TIERS';
  for (const col of ['TIRSOCIETE', 'TIRRS1']) {
    try {
      const r = await pool.request().query(
        `SELECT TOP 1 RTRIM(${col}) AS lbl FROM ${ref} WHERE TIRTYPE='S' AND ${col} IS NOT NULL`
      );
      if (r.recordset[0]?.lbl) return r.recordset[0].lbl.trim();
    } catch { /* colonne absente — essai suivant */ }
  }
  return null;
}

// Récupère le libellé société depuis un pool déjà connecté (sans cross-DB)
async function fetchPoolSociete(pool) {
  if (!pool) return null;
  return _fetchSocieteLabel(pool, null);
}

// Pour un dbs param (CSV d'IDs de connexion ou 'default'), retourne la liste
// { id, label, societe } pour chaque base — sert à afficher les sociétés dans
// les en-têtes d'exports/emails (mono ou multi-base).
async function getDbsSocietes(dbsParam, userInfo) {
  const pools = await getConnPools(dbsParam, userInfo);
  return Promise.all(pools.map(async ({ pool, label, id }) => ({
    id, label, societe: (await fetchPoolSociete(pool)) || label
  })));
}

// Lecture brute des bases pour une config serveur donnée
async function _listDbsForServerConfig(serverConfig) {
  const cfg = buildConfig({ ...serverConfig, database: 'master' });
  const pool = new sql.ConnectionPool(cfg);
  await pool.connect();
  try {
    const dbRes = await pool.request().query(`
      SELECT name FROM sys.databases
      WHERE name NOT IN ('master','tempdb','model','msdb')
        AND state = 0
      ORDER BY name
    `);
    const dbNames = dbRes.recordset.map(r => r.name);
    const result = [];
    for (const name of dbNames) {
      const label = await _fetchSocieteLabel(pool, name) || name;
      result.push({ name, label });
    }
    return result;
  } finally {
    await pool.close();
  }
}

// Toutes les bases visibles sur le serveur principal
async function listAllDatabases() {
  const settings = loadSettings();
  try {
    return await _listDbsForServerConfig(settings.db || {});
  } catch (e) {
    console.warn('[listAllDatabases] Serveur principal indisponible:', e.message);
    return [];
  }
}

// Liste exposée au login : filtrée par whitelist + aliases (settings.loginDatabases)
// Si whitelist vide/absente → toutes les bases sont exposées.
async function listDatabases() {
  const all = await listAllDatabases();
  const whitelist = loadSettings().loginDatabases;
  if (!Array.isArray(whitelist) || whitelist.length === 0) return all;

  const map = new Map(whitelist.map(w => [w.name, w]));
  return all
    .filter(db => map.has(db.name))
    .map(db => {
      const alias = (map.get(db.name)?.alias || '').trim();
      return { name: db.name, label: alias || db.label };
    });
}

module.exports = { getPool, getConnPool, getConnPools, getUserPool, resetConnPool, resetPool, buildConfig, testConnectionWith, listDatabases, listAllDatabases, loadConnections, fetchPoolSociete, getDbsSocietes, sql };

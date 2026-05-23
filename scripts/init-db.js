require('dotenv').config();
const { getPool } = require('../config/database');

async function initDb() {
  const pool = await getPool();

  console.log('[INIT] Création des tables applicatives...');

  // Géolocalisation clients (complète TIERS sans modifier WaveSoft)
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='EXT_APP_CLIENT_GEO' AND xtype='U')
    CREATE TABLE EXT_APP_CLIENT_GEO (
      TIRID         INT PRIMARY KEY,
      TIRCODE       VARCHAR(50) NOT NULL,
      LATITUDE      DECIMAL(10,7),
      LONGITUDE     DECIMAL(10,7),
      DATE_MODIF    DATETIME DEFAULT GETDATE()
    )
  `);
  console.log('[INIT] EXT_APP_CLIENT_GEO OK');

  // Commandes saisies sur mobile
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='EXT_APP_COMMANDES' AND xtype='U')
    CREATE TABLE EXT_APP_COMMANDES (
      ID            VARCHAR(50) PRIMARY KEY,
      TIRID         INT NOT NULL,
      TIRCODE       VARCHAR(50) NOT NULL,
      CLIENT_NOM    VARCHAR(200) NOT NULL,
      DATE_COMMANDE DATETIME NOT NULL,
      STATUT        VARCHAR(20) NOT NULL DEFAULT 'brouillon',
      COMMENTAIRE   TEXT,
      DATE_SYNC     DATETIME DEFAULT GETDATE(),
      TRAITE        CHAR(1) DEFAULT 'N'
    )
  `);
  console.log('[INIT] EXT_APP_COMMANDES OK');

  // Lignes des commandes
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='EXT_APP_COMMANDES_LIGNES' AND xtype='U')
    CREATE TABLE EXT_APP_COMMANDES_LIGNES (
      ID                  VARCHAR(50) PRIMARY KEY,
      COMMANDE_ID         VARCHAR(50) NOT NULL,
      REFERENCE_ARTICLE   VARCHAR(100) NOT NULL,
      DESIGNATION_ARTICLE VARCHAR(500) NOT NULL,
      QUANTITE            DECIMAL(12,3) NOT NULL,
      NB_COLIS            DECIMAL(10,2),
      PRIX_UNITAIRE       DECIMAL(12,4) NOT NULL,
      REMISE              DECIMAL(6,2) DEFAULT 0,
      FOREIGN KEY (COMMANDE_ID) REFERENCES EXT_APP_COMMANDES(ID)
    )
  `);
  console.log('[INIT] EXT_APP_COMMANDES_LIGNES OK');

  // Relevés de prix concurrents
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='EXT_APP_RELEVE_PRIX' AND xtype='U')
    CREATE TABLE EXT_APP_RELEVE_PRIX (
      ID                  VARCHAR(50) PRIMARY KEY,
      TIRID               INT NOT NULL,
      TIRCODE             VARCHAR(50) NOT NULL,
      CLIENT_NOM          VARCHAR(200) NOT NULL,
      REFERENCE_ARTICLE   VARCHAR(100) NOT NULL,
      DESIGNATION_ARTICLE VARCHAR(500) NOT NULL,
      PRIX_RELEVE         DECIMAL(12,4) NOT NULL,
      MARQUE              VARCHAR(200),
      COMMENTAIRE         TEXT,
      DATE_RELEVE         DATETIME NOT NULL,
      DATE_SYNC           DATETIME DEFAULT GETDATE()
    )
  `);
  console.log('[INIT] EXT_APP_RELEVE_PRIX OK');

  // Photos terrain
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='EXT_APP_PHOTOS' AND xtype='U')
    CREATE TABLE EXT_APP_PHOTOS (
      ID            VARCHAR(50) PRIMARY KEY,
      TIRID         INT,
      TIRCODE       VARCHAR(50),
      CHEMIN        VARCHAR(500) NOT NULL,
      DESCRIPTION   TEXT,
      DATE_PRISE    DATETIME NOT NULL,
      DATE_SYNC     DATETIME DEFAULT GETDATE()
    )
  `);
  console.log('[INIT] EXT_APP_PHOTOS OK');

  console.log('[INIT] Toutes les tables sont prêtes.');
  process.exit(0);
}

initDb().catch(e => { console.error('[INIT] Erreur:', e.message); process.exit(1); });

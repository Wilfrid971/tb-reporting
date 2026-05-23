const express    = require('express');
const router     = express.Router();
const fs         = require('fs');
const path       = require('path');
const nodemailer = require('nodemailer');
const cron       = require('node-cron');
const { getPool, getUserPool, getConnPool, getConnPools, loadConnections, sql } = require('../../config/database');

// Pool actif pour une requête : si la query contient connId (≠ default), bascule sur cette
// connexion ; sinon utilise la base/connexion de l'utilisateur connecté.
const resolveCommercialPool = (req) => {
  // Accepte connId (mono) ou dbs (CSV, on prend la 1ère valeur — rapports mono-base).
  // Permet le DB switching depuis le dashboard qui transmet `dbs` via l'iframe URL.
  let connId = req.query?.connId;
  if (!connId) {
    const dbs = String(req.query?.dbs || '').split(',').map(s => s.trim()).filter(Boolean);
    connId = dbs[0];
  }
  if (connId && connId !== 'default') return getConnPool(connId);
  return getUserPool(req.user);
};

function sumAggRecords(records) {
  const result = {};
  for (const rec of records) {
    if (!rec) continue;
    for (const [k, v] of Object.entries(rec)) result[k] = (result[k] || 0) + (parseFloat(v) || 0);
  }
  return result;
}

const MOIS_COURT = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

function pad(n) { return String(n).padStart(2, '0'); }

// Parse actif param → filtre TIRISACTIF sur le join TIERS commercial
// Valeurs : 'O' actifs (défaut), 'N' inactifs, 'all' ou '' → tous
function parseActif(query) {
  const raw = (query.actif || '').trim();
  if (raw === 'N') return 'N';
  if (raw === 'all' || raw === '') return '';
  return 'O'; // défaut : actifs seulement
}

// ─────────────────────────────────────────────────────────────────────────────
// Formules de calcul (colonnes ligne PIECEVENTELIGNES — pas de V_STATISTIQUE_VENTE)
// Jointure universelle :
//   FROM PIECEVENTELIGNES pl
//   JOIN PIECEVENTES pv ON pv.PCVID=pl.PCVID
//   JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID
//   JOIN ARTICLES a ON a.ARTID=pl.ARTID  (filtre ARTISSTATISTIQUE='O')
// ─────────────────────────────────────────────────────────────────────────────

// Frais totaux ligne (pas de re-somme PLVFRAIS1+2+3 : ces colonnes peuvent être en taux)
const FRAIS_EXPR   = `ISNULL(pl.PLVFRAISTOTAL,0)`;
// Quantité signée (PLVQTE * SENS)
const SIGNED_QTE   = `pl.PLVQTE*pn.PINSENSSTATISTIQUE`;

// Colonnes du sélecteur Prix de Revient (lignes PIECEVENTELIGNES)
const PR_COLS = { PLVLASTPR: 1, PLVPRMP: 1, PLVCRUMP: 1 };
// Colonnes du sélecteur Prix d'Achat (lignes PIECEVENTELIGNES)
const PA_COLS = { PLVLASTPA: 1, PLVPMP: 1, PLVCUMP: 1 };

function resolvePrCol(paramValue) { return PR_COLS[paramValue] ? paramValue : 'PLVCRUMP'; }
function resolvePaCol(paramValue) { return PA_COLS[paramValue] ? paramValue : 'PLVLASTPA'; }

// ── Helpers d'expressions de mesure (à placer dans SUM(CASE WHEN cond THEN <expr> ELSE 0 END)) ──
//    CA = (PLVMNTNETHT - PCVREMISEPIED * PLVMNTNETHT) * SENS
const exprCA       = () => `(pl.PLVMNTNETHT - pv.PCVREMISEPIED*pl.PLVMNTNETHT)*pn.PINSENSSTATISTIQUE`;
const exprQte      = () => `CASE WHEN pn.PINNATURESTOCK='R' THEN ${SIGNED_QTE} ELSE 0 END`;
const exprAchat    = paCol => `pl.${paCol}*${SIGNED_QTE}`;
const exprRevient  = prCol => `pl.${prCol}*${SIGNED_QTE}`;
const exprFrais    = () => FRAIS_EXPR;
const exprAchatAf  = paCol => `(pl.${paCol}+${FRAIS_EXPR})*${SIGNED_QTE}`;
const exprRevientAf= prCol => `(pl.${prCol}+${FRAIS_EXPR})*${SIGNED_QTE}`;
const exprMgSf     = prCol => `${exprCA()} - pl.${prCol}*${SIGNED_QTE}`;
const exprMgAf     = prCol => `${exprCA()} - (pl.${prCol}+${FRAIS_EXPR})*${SIGNED_QTE}`;

// FROM clause universel pour requêtes au niveau ligne
const LINE_FROM = `FROM PIECEVENTELIGNES pl
JOIN PIECEVENTES pv ON pv.PCVID=pl.PCVID
JOIN PIECE_NATURE pn WITH (NOLOCK) ON pn.PINID=pv.PINID
JOIN ARTICLES a WITH (NOLOCK) ON a.ARTID=pl.ARTID`;
const LINE_WHERE_FACT = `pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND a.ARTISSTATISTIQUE='O'`;

// Override de "aujourd'hui" via une chaîne YYYY-MM-DD (utile pour comparer 2 déploiements
// à date figée). Retourne un Date local minuit. Fallback = vraie date du jour.
// (Le nom de query `today` est déjà utilisé dans rapport.html pour masquer la section
// "Aujourd'hui" — d'où le choix d'`asof` côté URL.)
function asofToDate(asof) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(asof || '').trim());
  if (!m) return new Date();
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}
function parseToday(query) { return asofToDate(query?.asof); }

// Format de date utilisateur (settings.json → app.dateFormat). Lu paresseusement.
const _MOIS_COURT_FR = ['jan.','fév.','mar.','avr.','mai','jun.','jul.','aoû.','sep.','oct.','nov.','déc.'];
const _MOIS_LONG_FR  = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
function getServerDateFormat() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/settings.json'), 'utf8'));
    return s?.app?.dateFormat || 'DD/MM/YYYY';
  } catch { return 'DD/MM/YYYY'; }
}
function formatISODate(iso, fmt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return iso;
  const [, y, mo, d] = m, mi = parseInt(mo) - 1;
  switch (fmt || 'DD/MM/YYYY') {
    case 'DD/MM/YY':     return `${d}/${mo}/${y.slice(2)}`;
    case 'DD-MM-YYYY':   return `${d}-${mo}-${y}`;
    case 'YYYY-MM-DD':   return `${y}-${mo}-${d}`;
    case 'DD MMM YYYY':  return `${d} ${_MOIS_COURT_FR[mi]} ${y}`;
    case 'DD MMMM YYYY': return `${d} ${_MOIS_LONG_FR[mi]} ${y}`;
    default:             return `${d}/${mo}/${y}`;
  }
}
// Remplace toutes les dates ISO (YYYY-MM-DD) dans une chaîne par le format utilisateur
function formatDatesInString(str, fmt) {
  if (!str) return str;
  const f = fmt || getServerDateFormat();
  return String(str).replace(/\d{4}-\d{2}-\d{2}/g, d => formatISODate(d, f));
}

// Lit la société TIRTYPE='S' depuis un pool — fallback pour les exports CRON sans req.user
async function fetchSocieteFromPool(pool) {
  if (!pool) return null;
  try {
    const r = await pool.request().query(
      `SELECT TOP 1 RTRIM(TIRSOCIETE) AS societe FROM TIERS WHERE TIRTYPE='S' AND TIRSOCIETE IS NOT NULL`
    );
    return r.recordset[0]?.societe || null;
  } catch { return null; }
}

// Parse repid param : accepte un entier ou une liste CSV (ex: "3,7,12")
function parseRepids(query) {
  const raw = query.repid;
  if (!raw) return { repids: [], repF: '', addRepParams: () => {} };
  const repids = String(raw).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
  if (!repids.length) return { repids: [], repF: '', addRepParams: () => {} };
  const repF = repids.length === 1
    ? 'AND pv.TIRID_REP=@repid0'
    : `AND pv.TIRID_REP IN (${repids.map((_, i) => `@repid${i}`).join(',')})`;
  const addRepParams = r => repids.forEach((id, i) => r.input(`repid${i}`, sql.Int, id));
  return { repids, repF, addRepParams };
}

// Résout la période : retourne dateDebut/dateFin pour N et N-1
function resolvePeriod(q) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;

  if (q.date_debut && q.date_fin) {
    const d0 = q.date_debut, d1 = q.date_fin;
    const [y0, m0, j0] = d0.split('-').map(Number);
    const [y1, m1, j1] = d1.split('-').map(Number);
    return {
      dateDebut: d0, dateFin: d1,
      dateDebutN1: `${y0-1}-${pad(m0)}-${pad(j0)}`,
      dateFinN1:   `${y1-1}-${pad(m1)}-${pad(j1)}`,
      periodeLabel: `${d0} → ${d1}`,
      n1Label: `${y0-1}-${pad(m0)}-${pad(j0)} → ${y1-1}-${pad(m1)}-${pad(j1)}`,
      mode: 'range',
    };
  }

  // Exercice fiscal complet : annee=exe:YYYY-MM-DD:YYYY-MM-DD
  if (q.annee && String(q.annee).startsWith('exe:')) {
    const [, d0, d1] = String(q.annee).split(':');
    const [y0, m0, j0] = d0.split('-').map(Number);
    const [y1, m1, j1] = d1.split('-').map(Number);
    return {
      dateDebut: d0, dateFin: d1,
      dateDebutN1: `${y0-1}-${pad(m0)}-${pad(j0)}`,
      dateFinN1:   `${y1-1}-${pad(m1)}-${pad(j1)}`,
      periodeLabel: `Exercice ${d0} → ${d1}`,
      n1Label: `Exercice ${y0-1}-${pad(m0)}-${pad(j0)} → ${y1-1}-${pad(m1)}-${pad(j1)}`,
      mode: 'exe',
    };
  }

  // YTD exercice fiscal : annee=ytd_exe:YYYY-MM-DD:YYYY-MM-DD — de début exercice à aujourd'hui
  if (q.annee && String(q.annee).startsWith('ytd_exe:')) {
    const [, d0] = String(q.annee).split(':');
    const [y0, m0, j0] = d0.split('-').map(Number);
    const [yT, mT, jT] = todayStr.split('-').map(Number);
    return {
      dateDebut: d0, dateFin: todayStr,
      dateDebutN1: `${y0-1}-${pad(m0)}-${pad(j0)}`,
      dateFinN1:   `${yT-1}-${pad(mT)}-${pad(jT)}`,
      periodeLabel: `Exercice YTD ${d0} → ${todayStr}`,
      n1Label: `Exercice YTD ${y0-1}-${pad(m0)}-${pad(j0)} → ${yT-1}-${pad(mT)}-${pad(jT)}`,
      mode: 'ytd_exe',
    };
  }

  const annee   = parseInt(q.annee) || today.getFullYear();
  const anneeN1 = annee - 1;
  const mois    = q.mois ? parseInt(q.mois) : null;

  if (mois) {
    const lastDay   = new Date(annee,   mois, 0).getDate();
    const lastDayN1 = new Date(anneeN1, mois, 0).getDate();
    return {
      dateDebut:   `${annee}-${pad(mois)}-01`,
      dateFin:     `${annee}-${pad(mois)}-${pad(lastDay)}`,
      dateDebutN1: `${anneeN1}-${pad(mois)}-01`,
      dateFinN1:   `${anneeN1}-${pad(mois)}-${pad(lastDayN1)}`,
      periodeLabel: `${MOIS_COURT[mois-1]} ${annee}`,
      n1Label:      `${MOIS_COURT[mois-1]} ${anneeN1}`,
      annee, anneeN1, mois, mode: 'month',
    };
  }

  return {
    dateDebut:   `${annee}-01-01`, dateFin:   `${annee}-12-31`,
    dateDebutN1: `${anneeN1}-01-01`, dateFinN1: `${anneeN1}-12-31`,
    periodeLabel: String(annee), n1Label: String(anneeN1),
    annee, anneeN1, mode: 'year',
  };
}

// Liste des mois (year,month) entre deux dates ISO
function monthsInRange(dateDebut, dateFin) {
  const months = [];
  let d = new Date(dateDebut + 'T00:00:00');
  const end = new Date(dateFin + 'T00:00:00');
  while (d <= end) {
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  return months;
}

// Filtres : commerciaux + années calendaires + exercices fiscaux
router.get('/filters', async (req, res) => {
  try {
    // Limites configurées dans settings (onglet Apparence)
    const settingsFile = path.join(__dirname, '../../data/settings.json');
    let nbExercices = 5, nbAnneesCal = 5;
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (Number.isInteger(s?.periodes?.nbExercices) && s.periodes.nbExercices > 0) nbExercices = s.periodes.nbExercices;
      if (Number.isInteger(s?.periodes?.nbAnneesCal) && s.periodes.nbAnneesCal > 0) nbAnneesCal = s.periodes.nbAnneesCal;
    } catch {}

    const pool = await resolveCommercialPool(req);
    const [reps, annees] = await Promise.all([
      pool.request().query(`
        SELECT TIRID, RTRIM(TIRSOCIETE) AS nom, TIRISACTIF
        FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R'${(() => { const a = parseActif(req.query); return a ? ` AND TIRISACTIF='${a}'` : ''; })()}
        ORDER BY TIRSOCIETE
      `),
      pool.request().query(`
        SELECT DISTINCT YEAR(pv.PCVDATEEFFET) AS annee
        FROM PIECEVENTES pv
        JOIN PIECE_NATURE pn WITH (NOLOCK) ON pn.PINID=pv.PINID
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0
        ORDER BY annee DESC
      `)
    ]);

    let exercices = [];
    try {
      const exeRes = await pool.request().query(`
        SELECT EXEID,
               YEAR(EXEDATEDEB) AS annee_debut,
               YEAR(EXEDATEFIN) AS annee_fin,
               CONVERT(varchar(10), EXEDATEDEB, 120) AS date_debut,
               CONVERT(varchar(10), EXEDATEFIN, 120) AS date_fin,
               RTRIM(ISNULL(EXEINTITULE, CAST(YEAR(EXEDATEDEB) AS varchar(10)))) AS libelle,
               EXEETAT
        FROM EXERCICES WITH (NOLOCK)
        ORDER BY EXEDATEDEB DESC
      `);
      exercices = exeRes.recordset;
    } catch (e) {
      console.warn('[EXERCICES]', e.message);
    }

    const dbName = (await pool.request().query('SELECT DB_NAME() AS db')).recordset[0].db;
    res.json({
      commerciaux: reps.recordset,
      annees: annees.recordset.map(r => r.annee).slice(0, nbAnneesCal),
      exercices: exercices.slice(0, nbExercices),
      defaultDb: { id: 'default', label: dbName },
      connections: loadConnections().map(c => ({ id: c.id, label: c.label })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KPIs agrégés
router.get('/kpis', async (req, res) => {
  const p = resolvePeriod(req.query);
  const { repF, addRepParams } = parseRepids(req.query);
  const actif = parseActif(req.query);
  const actifF = actif
    ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${actif}')`
    : '';
  try {
    const pools = await getConnPools(req.query.dbs, req.user);
    const SQL = `
      SELECT
        SUM(CASE WHEN pv.PCVDATEEFFET >= @dateDebut   AND pv.PCVDATEEFFET <= @dateFin   THEN ${exprCA()} ELSE 0 END) AS ca_periode,
        SUM(CASE WHEN pv.PCVDATEEFFET >= @dateDebutN1 AND pv.PCVDATEEFFET <= @dateFinN1 THEN ${exprCA()} ELSE 0 END) AS ca_n1,
        COUNT(DISTINCT CASE WHEN pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin AND pn.PINSENSSTATISTIQUE=1 THEN pv.PCVID END) AS nb_factures,
        COUNT(DISTINCT CASE WHEN pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin AND pn.PINSENSSTATISTIQUE=1 THEN pv.TIRID END) AS nb_clients
      ${LINE_FROM}
      WHERE ${LINE_WHERE_FACT} ${repF} ${actifF}
        AND (
          (pv.PCVDATEEFFET >= @dateDebut   AND pv.PCVDATEEFFET <= @dateFin)
          OR (pv.PCVDATEEFFET >= @dateDebutN1 AND pv.PCVDATEEFFET <= @dateFinN1)
        )
    `;
    const results = await Promise.all(pools.map(({ pool }) => {
      const r = pool.request();
      r.input('dateDebut',   sql.VarChar(10), p.dateDebut);
      r.input('dateFin',     sql.VarChar(10), p.dateFin);
      r.input('dateDebutN1', sql.VarChar(10), p.dateDebutN1);
      r.input('dateFinN1',   sql.VarChar(10), p.dateFinN1);
      addRepParams(r);
      return r.query(SQL);
    }));
    const agg = sumAggRecords(results.map(r => r.recordset[0]));
    res.json({ ...agg, periodeLabel: p.periodeLabel, n1Label: p.n1Label });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Évolution mensuelle CA net
router.get('/mensuel', async (req, res) => {
  const p = resolvePeriod(req.query);
  const { repids, repF, addRepParams } = parseRepids(req.query);
  const actif = parseActif(req.query);
  const actifF = actif
    ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${actif}')`
    : '';
  try {
    const pools = await getConnPools(req.query.dbs, req.user?.database);
    const SQL = `
      SELECT YEAR(pv.PCVDATEEFFET) AS annee, MONTH(pv.PCVDATEEFFET) AS mois,
             SUM(${exprCA()}) AS ca,
             CASE WHEN pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin THEN 'n' ELSE 'n1' END AS periode
      ${LINE_FROM}
      WHERE ${LINE_WHERE_FACT} ${repF} ${actifF}
        AND (
          (pv.PCVDATEEFFET >= @dateDebut   AND pv.PCVDATEEFFET <= @dateFin)
          OR (pv.PCVDATEEFFET >= @dateDebutN1 AND pv.PCVDATEEFFET <= @dateFinN1)
        )
      GROUP BY YEAR(pv.PCVDATEEFFET), MONTH(pv.PCVDATEEFFET),
               CASE WHEN pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin THEN 'n' ELSE 'n1' END
      ORDER BY annee, mois`;
    const results = await Promise.all(pools.map(({ pool }) => {
      const r = pool.request();
      r.input('dateDebut',   sql.VarChar(10), p.dateDebut);
      r.input('dateFin',     sql.VarChar(10), p.dateFin);
      r.input('dateDebutN1', sql.VarChar(10), p.dateDebutN1);
      r.input('dateFinN1',   sql.VarChar(10), p.dateFinN1);
      addRepParams(r);
      return r.query(SQL);
    }));

    // Map résultats SQL par (annee, mois, periode) — agrégé sur toutes les connexions
    const map = {};
    for (const result of results) {
      for (const row of result.recordset) {
        const key = `${row.periode}-${row.annee}-${row.mois}`;
        map[key] = (map[key] || 0) + (parseFloat(row.ca) || 0);
      }
    }

    // Construire les mois de la période N
    const monthList = monthsInRange(p.dateDebut, p.dateFin);
    const monthListN1 = monthsInRange(p.dateDebutN1, p.dateFinN1);

    const months = monthList.map((m, i) => {
      const m1 = monthListN1[i] || { year: m.year - 1, month: m.month };
      const showYear = monthList.some(x => x.year !== m.year) || monthList.length > 12;
      return {
        label: showYear
          ? `${MOIS_COURT[m.month-1]} ${m.year}`
          : MOIS_COURT[m.month-1],
        n:  map[`n-${m.year}-${m.month}`]   || 0,
        n1: map[`n1-${m1.year}-${m1.month}`] || 0,
      };
    });

    res.json({ periodeLabel: p.periodeLabel, n1Label: p.n1Label, months });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top N clients
router.get('/top-clients', async (req, res) => {
  const p = resolvePeriod(req.query);
  const { repF, addRepParams } = parseRepids(req.query);
  const actif = parseActif(req.query);
  const actifF = actif
    ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${actif}')`
    : '';
  const limit = Math.min(parseInt(req.query.limit) || 10, 20);
  try {
    const pools = await getConnPools(req.query.dbs, req.user);
    const SQL = `
      SELECT
        RTRIM(t.TIRSOCIETE) AS label,
        SUM(${exprCA()}) AS valeur
      ${LINE_FROM}
      JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID
      WHERE ${LINE_WHERE_FACT}
        AND pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin ${repF} ${actifF}
      GROUP BY t.TIRID, t.TIRSOCIETE
    `;
    const results = await Promise.all(pools.map(({ pool }) => {
      const r = pool.request();
      r.input('dateDebut', sql.VarChar(10), p.dateDebut);
      r.input('dateFin',   sql.VarChar(10), p.dateFin);
      addRepParams(r);
      return r.query(SQL);
    }));
    // Agrège par label à travers les bases puis trie + TOP N
    const map = new Map();
    for (const result of results) {
      for (const row of result.recordset) {
        const k = row.label;
        map.set(k, (map.get(k) || 0) + (parseFloat(row.valeur) || 0));
      }
    }
    const merged = [...map.entries()].map(([label, valeur]) => ({ label, valeur })).sort((a, b) => b.valeur - a.valeur).slice(0, limit);
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CA net par commercial
router.get('/par-commercial', async (req, res) => {
  const p = resolvePeriod(req.query);
  const { repF, addRepParams } = parseRepids(req.query);
  const actif = parseActif(req.query);
  // Ici le filtre actif s'applique directement sur le commercial (TIRTYPE='R')
  const actifF = actif ? `AND t.TIRISACTIF='${actif}'` : '';
  try {
    const pools = await getConnPools(req.query.dbs, req.user);
    const SQL = `
      SELECT
        ISNULL(RTRIM(t.TIRSOCIETE), 'Non assigné') AS label,
        SUM(${exprCA()}) AS valeur
      ${LINE_FROM}
      LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID_REP AND t.TIRTYPE='R' ${actifF}
      WHERE ${LINE_WHERE_FACT} ${repF}
        AND pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin
      GROUP BY t.TIRID, t.TIRSOCIETE
    `;
    const results = await Promise.all(pools.map(({ pool }) => {
      const r = pool.request();
      r.input('dateDebut', sql.VarChar(10), p.dateDebut);
      r.input('dateFin',   sql.VarChar(10), p.dateFin);
      addRepParams(r);
      return r.query(SQL);
    }));
    const map = new Map();
    for (const result of results) {
      for (const row of result.recordset) {
        const k = row.label;
        map.set(k, (map.get(k) || 0) + (parseFloat(row.valeur) || 0));
      }
    }
    const merged = [...map.entries()].map(([label, valeur]) => ({ label, valeur })).sort((a, b) => b.valeur - a.valeur);
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helpers Règlement clients
// CA        : depuis PIECEVENTELIGNES (cohérent avec rapport_ca / rapport_commerciaux)
// Créances  : solde compte 411 par client à @dateFin, cumul depuis le début de l'exercice en cours
// DSO       : créances × nb_jours_période / CA
// Début de l'exercice "en cours" Wavesoft (EXEETAT='EC').
// Utilisé pour le solde 411 — l'encours se cumule depuis ce point quel que soit
// la période demandée par l'utilisateur.
async function getExeStart(pool, refDate) {
  try {
    const r = await pool.request().query(`
      SELECT TOP 1 CONVERT(varchar(10), EXEDATEDEB, 120) AS d0
      FROM EXERCICES WITH (NOLOCK)
      WHERE EXEETAT='EC'
      ORDER BY EXEDATEDEB DESC
    `);
    if (r.recordset[0]?.d0) return r.recordset[0].d0;
  } catch { /* fallback ci-dessous */ }
  return `${refDate.slice(0, 4)}-01-01`;
}

// CA règlement : 12 mois glissants finissant aujourd'hui (ou asof si fourni),
// indépendant de la période demandée par l'utilisateur. Le solde 411, lui,
// reste à `p.dateFin` (période choisie par l'utilisateur).
function caRolling12Months(query) {
  const fin = asofToDate(query?.asof);
  const deb = new Date(fin); deb.setMonth(deb.getMonth() - 12);
  const pad2 = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  return { caDebut: fmt(deb), caFin: fmt(fin) };
}

// Sous-requête "facturé TTC par client" pour le DSO. On agrège au niveau pièce
// (PIECEVENTES) avec PCVMNTTTC × PINSENSSTATISTIQUE pour PITCODE='F' — cohérent
// avec les créances 411 qui sont en TTC. (Avant : SUM HT au niveau lignes →
// numérateur TTC / dénominateur HT → DSO biaisé d'environ +20%.)
const CA_BY_TIRID_SUBQUERY = `
  SELECT pv.TIRID,
         SUM(ABS(pv.PCVMNTTTC) * pn.PINSENSSTATISTIQUE) AS ca,
         MIN(pv.PCVDATEEFFET) AS firstDate
  FROM PIECEVENTES pv WITH (NOLOCK)
  JOIN PIECE_NATURE pn WITH (NOLOCK) ON pn.PINID = pv.PINID
  WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0
    AND pv.PCVDATEEFFET >= @caDebut AND pv.PCVDATEEFFET <= @caFin
  GROUP BY pv.TIRID`;

// Période d'activité réelle du client = DATEDIFF(1ère facture dans la fenêtre → caFin),
// avec un plancher de 30 j pour éviter qu'un client venant de facturer ne sorte un DSO
// quasi-nul (sa facture n'est pas encore due). Référence aux alias `ca.firstDate` et
// `@caFin`, donc à n'utiliser que dans les requêtes qui joignent CA_BY_TIRID_SUBQUERY.
const ACTIVE_DAYS_EXPR = `(CASE WHEN DATEDIFF(day, ca.firstDate, @caFin) < 30 THEN 30 ELSE DATEDIFF(day, ca.firstDate, @caFin) END)`;
// Facturé TTC quotidien moyen par client (€/jour). Utilisé pour agréger un DSO par commercial.
const DAILY_SALES_EXPR = `(ca.ca * 1.0 / ${ACTIVE_DAYS_EXPR})`;
// DSO d'un client : encours TTC × jours actifs / facturé TTC. Renvoie 0 si pas de facturé.
const DSO_PER_CLIENT_EXPR = `CASE WHEN ISNULL(ca.ca, 0) > 0 THEN CAST(ISNULL(en.encours, 0) * ${ACTIVE_DAYS_EXPR} * 1.0 / ca.ca AS DECIMAL(10,1)) ELSE 0 END`;
// DSO agrégé sur un groupe (commercial) : SUM(encours) / SUM(facturé TTC quotidien par client)
const DSO_AGG_EXPR = `CASE WHEN SUM(${DAILY_SALES_EXPR}) > 0 THEN CAST(SUM(ISNULL(en.encours, 0)) * 1.0 / SUM(${DAILY_SALES_EXPR}) AS DECIMAL(10,1)) ELSE 0 END`;

// Sous-requête créances par CPTID : solde 411 = cumul SUM(ECRDEBIT-ECRCREDIT) sur
// l'exercice en cours (EXEETAT='EC'), à @dateFin.
const ENCOURS_BY_CPTID_SUBQUERY = `
  SELECT ecr.CPTID, SUM(ISNULL(ecr.ECRDEBIT, 0) - ISNULL(ecr.ECRCREDIT, 0)) AS encours
  FROM ECRITURES ecr WITH (NOLOCK)
  JOIN COMPTES cpt WITH (NOLOCK) ON cpt.CPTID = ecr.CPTID
  WHERE cpt.CPTCODE LIKE '411%'
    AND ecr.ECRDATEEFFET >= @exeStart
    AND ecr.ECRDATEEFFET <= @dateFin
  GROUP BY ecr.CPTID`;

// DSO clients : facturé TTC (PIECEVENTES sur la période) + créances (solde 411 sur l'exercice en cours à dateFin)
// ?repid=XXX, ?order=asc|desc (asc = bons payeurs DSO bas), ?actif=0|1
// ?minRatio / ?maxRatio : tranche de DSO en jours (ex. moyens payeurs : minRatio=30&maxRatio=60)
router.get('/reglement-clients', async (req, res) => {
  const p = resolvePeriod(req.query);
  const ca = caRolling12Months(req.query);
  const limit = Math.min(parseInt(req.query.limit) || 20, 500);
  const repid = req.query.repid ? parseInt(req.query.repid) : null;
  const order = String(req.query.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const sort  = String(req.query.sort  || 'ratio').toLowerCase() === 'encours' ? 'encours' : 'ratio';
  const actif = parseActif(req.query);
  const minRatio = req.query.minRatio != null && req.query.minRatio !== '' ? parseFloat(req.query.minRatio) : null;
  const maxRatio = req.query.maxRatio != null && req.query.maxRatio !== '' ? parseFloat(req.query.maxRatio) : null;
  let exeStart;
  try {
    const pool = await resolveCommercialPool(req);
    exeStart = await getExeStart(pool, p.dateFin);
    const r = pool.request();
    r.input('caDebut',  sql.VarChar(10), ca.caDebut);
    r.input('caFin',    sql.VarChar(10), ca.caFin);
    r.input('dateFin',  sql.VarChar(10), p.dateFin);
    r.input('exeStart', sql.VarChar(10), exeStart);
    if (repid) r.input('repid', sql.Int, repid);
    if (minRatio != null && Number.isFinite(minRatio)) r.input('minRatio', sql.Decimal(10,1), minRatio);
    if (maxRatio != null && Number.isFinite(maxRatio)) r.input('maxRatio', sql.Decimal(10,1), maxRatio);
    const repF = repid ? 'AND ter.REPID=@repid' : '';
    // Le filtre "Commerciaux actifs" ne doit PAS exclure un client sans commercial
    // assigné (REPID NULL/0) — il n'a ni actif ni inactif. On garde aussi ces clients.
    // Le filtre "Commerciaux actifs" ne doit pas exclure un client sans commercial.
    // 3 cas valides : REPID NULL, REPID qui ne pointe sur aucun commercial réel
    // (sentinelle 0 ou orphelin), ou REPID lié à un commercial actif/inactif selon filtre.
    const actifF = actif
      ? `AND (ter.REPID IS NULL
              OR NOT EXISTS (SELECT 1 FROM TIERS rep WITH (NOLOCK) WHERE rep.TIRID=ter.REPID AND rep.TIRTYPE='R')
              OR EXISTS     (SELECT 1 FROM TIERS rep WITH (NOLOCK) WHERE rep.TIRID=ter.REPID AND rep.TIRTYPE='R' AND rep.TIRISACTIF='${actif}'))`
      : '';
    const minF = (minRatio != null && Number.isFinite(minRatio)) ? 'AND ratio > @minRatio' : '';
    const maxF = (maxRatio != null && Number.isFinite(maxRatio)) ? 'AND ratio <= @maxRatio' : '';
    const result = await r.query(`
      SELECT TOP ${limit} TIRID, label, facture, regle, encours, ratio, ratio AS dso
      FROM (
        SELECT
          ter.TIRID,
          RTRIM(ter.TIRSOCIETE) AS label,
          ISNULL(ca.ca, 0)      AS facture,
          0                     AS regle,
          ISNULL(en.encours, 0) AS encours,
          ${DSO_PER_CLIENT_EXPR} AS ratio
        FROM TIERS ter WITH (NOLOCK)
        LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
        LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
        WHERE ter.TIRTYPE = 'C'
          AND ISNULL(ca.ca, 0) > 0
          ${repF}
          ${actifF}
      ) x
      WHERE 1=1 ${minF} ${maxF}
      ORDER BY ${sort} ${order}
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('[reglement-clients] SQL error:', err.message, '| params:', { caDebut: ca.caDebut, caFin: ca.caFin, dateFin: p.dateFin, exeStart, actif, repid, minRatio, maxRatio });
    res.status(500).json({ error: err.message, endpoint: 'reglement-clients' });
  }
});

// Ratio règlement par commercial (agrégé sur tous ses clients)
// ?actif=0|1 pour filtrer sur les commerciaux actifs/inactifs
router.get('/reglement-commerciaux', async (req, res) => {
  const p = resolvePeriod(req.query);
  const ca = caRolling12Months(req.query);
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const actif = parseActif(req.query);
  let exeStart;
  try {
    const pool = await resolveCommercialPool(req);
    exeStart = await getExeStart(pool, p.dateFin);
    const r = pool.request();
    r.input('caDebut',  sql.VarChar(10), ca.caDebut);
    r.input('caFin',    sql.VarChar(10), ca.caFin);
    r.input('dateFin',  sql.VarChar(10), p.dateFin);
    r.input('exeStart', sql.VarChar(10), exeStart);
    const actifF = actif ? `AND rep.TIRISACTIF='${actif}'` : '';
    const result = await r.query(`
      SELECT TOP ${limit}
        rep.TIRID,
        RTRIM(rep.TIRSOCIETE) AS label,
        COUNT(DISTINCT ter.TIRID) AS nb_clients,
        ISNULL(SUM(ca.ca), 0)      AS facture,
        0                          AS regle,
        ISNULL(SUM(en.encours), 0) AS encours,
        ${DSO_AGG_EXPR} AS ratio,
        ${DSO_AGG_EXPR} AS dso
      FROM TIERS rep WITH (NOLOCK)
      JOIN TIERS ter WITH (NOLOCK) ON ter.REPID = rep.TIRID AND ter.TIRTYPE = 'C'
      LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
      LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
      WHERE rep.TIRTYPE = 'R'
        ${actifF}
      GROUP BY rep.TIRID, rep.TIRSOCIETE
      HAVING ISNULL(SUM(ca.ca), 0) > 0
      ORDER BY ratio ASC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('[reglement-commerciaux] SQL error:', err.message, '| params:', { caDebut: ca.caDebut, caFin: ca.caFin, dateFin: p.dateFin, exeStart, actif });
    res.status(500).json({ error: err.message, endpoint: 'reglement-commerciaux' });
  }
});

// KPIs globaux règlement (ratio général, encours total, DSO moyen pondéré)
router.get('/reglement-summary', async (req, res) => {
  const p = resolvePeriod(req.query);
  const ca = caRolling12Months(req.query);
  const actif = parseActif(req.query);
  let exeStart;
  try {
    const pool = await resolveCommercialPool(req);
    exeStart = await getExeStart(pool, p.dateFin);
    const r = pool.request();
    r.input('caDebut',  sql.VarChar(10), ca.caDebut);
    r.input('caFin',    sql.VarChar(10), ca.caFin);
    r.input('dateFin',  sql.VarChar(10), p.dateFin);
    r.input('exeStart', sql.VarChar(10), exeStart);
    // Le filtre "Commerciaux actifs" ne doit pas exclure un client sans commercial.
    // 3 cas valides : REPID NULL, REPID qui ne pointe sur aucun commercial réel
    // (sentinelle 0 ou orphelin), ou REPID lié à un commercial actif/inactif selon filtre.
    const actifF = actif
      ? `AND (ter.REPID IS NULL
              OR NOT EXISTS (SELECT 1 FROM TIERS rep WITH (NOLOCK) WHERE rep.TIRID=ter.REPID AND rep.TIRTYPE='R')
              OR EXISTS     (SELECT 1 FROM TIERS rep WITH (NOLOCK) WHERE rep.TIRID=ter.REPID AND rep.TIRTYPE='R' AND rep.TIRISACTIF='${actif}'))`
      : '';
    const result = await r.query(`
      SELECT
        ISNULL(SUM(ca.ca), 0)            AS facture,
        ISNULL(SUM(en.encours), 0)       AS encours,
        ISNULL(SUM(${DAILY_SALES_EXPR}), 0) AS dailySales,
        COUNT(DISTINCT ter.TIRID)        AS nb_clients,
        COUNT(DISTINCT ter.REPID)        AS nb_commerciaux
      FROM TIERS ter WITH (NOLOCK)
      LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
      LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
      WHERE ter.TIRTYPE = 'C'
        AND ISNULL(ca.ca, 0) > 0
        ${actifF}
    `);
    const row = result.recordset[0] || {};
    const facture     = parseFloat(row.facture) || 0;
    const encours     = parseFloat(row.encours) || 0;
    const dailySales  = parseFloat(row.dailySales) || 0;
    // DSO global = SUM(encours) / SUM(CA quotidien par client) → cohérent avec le DSO par client
    // (chaque client est ramené à sa propre période d'activité réelle)
    const dso = dailySales > 0 ? (encours / dailySales) : 0;
    res.json({
      facture, regle: 0, encours, ratio: dso, dso,
      nb_clients: row.nb_clients || 0, nb_commerciaux: row.nb_commerciaux || 0,
      caDebut: ca.caDebut, caFin: ca.caFin, dateFin: p.dateFin, exeStart,
    });
  } catch (err) {
    console.error('[reglement-summary] SQL error:', err.message, '| params:', { caDebut: ca.caDebut, caFin: ca.caFin, dateFin: p.dateFin, exeStart, actif });
    res.status(500).json({ error: err.message, endpoint: 'reglement-summary' });
  }
});

// Debug règlement : ce que voit l'API pour un compte 411 donné.
// Usage : GET /reglement-debug?cptcode=411IMG000
router.get('/reglement-debug', async (req, res) => {
  const cptcode = String(req.query.cptcode || '').trim();
  if (!cptcode) return res.status(400).json({ error: 'cptcode requis' });
  const p = resolvePeriod(req.query);
  const ca = caRolling12Months(req.query);
  try {
    const pool = await resolveCommercialPool(req);
    const exeStart = await getExeStart(pool, p.dateFin);

    const cptR = await pool.request()
      .input('cptcode', sql.VarChar(20), cptcode)
      .query(`SELECT TOP 1 CPTID, RTRIM(CPTCODE) AS CPTCODE, RTRIM(CPTINTITULE) AS intitule FROM COMPTES WITH (NOLOCK) WHERE CPTCODE=@cptcode`);
    if (!cptR.recordset.length) return res.json({ error: `Compte ${cptcode} introuvable`, cptcode });
    const cptid = cptR.recordset[0].CPTID;

    const tiersR = await pool.request().input('cptid', sql.Int, cptid).query(`
      SELECT TIRID, TIRTYPE, RTRIM(TIRSOCIETE) AS societe, TIRISACTIF, REPID, CPTID
      FROM TIERS WITH (NOLOCK) WHERE CPTID=@cptid`);

    const encR = await pool.request()
      .input('cptid',    sql.Int,       cptid)
      .input('exeStart', sql.VarChar(10), exeStart)
      .input('dateFin',  sql.VarChar(10), p.dateFin)
      .query(`
        SELECT SUM(ISNULL(ECRDEBIT,0) - ISNULL(ECRCREDIT,0)) AS encours,
               COUNT(*) AS nb_ecritures,
               MIN(CONVERT(varchar(10), ECRDATEEFFET, 120)) AS premiere,
               MAX(CONVERT(varchar(10), ECRDATEEFFET, 120)) AS derniere
        FROM ECRITURES WITH (NOLOCK)
        WHERE CPTID=@cptid AND ECRDATEEFFET >= @exeStart AND ECRDATEEFFET <= @dateFin`);

    const caR = await pool.request()
      .input('cptid',   sql.Int,       cptid)
      .input('caDebut', sql.VarChar(10), ca.caDebut)
      .input('caFin',   sql.VarChar(10), ca.caFin)
      .query(`
        SELECT pv.TIRID, t.TIRTYPE, RTRIM(t.TIRSOCIETE) AS societe,
               COUNT(DISTINCT pv.PCVID) AS nb_pieces,
               SUM((pl.PLVMNTNETHT - pv.PCVREMISEPIED*pl.PLVMNTNETHT)*pn.PINSENSSTATISTIQUE) AS ca
        FROM PIECEVENTELIGNES pl
        JOIN PIECEVENTES   pv ON pv.PCVID=pl.PCVID
        JOIN PIECE_NATURE  pn WITH (NOLOCK) ON pn.PINID=pv.PINID
        JOIN TIERS         t  WITH (NOLOCK) ON t.TIRID=pv.TIRID
        WHERE t.CPTID=@cptid
          AND pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0
          AND pv.PCVDATEEFFET >= @caDebut AND pv.PCVDATEEFFET <= @caFin
        GROUP BY pv.TIRID, t.TIRTYPE, t.TIRSOCIETE`);

    res.json({
      cptcode, cptid, intitule: cptR.recordset[0].intitule,
      window: { caDebut: ca.caDebut, caFin: ca.caFin, exeStart, dateFin: p.dateFin },
      tiers_lies: tiersR.recordset,
      encours: encR.recordset[0],
      ca_par_tirid: caR.recordset,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top N familles articles
router.get('/top-familles', async (req, res) => {
  const p = resolvePeriod(req.query);
  const { repF, addRepParams } = parseRepids(req.query);
  const actif = parseActif(req.query);
  const actifF = actif
    ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${actif}')`
    : '';
  const limit = Math.min(parseInt(req.query.limit) || 10, 20);
  try {
    const pools = await getConnPools(req.query.dbs, req.user);
    const SQL = `
      SELECT
        ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille') AS label,
        SUM(${exprCA()}) AS valeur
      ${LINE_FROM}
      LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID
      WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL ${repF} ${actifF}
        AND pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin
      GROUP BY af.AFMID, af.AFMINTITULE
    `;
    const results = await Promise.all(pools.map(({ pool }) => {
      const r = pool.request();
      r.input('dateDebut', sql.VarChar(10), p.dateDebut);
      r.input('dateFin',   sql.VarChar(10), p.dateFin);
      addRepParams(r);
      return r.query(SQL);
    }));
    const map = new Map();
    for (const result of results) {
      for (const row of result.recordset) {
        const k = row.label;
        map.set(k, (map.get(k) || 0) + (parseFloat(row.valeur) || 0));
      }
    }
    const merged = [...map.entries()].map(([label, valeur]) => ({ label, valeur })).sort((a, b) => b.valeur - a.valeur).slice(0, limit);
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const CLIENT_DIMS  = new Set(['TIRCATEGORIE','TIRACTIVITE','TIRGEO','TIRBRANCHE','TIRENSEIGNE','TIRORIGINE','TIRCIBLE1','TIRCIBLE2']);
const ARTICLE_DIMS = new Set(['ARTFAMILLE','ARTSOUSFAMILLE','ARTCATEGORIE','ARTNATURE','ARTCOLLECTION','ARTMARQUE','ARTCLASSE']);

// Segmentation clients par dimension
router.get('/segmentation-clients', async (req, res) => {
  const dim = req.query.dim || 'TIRCATEGORIE';
  if (!CLIENT_DIMS.has(dim)) return res.status(400).json({ error: 'Dimension invalide' });
  const p = resolvePeriod(req.query);
  const actifLine = (() => {
    const a = parseActif(req.query);
    return a ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${a}')` : '';
  })();
  try {
    const pool = await resolveCommercialPool(req);
    const r = pool.request();
    r.input('dateDebut', sql.VarChar(10), p.dateDebut);
    r.input('dateFin',   sql.VarChar(10), p.dateFin);
    const result = await r.query(`
      SELECT ISNULL(RTRIM(t.${dim}), 'Non défini') AS label,
             SUM(${exprCA()}) AS valeur
      ${LINE_FROM}
      JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID
      WHERE ${LINE_WHERE_FACT} AND t.TIRTYPE='C'
        AND pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin ${actifLine}
      GROUP BY t.${dim}
      ORDER BY valeur DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Segmentation clients × commercial
router.get('/segmentation-clients-par-rep', async (req, res) => {
  const dim = req.query.dim || 'TIRCATEGORIE';
  if (!CLIENT_DIMS.has(dim)) return res.status(400).json({ error: 'Dimension invalide' });
  const p = resolvePeriod(req.query);
  const { repF, addRepParams } = parseRepids(req.query);
  // Filtre actif STRICT sur la ligne (cohérent avec /mensuel et /kpis) : exclut les
  // lignes dont le commercial ne correspond pas. Sinon le LEFT JOIN se contentait
  // de renommer les reps filtrés en "Non assigné", la conso restait quasi identique.
  const actifLine = (() => {
    const a = parseActif(req.query);
    return a ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${a}')` : '';
  })();
  try {
    const pool = await resolveCommercialPool(req);
    const r = pool.request();
    r.input('dateDebut', sql.VarChar(10), p.dateDebut);
    r.input('dateFin',   sql.VarChar(10), p.dateFin);
    addRepParams(r);
    const result = await r.query(`
      SELECT ISNULL(RTRIM(tr.TIRSOCIETE), 'Non assigné') AS rep,
             ISNULL(RTRIM(t.${dim}), 'Non défini') AS segment,
             SUM(${exprCA()}) AS valeur
      ${LINE_FROM}
      JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID
      LEFT JOIN TIERS tr WITH (NOLOCK) ON tr.TIRID=pv.TIRID_REP AND tr.TIRTYPE='R'
      WHERE ${LINE_WHERE_FACT} AND t.TIRTYPE='C'
        AND pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin ${repF} ${actifLine}
      GROUP BY tr.TIRID, tr.TIRSOCIETE, t.${dim}
      ORDER BY rep, valeur DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Segmentation articles par dimension
router.get('/segmentation-articles', async (req, res) => {
  const dim = req.query.dim || 'ARTFAMILLE';
  if (!ARTICLE_DIMS.has(dim)) return res.status(400).json({ error: 'Dimension invalide' });
  const p = resolvePeriod(req.query);
  const actifLine = (() => {
    const a = parseActif(req.query);
    return a ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${a}')` : '';
  })();
  try {
    const pool = await resolveCommercialPool(req);
    const r = pool.request();
    r.input('dateDebut', sql.VarChar(10), p.dateDebut);
    r.input('dateFin',   sql.VarChar(10), p.dateFin);
    const labelExpr = dim === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.${dim}), 'Non défini')`;
    const joinFam   = dim === 'ARTFAMILLE' ? `LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID` : '';
    const groupBy   = dim === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.${dim}`;
    const result = await r.query(`
      SELECT ${labelExpr} AS label,
             SUM(${exprCA()}) AS valeur
      ${LINE_FROM}
      ${joinFam}
      WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL
        AND pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin ${actifLine}
      GROUP BY ${groupBy}
      ORDER BY valeur DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Segmentation articles × commercial
router.get('/segmentation-articles-par-rep', async (req, res) => {
  const dim = req.query.dim || 'ARTFAMILLE';
  if (!ARTICLE_DIMS.has(dim)) return res.status(400).json({ error: 'Dimension invalide' });
  const p = resolvePeriod(req.query);
  const { repF, addRepParams } = parseRepids(req.query);
  // Filtre actif STRICT sur la ligne (idem segmentation-clients-par-rep)
  const actifLine = (() => {
    const a = parseActif(req.query);
    return a ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${a}')` : '';
  })();
  try {
    const pool = await resolveCommercialPool(req);
    const r = pool.request();
    r.input('dateDebut', sql.VarChar(10), p.dateDebut);
    r.input('dateFin',   sql.VarChar(10), p.dateFin);
    addRepParams(r);
    const segExpr  = dim === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.${dim}), 'Non défini')`;
    const joinFam  = dim === 'ARTFAMILLE' ? `LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID` : '';
    const groupBy  = dim === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE, tr.TIRID, tr.TIRSOCIETE' : `a.${dim}, tr.TIRID, tr.TIRSOCIETE`;
    const result = await r.query(`
      SELECT ISNULL(RTRIM(tr.TIRSOCIETE), 'Non assigné') AS rep,
             ${segExpr} AS segment,
             SUM(${exprCA()}) AS valeur
      ${LINE_FROM}
      ${joinFam}
      LEFT JOIN TIERS tr WITH (NOLOCK) ON tr.TIRID=pv.TIRID_REP AND tr.TIRTYPE='R'
      WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL ${repF} ${actifLine}
        AND pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin
      GROUP BY ${groupBy}
      ORDER BY rep, valeur DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Rapport intégré — Secteur d'activité × Marque × Commercial × Article
// Compare N vs N-1 en nb clients distincts et % de pénétration sur le total
// des clients du secteur. Renvoie aussi la liste des clients sans présence
// (clients TIERS du secteur n'ayant rien acheté de la/les marque(s) sur la
// période N + N-1).
//
// Query : annee (default = année courante), marques (CSV libellés), repid (CSV),
//         actif (O/N/all, défaut O pour les commerciaux), cliactif (O/N/all,
//         défaut O pour les clients).
//
// Réponse :
//   { annee, anneeN1, marques: [..], commerciaux: [..],
//     totalClientsBySecteur: { secteur: nbTotal },
//     totalClientsGlobal: nbTotal,
//     tree: [ { secteur, totalClients, nbN, nbN1, caN, caN1,
//               marques: [ { marque, nbN, nbN1, caN, caN1,
//                            reps: [ { rep_id, commercial, nbN, nbN1, caN, caN1,
//                                      articles: [ { art_id, code, designation,
//                                                    nbN, nbN1, caN, caN1 } ] } ] } ] } ],
//     absences: [ { secteur, clients: [ { tir_id, code, nom, commercial } ] } ] }
// Résout la période demandée pour le rapport secteur-marque.
// Accepte : '' ou 'ytd' (YTD calendaire), 'ytd_exe:d0:d1' (YTD exercice),
// 'exe:d0:d1' (exercice fiscal complet), '2026' (année calendaire complète).
function resolveSecteurMarquePeriod(q) {
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const yT = today.getFullYear();
  const todayStr = `${yT}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  const shiftYear = (dateStr, delta) => {
    const p = dateStr.split('-');
    return `${parseInt(p[0]) + delta}-${p[1]}-${p[2]}`;
  };
  const a = String(q.annee || '').trim();
  if (a === 'ytd' || a === '') {
    return {
      dN: `${yT}-01-01`, fN: todayStr,
      dN1: `${yT-1}-01-01`, fN1: shiftYear(todayStr, -1),
      labelN: `YTD ${yT}`, labelN1: `YTD ${yT-1}`,
      mode: 'ytd',
    };
  }
  if (a.startsWith('ytd_exe:')) {
    const [, d0, d1] = a.split(':');
    // Année du label = année de FIN d'exercice (d1). Pour un exercice
    // 2025-10-01 → 2026-09-30, on affiche "YTD Exe 2026" et N-1 = "YTD Exe 2025".
    // Fallback sur d0 si d1 absent (anciens appels sans date de fin).
    const yEnd = (d1 && d1.length >= 4) ? d1.slice(0,4) : d0.slice(0,4);
    return {
      dN: d0, fN: todayStr,
      dN1: shiftYear(d0, -1), fN1: shiftYear(todayStr, -1),
      labelN: `YTD Exe ${yEnd}`, labelN1: `YTD Exe ${parseInt(yEnd,10)-1}`,
      mode: 'ytd_exe',
    };
  }
  if (a.startsWith('exe:')) {
    const [, d0, d1] = a.split(':');
    const ystart = d0.slice(0,4), yend = d1.slice(0,4);
    const crossYear = ystart !== yend;
    return {
      dN: d0, fN: d1,
      dN1: shiftYear(d0, -1), fN1: shiftYear(d1, -1),
      labelN:  crossYear ? `Exe ${ystart}-${yend}` : `Exe ${ystart}`,
      labelN1: crossYear ? `Exe ${parseInt(ystart)-1}-${parseInt(yend)-1}` : `Exe ${parseInt(ystart)-1}`,
      mode: 'exe',
    };
  }
  const y = parseInt(a) || yT;
  return {
    dN: `${y}-01-01`, fN: `${y}-12-31`,
    dN1: `${y-1}-01-01`, fN1: `${y-1}-12-31`,
    labelN: String(y), labelN1: String(y-1),
    mode: 'cal',
  };
}

// Fonction utilitaire qui produit le payload complet du rapport. Extraite pour
// que les routes JSON, Excel et PDF puissent la réutiliser sans dupliquer la
// logique de fetch/agrégation.
async function fetchSecteurMarqueData(pool, query) {
  const period = resolveSecteurMarquePeriod(query);
  const dN = period.dN, fN = period.fN, dN1 = period.dN1, fN1 = period.fN1;
  const pr = resolvePrCol(query.pr);

  // Métadonnées de la base réellement interrogée — sert au badge d'en-tête
  // qui doit refléter la base utilisée (et non celle du JWT) en cas de bascule.
  const [dbNameRow, societe] = await Promise.all([
    pool.request().query(`SELECT DB_NAME() AS db`).then(r => r.recordset[0]?.db || null).catch(() => null),
    fetchSocieteFromPool(pool),
  ]);

  const { repids, repF, addRepParams } = parseRepids(query);
  const actif = parseActif(query);
  const actifLine = actif
    ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${actif}')`
    : '';
  const cliActifRaw = (query.cliactif || '').trim();
  const isCliPeriodMode = cliActifRaw === 'period';
  const cliActif = isCliPeriodMode
    ? ''
    : (cliActifRaw === 'N' ? 'N' : (cliActifRaw === 'all' || cliActifRaw === '' ? 'O' : 'O'));
  const cliActifTcCond = cliActif ? ` AND tc.TIRISACTIF='${cliActif}'` : '';
  const cliActifBareCond = cliActif ? ` AND TIRISACTIF='${cliActif}'` : '';
  // Mode "période" : clients ayant ≥1 ligne de vente statistique (CA ≠ 0,
  // positif ou négatif) sur N ou N-1 — indépendant de TIRISACTIF. Appliqué
  // sur Q1 (univers clients) et Q3 (absences) ; Q2 est déjà borné par les
  // dates donc le filtre y serait redondant.
  const cliPeriodTcCond = isCliPeriodMode
    ? ` AND EXISTS (
          SELECT 1 FROM PIECEVENTELIGNES pl2
          JOIN PIECEVENTES pv2 ON pv2.PCVID=pl2.PCVID
          JOIN PIECE_NATURE pn2 WITH (NOLOCK) ON pn2.PINID=pv2.PINID
          JOIN ARTICLES a2 WITH (NOLOCK) ON a2.ARTID=pl2.ARTID
          WHERE pn2.PITCODE='F' AND pn2.PINSENSSTATISTIQUE<>0 AND a2.ARTISSTATISTIQUE='O'
            AND pv2.TIRID=tc.TIRID
            AND ((pv2.PCVDATEEFFET>=@dN  AND pv2.PCVDATEEFFET<=@fN)
              OR (pv2.PCVDATEEFFET>=@dN1 AND pv2.PCVDATEEFFET<=@fN1))
        )`
    : '';

  const marquesRaw = String(query.marques || '').trim();
  const marques = marquesRaw
    ? marquesRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)
    : [];
  const addMarqueParams = r => marques.forEach((m, i) => r.input(`marque${i}`, sql.NVarChar(255), m));
  const marqueF = marques.length
    ? `AND a.ARTMARQUE IN (${marques.map((_, i) => `@marque${i}`).join(',')})`
    : '';

  const famillesRaw = String(query.familles || '').trim();
  const familles = famillesRaw
    ? famillesRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)
    : [];
  const addFamilleParams = r => familles.forEach((f, i) => r.input(`fam${i}`, sql.NVarChar(255), f));
  // Filtre famille via la table ARTFAMILLES (libellé AFMINTITULE). Sous-requête
  // pour éviter de modifier LINE_FROM. Le NOT EXISTS de Q3 reçoit aussi ce
  // filtre pour rester cohérent globalement.
  const famF = familles.length
    ? `AND a.AFMID IN (SELECT AFMID FROM ARTFAMILLES WITH (NOLOCK) WHERE AFMINTITULE IN (${familles.map((_, i) => `@fam${i}`).join(',')}))`
    : '';

  const secteursRaw = String(query.secteurs || '').trim();
  const secteurs = secteursRaw
    ? secteursRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100)
    : [];
  const addSecteurParams = r => secteurs.forEach((s, i) => r.input(`sec${i}`, sql.NVarChar(255), s));
  const secteurInList = secteurs.map((_, i) => `@sec${i}`).join(',');
  const secteurFTc   = secteurs.length ? `AND ISNULL(RTRIM(tc.TIRACTIVITE),'Non défini') IN (${secteurInList})` : '';
  const secteurFBare = secteurs.length ? `AND ISNULL(RTRIM(TIRACTIVITE),'Non défini') IN (${secteurInList})`   : '';

  const repCliF = repids.length
    ? `AND tc.REPID IN (${repids.map((_, i) => `@repid${i}`).join(',')})`
    : '';

  // Q1 — Liste complète des clients du périmètre, avec secteur + commercial assigné.
  // Sert à la fois (1) au calcul `totalClientsBySecteur`, (2) à enrichir les
  // absences article (gaps) avec le nom du client et son commercial.
    const r1 = pool.request();
    if (repids.length) addRepParams(r1);
    addSecteurParams(r1);
    if (isCliPeriodMode) {
      r1.input('dN',  sql.VarChar(10), dN);
      r1.input('fN',  sql.VarChar(10), fN);
      r1.input('dN1', sql.VarChar(10), dN1);
      r1.input('fN1', sql.VarChar(10), fN1);
    }
    const q1 = await r1.query(`
      SELECT tc.TIRID,
             ISNULL(RTRIM(tc.TIRACTIVITE),'Non défini') AS secteur,
             RTRIM(tc.TIRCODE)    AS code,
             RTRIM(tc.TIRSOCIETE) AS nom,
             ISNULL(tc.REPID, 0)  AS rep_id,
             ISNULL(RTRIM(tr.TIRSOCIETE),'') AS commercial
      FROM TIERS tc WITH (NOLOCK)
      LEFT JOIN TIERS tr WITH (NOLOCK) ON tr.TIRID=tc.REPID AND tr.TIRTYPE='R'
      WHERE tc.TIRTYPE='C'${cliActifTcCond}${cliPeriodTcCond}
        ${repids.length ? `AND tc.REPID IN (${repids.map((_, i) => `@repid${i}`).join(',')})` : ''}
        ${secteurFTc}
    `);
    const totalClientsBySecteur = {};
    // Portefeuille global par commercial (tc.REPID), tous secteurs/marques
    // confondus, filtré par cliactif + commercial + secteur (filtres globaux
    // utilisateur). Sert de dénominateur pour le % au niveau commercial dans
    // l'arbre. Clé = REPID (entier, 0 pour non assigné).
    const totalClientsByRep = {};
    const tirInfoMap = new Map(); // tirid -> {tir_id, secteur, code, nom, commercial}
    q1.recordset.forEach(row => {
      totalClientsBySecteur[row.secteur] = (totalClientsBySecteur[row.secteur] || 0) + 1;
      totalClientsByRep[row.rep_id] = (totalClientsByRep[row.rep_id] || 0) + 1;
      tirInfoMap.set(row.TIRID, {
        tir_id: row.TIRID, secteur: row.secteur, code: row.code,
        nom: row.nom, commercial: row.commercial,
      });
    });
    let totalClientsGlobal = q1.recordset.length;

    // Q2 — Détail par (secteur, marque, commercial, article, tirid, année)
    const r2 = pool.request();
    r2.input('dN',  sql.VarChar(10), dN);
    r2.input('fN',  sql.VarChar(10), fN);
    r2.input('dN1', sql.VarChar(10), dN1);
    r2.input('fN1', sql.VarChar(10), fN1);
    addRepParams(r2);
    addMarqueParams(r2);
    addFamilleParams(r2);
    addSecteurParams(r2);
    // `period_n` classifie chaque ligne dans N (1) ou N-1 (0). Cette logique
    // gère correctement les exercices fiscaux qui chevauchent 2 années calendaires
    // (un YEAR() ne suffirait pas à séparer N et N-1).
    const q2 = await r2.query(`
      SELECT
        ISNULL(RTRIM(tc.TIRACTIVITE),'Non défini') AS secteur,
        ISNULL(RTRIM(a.ARTMARQUE),'Non défini')    AS marque,
        ISNULL(pv.TIRID_REP, 0)                    AS rep_id,
        ISNULL(RTRIM(tr.TIRSOCIETE),'Non assigné') AS commercial,
        a.ARTID                                    AS art_id,
        RTRIM(a.ARTCODE)                           AS art_code,
        RTRIM(a.ARTDESIGNATION)                    AS art_designation,
        pv.TIRID                                   AS tir_id,
        CASE WHEN pv.PCVDATEEFFET>=@dN AND pv.PCVDATEEFFET<=@fN THEN 1 ELSE 0 END AS period_n,
        SUM(${exprCA()})                           AS ca,
        SUM(${exprMgSf(pr)})                       AS mg_sf,
        SUM(${exprMgAf(pr)})                       AS mg_af,
        SUM(${exprQte()})                          AS qte,
        SUM(ABS(pl.PLVD1)*pn.PINSENSSTATISTIQUE)   AS cartons
      ${LINE_FROM}
      JOIN TIERS tc WITH (NOLOCK) ON tc.TIRID=pv.TIRID
      LEFT JOIN TIERS tr WITH (NOLOCK) ON tr.TIRID=pv.TIRID_REP AND tr.TIRTYPE='R'
      WHERE ${LINE_WHERE_FACT}
        AND tc.TIRTYPE='C'${cliActifTcCond}
        ${marqueF} ${famF} ${repF} ${actifLine} ${secteurFTc}
        AND ((pv.PCVDATEEFFET>=@dN  AND pv.PCVDATEEFFET<=@fN)
          OR (pv.PCVDATEEFFET>=@dN1 AND pv.PCVDATEEFFET<=@fN1))
      GROUP BY tc.TIRACTIVITE, a.ARTMARQUE, pv.TIRID_REP, tr.TIRSOCIETE,
               a.ARTID, a.ARTCODE, a.ARTDESIGNATION, pv.TIRID,
               CASE WHEN pv.PCVDATEEFFET>=@dN AND pv.PCVDATEEFFET<=@fN THEN 1 ELSE 0 END
    `);

    // Q3 — Clients absents (n'ont rien acheté de la/les marque(s) sur N+N-1)
    // Optionnel : si aucune marque sélectionnée, on omet (mesure non significative).
    let absencesBySecteur = [];
    if (marques.length) {
      const r3 = pool.request();
      r3.input('dN',  sql.VarChar(10), dN);
      r3.input('fN',  sql.VarChar(10), fN);
      r3.input('dN1', sql.VarChar(10), dN1);
      r3.input('fN1', sql.VarChar(10), fN1);
      addRepParams(r3);
      addMarqueParams(r3);
      addFamilleParams(r3);
      addSecteurParams(r3);
      const q3 = await r3.query(`
        SELECT
          ISNULL(RTRIM(tc.TIRACTIVITE),'Non défini') AS secteur,
          tc.TIRID                                  AS tir_id,
          RTRIM(tc.TIRCODE)                          AS code,
          RTRIM(tc.TIRSOCIETE)                       AS nom,
          ISNULL(RTRIM(tr.TIRSOCIETE),'')            AS commercial
        FROM TIERS tc WITH (NOLOCK)
        LEFT JOIN TIERS tr WITH (NOLOCK) ON tr.TIRID=tc.REPID AND tr.TIRTYPE='R'
        WHERE tc.TIRTYPE='C'${cliActifTcCond}${cliPeriodTcCond}
          ${repCliF}
          ${secteurFTc}
          AND NOT EXISTS (
            SELECT 1
            ${LINE_FROM}
            WHERE ${LINE_WHERE_FACT}
              AND pv.TIRID=tc.TIRID
              ${marqueF} ${famF}
              AND ((pv.PCVDATEEFFET>=@dN  AND pv.PCVDATEEFFET<=@fN)
                OR (pv.PCVDATEEFFET>=@dN1 AND pv.PCVDATEEFFET<=@fN1))
          )
        ORDER BY secteur, nom
      `);
      const bySec = new Map();
      q3.recordset.forEach(row => {
        if (!bySec.has(row.secteur)) bySec.set(row.secteur, []);
        bySec.get(row.secteur).push({
          tir_id: row.tir_id, code: row.code, nom: row.nom, commercial: row.commercial,
        });
      });
      absencesBySecteur = Array.from(bySec.entries())
        .map(([secteur, clients]) => ({ secteur, clients }))
        .sort((a, b) => a.secteur.localeCompare(b.secteur, 'fr'));
    }

    // ── Agrégation JS : tree générique paramétré par les niveaux ──────────
    // Chaque nœud agrège : nb clients distincts (Set) + 5 mesures (CA, marge SF/AF, qté, cartons).
    // Les niveaux disponibles : 'secteur' | 'marque' | 'rep' | 'art' — la hiérarchie
    // est libre (on construit ici 2 vues : secteur→marque et marque→secteur).
    const MEAS = ['ca', 'mg_sf', 'mg_af', 'qte', 'cartons'];
    // Spec par niveau : keyField = colonne SQL servant de clé d'agrégation,
    //                   labelField = colonne servant de libellé,
    //                   extra = champs additionnels à recopier dans le nœud
    const LEVEL_SPECS = {
      secteur: { type: 'secteur', keyField: 'secteur', labelField: 'secteur', extra: () => ({}) },
      marque:  { type: 'marque',  keyField: 'marque',  labelField: 'marque',  extra: () => ({}) },
      rep:     { type: 'rep',     keyField: 'rep_id',  labelField: 'commercial',
                 extra: row => ({ rep_id: row.rep_id, commercial: row.commercial }) },
      art:     { type: 'art',     keyField: 'art_id',  labelField: null,
                 extra: row => ({ art_id: row.art_id, code: row.art_code, designation: row.art_designation }) },
    };
    const newNode = () => {
      const n = { _N: new Set(), _N1: new Set(), children: new Map() };
      MEAS.forEach(k => { n[`${k}_N`] = 0; n[`${k}_N1`] = 0; });
      return n;
    };
    function buildTree(rows, levels) {
      const root = new Map();
      rows.forEach(row => {
        const suf  = row.period_n === 1 ? '_N' : '_N1';
        const vals = MEAS.map(k => parseFloat(row[k]) || 0);
        let map = root;
        const path = [];
        levels.forEach(lvl => {
          const spec = LEVEL_SPECS[lvl];
          const key = row[spec.keyField];
          let node = map.get(key);
          if (!node) {
            node = newNode();
            node.type  = spec.type;
            node.label = spec.labelField ? String(row[spec.labelField] ?? '') : '';
            Object.assign(node, spec.extra(row));
            map.set(key, node);
          }
          path.push(node);
          map = node.children;
        });
        path.forEach(n => {
          n[suf].add(row.tir_id);
          MEAS.forEach((k, i) => { n[`${k}${suf}`] += vals[i]; });
        });
      });
      return root;
    }
    function serializeTree(map) {
      const out = [];
      map.forEach((n) => {
        const o = {
          type: n.type, label: n.label,
          nbN: n._N.size, nbN1: n._N1.size,
        };
        MEAS.forEach(k => { o[`${k}_N`] = n[`${k}_N`]; o[`${k}_N1`] = n[`${k}_N1`]; });
        // Champs spécifiques au type (rep_id, art_id, code, designation)
        ['rep_id', 'commercial', 'art_id', 'code', 'designation'].forEach(f => {
          if (n[f] !== undefined) o[f] = n[f];
        });
        // Total clients du secteur (utile pour les % de présence)
        if (n.type === 'secteur') o.totalClients = totalClientsBySecteur[n.label] || 0;
        // Au niveau commercial : portefeuille global du commercial tous
        // secteurs/marques confondus, filtré par cliactif + commercial +
        // secteur globaux. Utilisé comme dénominateur pour le % au niveau
        // commercial dans l'arbre.
        if (n.type === 'rep') {
          o.totalClients = totalClientsByRep[n.rep_id] || 0;
        }
        if (n.children.size > 0) o.children = serializeTree(n.children);
        out.push(o);
      });
      // Niveau article = tri alphabétique par code (lecture en mode catalogue).
      // Autres niveaux = priorisation business par CA N desc, fallback CA N-1, nb clients.
      const isArt = out.length > 0 && out[0].type === 'art';
      return isArt
        ? out.sort((x, y) => (x.code || '').localeCompare(y.code || '', 'fr', { numeric: true }))
        : out.sort((x, y) => (y.ca_N - x.ca_N) || (y.ca_N1 - x.ca_N1) || (y.nbN - x.nbN));
    }

    const treeBySecteur = serializeTree(buildTree(q2.recordset, ['secteur', 'marque', 'rep', 'art']));
    const treeByMarque  = serializeTree(buildTree(q2.recordset, ['marque', 'secteur', 'rep', 'art']));

    // ── Gaps article : clients qui achètent la marque mais pas tel article ──
    // Pour chaque marque : pour chaque article ayant >=1 acheteur, lister les
    // clients qui ont acheté un autre article de la marque sur N+N-1 sans avoir
    // acheté CET article. Donne les opportunités de cross-sell intra-marque.
    const byArticle = new Map();   // 'marque|art_id' -> { marque, art_id, code, designation, buyers: Set<tirid> }
    const byMarque  = new Map();   // marque -> Set<tirid>
    q2.recordset.forEach(row => {
      const aKey = `${row.marque}|${row.art_id}`;
      if (!byArticle.has(aKey)) {
        byArticle.set(aKey, {
          marque: row.marque, art_id: row.art_id,
          code: row.art_code, designation: row.art_designation,
          buyers: new Set(),
        });
      }
      byArticle.get(aKey).buyers.add(row.tir_id);
      if (!byMarque.has(row.marque)) byMarque.set(row.marque, new Set());
      byMarque.get(row.marque).add(row.tir_id);
    });
    const absencesArticles = [];
    const gapsByClient    = [];  // Vue inverse : par client, articles manquants
    byMarque.forEach((marqueBuyers, marque) => {
      // Tous les articles vendus dans la marque sur la période (filtrée)
      const marqueArticles = [];
      byArticle.forEach((art) => { if (art.marque === marque) marqueArticles.push(art); });

      // ── Vue article-centric : par article, les clients absents
      const articles = [];
      marqueArticles.forEach(art => {
        const absentTirIds = [];
        marqueBuyers.forEach(t => { if (!art.buyers.has(t)) absentTirIds.push(t); });
        if (absentTirIds.length === 0) return;
        const clients = absentTirIds
          .map(t => tirInfoMap.get(t))
          .filter(Boolean)
          .sort((a, b) => (a.secteur || '').localeCompare(b.secteur || '', 'fr')
                          || (a.nom || '').localeCompare(b.nom || '', 'fr'));
        articles.push({
          art_id: art.art_id, code: art.code, designation: art.designation,
          nbAbsents: clients.length,
          nbBuyersMarque: marqueBuyers.size,
          clients,
        });
      });
      articles.sort((a, b) => b.nbAbsents - a.nbAbsents);
      if (articles.length) absencesArticles.push({ marque, nbBuyersMarque: marqueBuyers.size, articles });

      // ── Vue client-centric : par client (qui achète la marque), articles manquants
      const clientsGap = [];
      marqueBuyers.forEach(tirId => {
        const missing = marqueArticles
          .filter(art => !art.buyers.has(tirId))
          .map(art => ({ art_id: art.art_id, code: art.code, designation: art.designation }))
          .sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fr'));
        if (missing.length === 0) return;
        const info = tirInfoMap.get(tirId);
        if (!info) return;
        clientsGap.push({
          ...info,
          nbMissing: missing.length,
          nbArticlesMarque: marqueArticles.length,
          missingArticles: missing,
        });
      });
      // Tri : clients avec le plus d'articles manquants en premier
      clientsGap.sort((a, b) => b.nbMissing - a.nbMissing
                                || (a.secteur || '').localeCompare(b.secteur || '', 'fr')
                                || (a.nom || '').localeCompare(b.nom || '', 'fr'));
      if (clientsGap.length) gapsByClient.push({
        marque,
        nbArticlesMarque: marqueArticles.length,
        nbBuyersMarque: marqueBuyers.size,
        clients: clientsGap,
      });
    });
    absencesArticles.sort((a, b) => a.marque.localeCompare(b.marque, 'fr'));
    gapsByClient.sort((a, b) => a.marque.localeCompare(b.marque, 'fr'));

    // Totaux globaux (tous secteurs confondus)
    const globalAcheteursN  = new Set();
    const globalAcheteursN1 = new Set();
    const globalMeas = { ca_N: 0, ca_N1: 0, mg_sf_N: 0, mg_sf_N1: 0,
                         mg_af_N: 0, mg_af_N1: 0, qte_N: 0, qte_N1: 0,
                         cartons_N: 0, cartons_N1: 0 };
    q2.recordset.forEach(row => {
      const isN = row.period_n === 1;
      const suf = isN ? '_N' : '_N1';
      if (isN) globalAcheteursN.add(row.tir_id);
      else      globalAcheteursN1.add(row.tir_id);
      MEAS.forEach(k => { globalMeas[`${k}${suf}`] += parseFloat(row[k]) || 0; });
    });

  return {
    generatedAt: new Date().toISOString(),
    // Libellés affichés dans l'UI (peuvent être "YTD 2026", "Exe 2025-2026", etc.)
    annee: period.labelN, anneeN1: period.labelN1,
    periode: { mode: period.mode, dN, fN, dN1, fN1 },
    pr,
    marquesFiltre: marques,
    famillesFiltre: familles,
    commerciauxFiltre: repids,
    secteursFiltre: secteurs,
    db: { database: dbNameRow, societe },
    totalClientsBySecteur,
    totalClientsGlobal,
    globalAcheteursN: globalAcheteursN.size,
    globalAcheteursN1: globalAcheteursN1.size,
    global: globalMeas,
    treeBySecteur,
    treeByMarque,
    absences: absencesBySecteur,
    absencesArticles,
    gapsByClient,
  };
}

router.get('/rapport-secteur-marque', async (req, res) => {
  try {
    const pool = await resolveCommercialPool(req);
    const data = await fetchSecteurMarqueData(pool, req.query);
    res.json(data);
  } catch (err) {
    console.error('[rapport-secteur-marque]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── Export Excel ─────────────────────────────────────────────────────────────
router.get('/rapport-secteur-marque/excel', async (req, res) => {
  try {
    const pool = await resolveCommercialPool(req);
    const data = await fetchSecteurMarqueData(pool, req.query);
    const buf  = await buildSecteurMarqueExcel(data);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="penetration-secteur-marque-${dateStr}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('[rapport-secteur-marque/excel]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── Export PDF (via Puppeteer sur un HTML print-friendly) ────────────────────
router.get('/rapport-secteur-marque/pdf', async (req, res) => {
  try {
    const pool = await resolveCommercialPool(req);
    const data = await fetchSecteurMarqueData(pool, req.query);
    const html = buildSecteurMarqueHTML(data);
    const buf  = await htmlToPdfBuffer(html);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="penetration-secteur-marque-${dateStr}.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('[rapport-secteur-marque/pdf]', err.message, err.stack);
    res.status(500).send(`Erreur : ${err.message}`);
  }
});

// ── Builder Excel pour le rapport secteur × marque ──────────────────────────
async function buildSecteurMarqueExcel(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TB Reporting';
  wb.created = new Date();

  const headerFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1A237E' } };
  const headerFont = { bold:true, color:{ argb:'FFFFFFFF' }, size:10 };
  const totalFill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE8ECF4' } };
  const totalFont  = { bold:true, size:10 };
  const lvl1Fill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD7E3F4' } };
  const lvl2Fill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEBF1F9' } };
  const numFmt     = '#,##0';
  const eurFmt     = '#,##0.00 "€"';
  const pctFmt     = '0.0"%"';
  const borderThin = { style:'thin', color:{ argb:'FFC8D0DF' } };
  const border     = { top:borderThin, left:borderThin, bottom:borderThin, right:borderThin };

  // ── Sheet 1 : Synthèse ───────────────────────────────────────────────────
  const wsSyn = wb.addWorksheet('Synthèse');
  wsSyn.columns = [
    { header:'Indicateur', key:'k', width:42 },
    { header:'Valeur',     key:'v', width:24 },
  ];
  wsSyn.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center'}; });
  wsSyn.getRow(1).height = 22;
  const g = data.global || {};
  const periodSub = `${data.periode.dN} → ${data.periode.fN}  vs  ${data.periode.dN1} → ${data.periode.fN1}`;
  wsSyn.addRow({ k:'Période N',                v:`${data.annee}` });
  wsSyn.addRow({ k:'Période N-1',              v:`${data.anneeN1}` });
  wsSyn.addRow({ k:'Dates effectives',         v:periodSub });
  wsSyn.addRow({ k:'Marques filtrées',         v:(data.marquesFiltre||[]).join(', ') || '(toutes)' });
  wsSyn.addRow({ k:'Familles filtrées',        v:(data.famillesFiltre||[]).join(', ') || '(toutes)' });
  wsSyn.addRow({ k:'Secteurs filtrés',         v:(data.secteursFiltre||[]).join(', ') || '(tous)' });
  wsSyn.addRow({ k:'Total clients portefeuille', v:data.totalClientsGlobal }).getCell('v').numFmt = numFmt;
  const acheteursN  = data.globalAcheteursN  || 0;
  const acheteursN1 = data.globalAcheteursN1 || 0;
  wsSyn.addRow({ k:`Acheteurs ${data.annee}`,   v:acheteursN }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:`Acheteurs ${data.anneeN1}`, v:acheteursN1 }).getCell('v').numFmt = numFmt;
  const pctN  = data.totalClientsGlobal>0 ? acheteursN/data.totalClientsGlobal*100 : 0;
  const pctN1 = data.totalClientsGlobal>0 ? acheteursN1/data.totalClientsGlobal*100 : 0;
  wsSyn.addRow({ k:`% pénétration ${data.annee}`,   v:pctN  }).getCell('v').numFmt = pctFmt;
  wsSyn.addRow({ k:`% pénétration ${data.anneeN1}`, v:pctN1 }).getCell('v').numFmt = pctFmt;
  wsSyn.addRow({ k:`CA ${data.annee}`,             v:g.ca_N||0 }).getCell('v').numFmt = eurFmt;
  wsSyn.addRow({ k:`CA ${data.anneeN1}`,           v:g.ca_N1||0 }).getCell('v').numFmt = eurFmt;
  wsSyn.addRow({ k:`Marge SF ${data.annee}`,       v:g.mg_sf_N||0 }).getCell('v').numFmt = eurFmt;
  wsSyn.addRow({ k:`Marge SF ${data.anneeN1}`,     v:g.mg_sf_N1||0 }).getCell('v').numFmt = eurFmt;
  wsSyn.addRow({ k:`Marge AF ${data.annee}`,       v:g.mg_af_N||0 }).getCell('v').numFmt = eurFmt;
  wsSyn.addRow({ k:`Marge AF ${data.anneeN1}`,     v:g.mg_af_N1||0 }).getCell('v').numFmt = eurFmt;
  wsSyn.addRow({ k:`Quantité ${data.annee}`,       v:g.qte_N||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:`Quantité ${data.anneeN1}`,     v:g.qte_N1||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:`Cartons ${data.annee}`,        v:g.cartons_N||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:`Cartons ${data.anneeN1}`,      v:g.cartons_N1||0 }).getCell('v').numFmt = numFmt;

  // ── Sheets 2 & 3 : Hiérarchies (secteur-first / marque-first) ──────────
  function writeTreeSheet(wsName, tree, levelLabels) {
    const ws = wb.addWorksheet(wsName);
    ws.columns = [
      { header:'Hiérarchie',         key:'h',    width:6 },
      { header:'Libellé',            key:'lbl',  width:50 },
      { header:'Tot. clients',       key:'tot',  width:14 },
      { header:`Nb cli ${data.annee}`,   key:'nN',   width:14 },
      { header:`% ${data.annee}`,        key:'pN',   width:10 },
      { header:`Nb cli ${data.anneeN1}`, key:'nN1',  width:14 },
      { header:`% ${data.anneeN1}`,      key:'pN1',  width:10 },
      { header:`CA ${data.annee}`,        key:'caN',  width:16 },
      { header:`CA ${data.anneeN1}`,      key:'caN1', width:16 },
      { header:`Marge SF ${data.annee}`,   key:'sfN',  width:16 },
      { header:`Marge SF ${data.anneeN1}`, key:'sfN1', width:16 },
      { header:`Marge AF ${data.annee}`,   key:'afN',  width:16 },
      { header:`Marge AF ${data.anneeN1}`, key:'afN1', width:16 },
      { header:`Qté ${data.annee}`,        key:'qN',   width:12 },
      { header:`Qté ${data.anneeN1}`,      key:'qN1',  width:12 },
      { header:`Cartons ${data.annee}`,    key:'kN',   width:12 },
      { header:`Cartons ${data.anneeN1}`,  key:'kN1',  width:12 },
    ];
    ws.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center',wrapText:true}; });
    ws.getRow(1).height = 32;
    ws.views = [{ state:'frozen', xSplit:2, ySplit:1 }];

    function walk(nodes, level, denom) {
      nodes.forEach(n => {
        let nodeDenom = denom;
        let totVal = '';
        if (n.type === 'secteur') {
          nodeDenom = n.totalClients || 0;
          totVal = nodeDenom;
        } else if (n.type === 'marque') {
          totVal = denom;
        } else if (n.type === 'rep') {
          nodeDenom = n.totalClients || 0;
          totVal = nodeDenom;
        }
        const pN  = nodeDenom>0 ? n.nbN/nodeDenom*100 : null;
        const pN1 = nodeDenom>0 ? n.nbN1/nodeDenom*100 : null;
        let lbl;
        if (n.type === 'art') lbl = `${n.code||''} — ${n.designation||''}`;
        else lbl = n.label;
        const prefix = '·  '.repeat(level - 1);
        const row = ws.addRow({
          h:   levelLabels[level-1] || `L${level}`,
          lbl: prefix + lbl,
          tot: totVal,
          nN:  n.nbN, pN: pN,
          nN1: n.nbN1, pN1: pN1,
          caN: n.ca_N, caN1: n.ca_N1,
          sfN: n.mg_sf_N, sfN1: n.mg_sf_N1,
          afN: n.mg_af_N, afN1: n.mg_af_N1,
          qN:  n.qte_N, qN1: n.qte_N1,
          kN:  n.cartons_N, kN1: n.cartons_N1,
        });
        // Numeric formatting
        ['tot','nN','nN1','qN','qN1','kN','kN1'].forEach(k => { row.getCell(k).numFmt = numFmt; });
        ['caN','caN1','sfN','sfN1','afN','afN1'].forEach(k => { row.getCell(k).numFmt = eurFmt; });
        ['pN','pN1'].forEach(k => { row.getCell(k).numFmt = pctFmt; });
        // Fill par niveau pour lisibilité
        if (level === 1) { row.eachCell(c => { c.font = totalFont; c.fill = lvl1Fill; }); }
        else if (level === 2) { row.eachCell(c => { c.fill = lvl2Fill; }); }
        if (n.children) walk(n.children, level+1, nodeDenom);
      });
    }
    walk(tree, 1, data.totalClientsGlobal || 0);
  }
  writeTreeSheet('Secteur → Marque', data.treeBySecteur || [],
                 ['Secteur', 'Marque', 'Commercial', 'Article']);
  writeTreeSheet('Marque → Secteur', data.treeByMarque || [],
                 ['Marque', 'Secteur', 'Commercial', 'Article']);

  // ── Sheet 4 : Absences (clients qui n'achètent PAS la marque) ───────────
  const wsAbs = wb.addWorksheet('Absences marque');
  wsAbs.columns = [
    { header:'Secteur d\'activité', key:'sec',  width:28 },
    { header:'Code client',         key:'code', width:14 },
    { header:'Client',              key:'nom',  width:50 },
    { header:'Commercial',          key:'cml',  width:28 },
  ];
  wsAbs.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center'}; });
  wsAbs.getRow(1).height = 22;
  wsAbs.views = [{ state:'frozen', ySplit:1 }];
  if (!data.marquesFiltre || data.marquesFiltre.length === 0) {
    wsAbs.addRow({ sec:'(analyse disponible uniquement avec au moins une marque sélectionnée)' });
  } else if (!data.absences || data.absences.length === 0) {
    wsAbs.addRow({ sec:'Aucun client absent : tous les clients du périmètre ont acheté la marque sur la période.' });
  } else {
    data.absences.forEach(sec => {
      sec.clients.forEach(c => {
        wsAbs.addRow({ sec: sec.secteur, code: c.code, nom: c.nom, cml: c.commercial });
      });
    });
  }

  // ── Sheet 5 : Gaps article (clients de la marque qui n'ont pas tel article)
  const wsGap = wb.addWorksheet('Gaps article');
  wsGap.columns = [
    { header:'Marque',           key:'mar',  width:18 },
    { header:'Code article',     key:'acode', width:14 },
    { header:'Désignation',      key:'adesi', width:42 },
    { header:'Cli de la marque', key:'tot',  width:14 },
    { header:'Cli absents',      key:'nb',   width:12 },
    { header:'Secteur',          key:'sec',  width:24 },
    { header:'Code client',      key:'ccode',width:14 },
    { header:'Client',           key:'cnom', width:46 },
    { header:'Commercial',       key:'cml',  width:26 },
  ];
  wsGap.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center'}; });
  wsGap.getRow(1).height = 22;
  wsGap.views = [{ state:'frozen', ySplit:1 }];
  if (!data.absencesArticles || data.absencesArticles.length === 0) {
    wsGap.addRow({ mar:'Aucun gap article : tous les clients de chaque marque ont acheté tous les articles vendus sur la période.' });
  } else {
    data.absencesArticles.forEach(mar => {
      mar.articles.forEach(art => {
        if (art.clients.length === 0) return;
        // Ligne d'en-tête article (mise en évidence)
        const headRow = wsGap.addRow({
          mar: mar.marque, acode: art.code, adesi: art.designation,
          tot: art.nbBuyersMarque, nb: art.nbAbsents, sec:'', ccode:'', cnom:'', cml:'',
        });
        headRow.eachCell(c => { c.fill = lvl2Fill; c.font = totalFont; });
        // Une ligne par client absent
        art.clients.forEach(c => {
          wsGap.addRow({
            mar:'', acode:'', adesi:'', tot:'', nb:'',
            sec: c.secteur, ccode: c.code, cnom: c.nom, cml: c.commercial,
          });
        });
      });
    });
  }

  // ── Sheet 6 : Gaps client (par client, articles non achetés de la marque)
  const wsGapCli = wb.addWorksheet('Gaps client');
  wsGapCli.columns = [
    { header:'Marque',           key:'mar',   width:18 },
    { header:'Secteur',          key:'sec',   width:24 },
    { header:'Code client',      key:'ccode', width:14 },
    { header:'Client',           key:'cnom',  width:46 },
    { header:'Commercial',       key:'cml',   width:26 },
    { header:'Art manquants',    key:'nb',    width:14 },
    { header:'Art marque',       key:'tot',   width:12 },
    { header:'Code article',     key:'acode', width:14 },
    { header:'Désignation',      key:'adesi', width:42 },
  ];
  wsGapCli.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center'}; });
  wsGapCli.getRow(1).height = 22;
  wsGapCli.views = [{ state:'frozen', ySplit:1 }];
  if (!data.gapsByClient || data.gapsByClient.length === 0) {
    wsGapCli.addRow({ mar:'Aucun gap client : chaque client de la marque a acheté tous les articles vendus sur la période.' });
  } else {
    data.gapsByClient.forEach(mar => {
      mar.clients.forEach(c => {
        // Ligne d'en-tête client (mise en évidence)
        const headRow = wsGapCli.addRow({
          mar: mar.marque, sec: c.secteur, ccode: c.code, cnom: c.nom, cml: c.commercial,
          nb: c.nbMissing, tot: c.nbArticlesMarque, acode:'', adesi:'',
        });
        headRow.eachCell(cc => { cc.fill = lvl2Fill; cc.font = totalFont; });
        // Une ligne par article manquant
        c.missingArticles.forEach(a => {
          wsGapCli.addRow({
            mar:'', sec:'', ccode:'', cnom:'', cml:'', nb:'', tot:'',
            acode: a.code, adesi: a.designation,
          });
        });
      });
    });
  }

  return await wb.xlsx.writeBuffer();
}

// ── Builder HTML pour le PDF (print-friendly) ───────────────────────────────
function buildSecteurMarqueHTML(data) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n, dec=0) => {
    if (n===null||n===undefined||isNaN(n)) return '—';
    return new Intl.NumberFormat('fr-FR',{minimumFractionDigits:dec,maximumFractionDigits:dec}).format(n);
  };
  const fmtE = n => fmt(n) + ' €';
  const evolPct = (n, ref) => ref>0 ? (n-ref)/ref*100 : null;
  const evolHtml = (n, ref) => {
    const e = evolPct(n, ref);
    if (e===null) return '';
    const cls = e>=0 ? 'pos' : 'neg';
    return `<span class="${cls}">${e>=0?'+':''}${fmt(e,1)} %</span>`;
  };
  const g = data.global || {};

  // Tableau hiérarchique applati pour le PDF (un seul aperçu : secteur-first)
  function renderTree(tree, levelLabels, rootDenom) {
    let html = `<table class="tree">
      <thead><tr>
        <th class="lbl">Hiérarchie</th>
        <th>Tot. cli</th>
        <th>Nb ${esc(data.annee)}</th>
        <th>%</th>
        <th>Nb ${esc(data.anneeN1)}</th>
        <th>%</th>
        <th>CA ${esc(data.annee)}</th>
        <th>CA ${esc(data.anneeN1)}</th>
        <th>Évol</th>
      </tr></thead><tbody>`;
    function walk(nodes, level, denom) {
      nodes.forEach(n => {
        let nodeDenom = denom;
        let totHtml = '—';
        if (n.type === 'secteur') {
          nodeDenom = n.totalClients || 0;
          totHtml = fmt(nodeDenom);
        } else if (n.type === 'marque') {
          totHtml = fmt(denom);
        } else if (n.type === 'rep') {
          nodeDenom = n.totalClients || 0;
          totHtml = fmt(nodeDenom);
        }
        const pN  = nodeDenom>0 ? n.nbN/nodeDenom*100 : null;
        const pN1 = nodeDenom>0 ? n.nbN1/nodeDenom*100 : null;
        let lbl = n.type === 'art' ? `${n.code||''} — ${n.designation||''}` : n.label;
        html += `<tr class="lvl${level}">
          <td class="lbl">${'&nbsp;'.repeat((level-1)*3)}${esc(lbl)}</td>
          <td>${totHtml}</td>
          <td>${fmt(n.nbN)}</td>
          <td>${pN!==null?fmt(pN,1)+'%':''}</td>
          <td>${fmt(n.nbN1)}</td>
          <td>${pN1!==null?fmt(pN1,1)+'%':''}</td>
          <td>${fmtE(n.ca_N)}</td>
          <td>${fmtE(n.ca_N1)}</td>
          <td>${evolHtml(n.ca_N, n.ca_N1)}</td>
        </tr>`;
        if (n.children) walk(n.children, level+1, nodeDenom);
      });
    }
    walk(tree, 1, rootDenom);
    html += '</tbody></table>';
    return html;
  }

  let absencesHtml = '';
  if (data.marquesFiltre && data.marquesFiltre.length && data.absences && data.absences.length) {
    absencesHtml = '<h2>Clients sans présence (aucun article de la marque acheté)</h2>';
    data.absences.forEach(sec => {
      absencesHtml += `<h3>${esc(sec.secteur)} (${sec.clients.length} client(s))</h3><ul>`;
      sec.clients.forEach(c => {
        absencesHtml += `<li>${esc(c.nom)}${c.code?` <span class="muted">[${esc(c.code)}]</span>`:''}${c.commercial?` <span class="muted">— ${esc(c.commercial)}</span>`:''}</li>`;
      });
      absencesHtml += '</ul>';
    });
  }
  let gapsHtml = '';
  if (data.absencesArticles && data.absencesArticles.length) {
    gapsHtml += '<h2>Gaps article — clients de la marque sans présence sur l\'article</h2>';
    data.absencesArticles.forEach(mar => {
      gapsHtml += `<h3>${esc(mar.marque)} (${mar.nbBuyersMarque} clients de la marque · ${mar.articles.length} article(s) avec gap)</h3>`;
      mar.articles.forEach(art => {
        gapsHtml += `<div style="margin:4px 0 6px"><strong>${esc(art.code)} — ${esc(art.designation)}</strong> <span class="muted">(${art.nbAbsents}/${art.nbBuyersMarque} sans présence)</span><ul>`;
        art.clients.forEach(c => {
          gapsHtml += `<li>${esc(c.nom)}${c.code?` <span class="muted">[${esc(c.code)}]</span>`:''} <span class="muted">— ${esc(c.secteur)}${c.commercial?' / '+esc(c.commercial):''}</span></li>`;
        });
        gapsHtml += '</ul></div>';
      });
    });
  }
  if (data.gapsByClient && data.gapsByClient.length) {
    gapsHtml += '<h2 style="page-break-before:always">Gaps client — articles non achetés par client présent dans la marque</h2>';
    data.gapsByClient.forEach(mar => {
      gapsHtml += `<h3>${esc(mar.marque)} (${mar.nbBuyersMarque} clients · ${mar.nbArticlesMarque} articles)</h3>`;
      mar.clients.forEach(c => {
        gapsHtml += `<div style="margin:4px 0 6px"><strong>${esc(c.nom)}</strong>${c.code?` <span class="muted">[${esc(c.code)}]</span>`:''} <span class="muted">— ${esc(c.secteur)}${c.commercial?' / '+esc(c.commercial):''}</span> <span class="muted">(${c.nbMissing}/${c.nbArticlesMarque} articles manquants)</span><ul>`;
        c.missingArticles.forEach(a => {
          gapsHtml += `<li>${esc(a.code)} — ${esc(a.designation)}</li>`;
        });
        gapsHtml += '</ul></div>';
      });
    });
  }

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Pénétration secteur × marque</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#222;margin:18px;font-size:11px}
  h1{font-size:16px;margin:0 0 6px} h2{font-size:13px;margin:14px 0 6px} h3{font-size:11.5px;margin:8px 0 3px}
  .meta{color:#666;font-size:10px;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;margin-bottom:10px}
  th,td{padding:4px 6px;border:1px solid #d0d4de;text-align:right;font-size:10px}
  th{background:#1a237e;color:#fff;font-weight:600}
  td.lbl,th.lbl{text-align:left}
  tr.lvl1 td{background:#d7e3f4;font-weight:700}
  tr.lvl2 td{background:#ebf1f9}
  tr.lvl4 td{color:#666}
  .kpi{display:flex;gap:14px;margin-bottom:10px;flex-wrap:wrap}
  .kpi div{border:1px solid #d0d4de;padding:6px 10px;border-radius:4px;min-width:130px}
  .kpi .l{font-size:9px;color:#666;text-transform:uppercase}
  .kpi .v{font-size:14px;font-weight:700;margin-top:2px}
  .pos{color:#1b5e20} .neg{color:#b71c1c} .muted{color:#888}
  ul{margin:2px 0 6px 18px;padding:0}
  li{padding:1px 0;font-size:10px}
  @page{size:A4 landscape;margin:14mm}
</style></head><body>
<h1>🎯 Pénétration secteur × marque</h1>
<div class="meta">
  Période N : ${esc(data.annee)} (${esc(data.periode.dN)} → ${esc(data.periode.fN)})
  · Période N-1 : ${esc(data.anneeN1)} (${esc(data.periode.dN1)} → ${esc(data.periode.fN1)})
  · Marques : ${(data.marquesFiltre||[]).map(esc).join(', ') || '(toutes)'}
  · Familles : ${(data.famillesFiltre||[]).map(esc).join(', ') || '(toutes)'}
  · Secteurs : ${(data.secteursFiltre||[]).map(esc).join(', ') || '(tous)'}
  · Généré le ${new Date(data.generatedAt).toLocaleString('fr-FR')}
</div>
<div class="kpi">
  <div><div class="l">Total clients</div><div class="v">${fmt(data.totalClientsGlobal)}</div></div>
  <div><div class="l">Acheteurs ${esc(data.annee)}</div><div class="v">${fmt(data.globalAcheteursN)} (${data.totalClientsGlobal>0?fmt(data.globalAcheteursN/data.totalClientsGlobal*100,1)+'%':'—'})</div></div>
  <div><div class="l">Acheteurs ${esc(data.anneeN1)}</div><div class="v">${fmt(data.globalAcheteursN1)} (${data.totalClientsGlobal>0?fmt(data.globalAcheteursN1/data.totalClientsGlobal*100,1)+'%':'—'})</div></div>
  <div><div class="l">CA ${esc(data.annee)}</div><div class="v">${fmtE(g.ca_N||0)} ${evolHtml(g.ca_N||0, g.ca_N1||0)}</div></div>
  <div><div class="l">CA ${esc(data.anneeN1)}</div><div class="v">${fmtE(g.ca_N1||0)}</div></div>
</div>
<h2>Hiérarchie Secteur → Marque → Commercial → Article</h2>
${renderTree(data.treeBySecteur||[], ['Secteur','Marque','Cml','Article'], data.totalClientsGlobal||0)}
<h2>Hiérarchie Marque → Secteur → Commercial → Article</h2>
${renderTree(data.treeByMarque||[], ['Marque','Secteur','Cml','Article'], data.totalClientsGlobal||0)}
${absencesHtml}
${gapsHtml}
</body></html>`;
}

// ── Helper : convertit un HTML en PDF via Puppeteer ─────────────────────────
let _sharedBrowser = null;
async function htmlToPdfBuffer(html) {
  const puppeteer = require('puppeteer');
  if (!_sharedBrowser) {
    _sharedBrowser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  const page = await _sharedBrowser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4', landscape: true, printBackground: true,
      margin: { top:'12mm', right:'12mm', bottom:'12mm', left:'12mm' },
    });
  } finally {
    await page.close();
  }
}

// Liste des secteurs d'activité (TIRACTIVITE distinct) pour le sélecteur
router.get('/activites', async (req, res) => {
  try {
    const pool = await resolveCommercialPool(req);
    const r = await pool.request().query(`
      SELECT DISTINCT ISNULL(RTRIM(TIRACTIVITE),'Non défini') AS secteur
      FROM TIERS WITH (NOLOCK)
      WHERE TIRTYPE='C' AND TIRISACTIF='O'
      ORDER BY secteur
    `);
    res.json(r.recordset.map(x => x.secteur));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liste des familles (AFMINTITULE distinct) pour le sélecteur
router.get('/familles', async (req, res) => {
  try {
    const pool = await resolveCommercialPool(req);
    const r = await pool.request().query(`
      SELECT DISTINCT RTRIM(af.AFMINTITULE) AS famille
      FROM ARTFAMILLES af WITH (NOLOCK)
      JOIN ARTICLES a WITH (NOLOCK) ON a.AFMID=af.AFMID
      WHERE af.AFMINTITULE IS NOT NULL
        AND LEN(RTRIM(af.AFMINTITULE))>0
        AND a.ARTISSTATISTIQUE='O'
      ORDER BY famille
    `);
    res.json(r.recordset.map(x => x.famille));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liste des marques (ARTMARQUE distinct) pour le sélecteur
router.get('/marques', async (req, res) => {
  try {
    const pool = await resolveCommercialPool(req);
    const r = await pool.request().query(`
      SELECT DISTINCT RTRIM(ARTMARQUE) AS marque
      FROM ARTICLES WITH (NOLOCK)
      WHERE ARTMARQUE IS NOT NULL
        AND LEN(RTRIM(ARTMARQUE))>0
        AND ARTISSTATISTIQUE='O'
      ORDER BY marque
    `);
    res.json(r.recordset.map(x => x.marque));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rapport CA global — Jour / Mois en cours / Année en cours × N / N-1 / N-2
router.get('/rapport-ca', async (req, res) => {
  const { repF, addRepParams } = parseRepids(req.query);
  const pr   = resolvePrCol(req.query.pr);
  const pa   = resolvePaCol(req.query.pa);
  const full = req.query.full === '1';
  // Filtre actif : 'O' (actifs seulement, défaut), 'N' (inactifs seulement), '' (tous)
  const actif = parseActif(req.query);
  const actifF = actif
    ? `AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='${actif}')`
    : '';

  const now = parseToday(req.query);
  const yn = now.getFullYear(), mn = now.getMonth() + 1, dn_day = now.getDate();

  function shiftYear(dateStr, delta) {
    const p = dateStr.split('-');
    return `${parseInt(p[0]) + delta}-${p[1]}-${p[2]}`;
  }

  // Année de référence : dérivée du paramètre annee
  const anneeQ = req.query.annee;
  let ya = yn, isExe = false, isYtdExe = false, exeStart = null, exeEnd = null;
  if (anneeQ && anneeQ !== 'ytd') {
    if (String(anneeQ).startsWith('ytd_exe:')) {
      isExe = true; isYtdExe = true;
      const parts = String(anneeQ).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else if (String(anneeQ).startsWith('exe:')) {
      isExe = true;
      const parts = String(anneeQ).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else {
      ya = parseInt(anneeQ) || yn;
    }
  }

  // Jour de référence (J) : pour ytd_exe, on reste sur aujourd'hui réel ;
  // sinon, même jour/mois que today dans l'année ya.
  const yd = isYtdExe ? yn : ya;
  const dn    = `${yd}-${pad(mn)}-${pad(dn_day)}`;
  const dn1   = `${yd-1}-${pad(mn)}-${pad(dn_day)}`;
  const dn2   = `${yd-2}-${pad(mn)}-${pad(dn_day)}`;

  // Début de mois
  const md_n  = `${yd}-${pad(mn)}-01`;
  const md_n1 = `${yd-1}-${pad(mn)}-01`;
  const md_n2 = `${yd-2}-${pad(mn)}-01`;

  // Fin de mois : YTD → jour courant ; Année complète → dernier jour du mois
  function lastDay(year, month) { return new Date(year, month, 0).getDate(); }
  const mfin_n  = full ? `${yd}-${pad(mn)}-${pad(lastDay(yd,   mn))}` : dn;
  const mfin_n1 = full ? `${yd-1}-${pad(mn)}-${pad(lastDay(yd-1, mn))}` : dn1;
  const mfin_n2 = full ? `${yd-2}-${pad(mn)}-${pad(lastDay(yd-2, mn))}` : dn2;

  const ad_n  = isExe ? exeStart : `${ya}-01-01`;
  const ad_n1 = isExe ? shiftYear(exeStart, -1) : `${ya-1}-01-01`;
  const ad_n2 = isExe ? shiftYear(exeStart, -2) : `${ya-2}-01-01`;

  let afin_n, afin_n1, afin_n2;
  if (isYtdExe) {
    // YTD exercice : du début d'exercice à aujourd'hui, N-1/N-2 shiftés
    afin_n  = dn;
    afin_n1 = dn1;
    afin_n2 = dn2;
  } else if (full) {
    afin_n  = isExe ? exeEnd                 : `${ya}-12-31`;
    afin_n1 = isExe ? shiftYear(exeEnd, -1)  : `${ya-1}-12-31`;
    afin_n2 = isExe ? shiftYear(exeEnd, -2)  : `${ya-2}-12-31`;
  } else {
    // YTD calendaire : jusqu'au jour équivalent (= dn déjà calculé ci-dessus)
    afin_n  = dn;
    afin_n1 = dn1;
    afin_n2 = dn2;
  }

  // Période glissante : toujours relative au vrai aujourd'hui (indépendante de ya)
  const glissantQ = req.query.glissant; // '30', '90', '12m'
  let gd_n, gf_n, gd_n1, gf_n1, gd_n2, gf_n2, glissantLabel;
  if (glissantQ) {
    gf_n  = `${yn}-${pad(mn)}-${pad(dn_day)}`;
    gf_n1 = `${yn-1}-${pad(mn)}-${pad(dn_day)}`;
    gf_n2 = `${yn-2}-${pad(mn)}-${pad(dn_day)}`;
    if (glissantQ === '12m') {
      const d = new Date(now); d.setFullYear(d.getFullYear() - 1); d.setDate(d.getDate() + 1);
      gd_n = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      glissantLabel = '12 derniers mois';
    } else {
      const days = parseInt(glissantQ);
      const d = new Date(now); d.setDate(d.getDate() - days + 1);
      gd_n = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      glissantLabel = `${days} derniers jours`;
    }
    gd_n1 = shiftYear(gd_n, -1);
    gd_n2 = shiftYear(gd_n, -2);
  }

  // Bornes de scan (couvrent toutes les périodes fixes + glissantes)
  const scan_start = glissantQ && gd_n2 < ad_n2 ? gd_n2 : ad_n2;
  const afin_scan  = afin_n > dn ? afin_n : dn;
  const scan_end   = glissantQ && gf_n > afin_scan ? gf_n : afin_scan;

  const num = v => parseFloat(v) || 0;
  function caS(cond)  { return `SUM(CASE WHEN ${cond} THEN ${exprCA()} ELSE 0 END)`; }
  function mgSF(cond) { return `SUM(CASE WHEN ${cond} THEN ${exprMgSf(pr)} ELSE 0 END)`; }
  function mgAF(cond) { return `SUM(CASE WHEN ${cond} THEN ${exprMgAf(pr)} ELSE 0 END)`; }

  const condJ_n  = `pv.PCVDATEEFFET=@dn`;
  const condJ_n1 = `pv.PCVDATEEFFET=@dn1`;
  const condJ_n2 = `pv.PCVDATEEFFET=@dn2`;
  const condM_n  = `pv.PCVDATEEFFET>=@md_n  AND pv.PCVDATEEFFET<=@mfin_n`;
  const condM_n1 = `pv.PCVDATEEFFET>=@md_n1 AND pv.PCVDATEEFFET<=@mfin_n1`;
  const condM_n2 = `pv.PCVDATEEFFET>=@md_n2 AND pv.PCVDATEEFFET<=@mfin_n2`;
  const condA_n  = `pv.PCVDATEEFFET>=@ad_n   AND pv.PCVDATEEFFET<=@afin_n`;
  const condA_n1 = `pv.PCVDATEEFFET>=@ad_n1  AND pv.PCVDATEEFFET<=@afin_n1`;
  const condA_n2 = `pv.PCVDATEEFFET>=@ad_n2  AND pv.PCVDATEEFFET<=@afin_n2`;
  const condG_n  = glissantQ ? `pv.PCVDATEEFFET>=@gd_n  AND pv.PCVDATEEFFET<=@gf_n`  : '1=0';
  const condG_n1 = glissantQ ? `pv.PCVDATEEFFET>=@gd_n1 AND pv.PCVDATEEFFET<=@gf_n1` : '1=0';
  const condG_n2 = glissantQ ? `pv.PCVDATEEFFET>=@gd_n2 AND pv.PCVDATEEFFET<=@gf_n2` : '1=0';

  function addParams(r) {
    r.input('dn',         sql.VarChar(10), dn);     r.input('dn1',    sql.VarChar(10), dn1);
    r.input('dn2',        sql.VarChar(10), dn2);    r.input('md_n',   sql.VarChar(10), md_n);
    r.input('md_n1',      sql.VarChar(10), md_n1);  r.input('md_n2',   sql.VarChar(10), md_n2);
    r.input('mfin_n',     sql.VarChar(10), mfin_n); r.input('mfin_n1', sql.VarChar(10), mfin_n1);
    r.input('mfin_n2',    sql.VarChar(10), mfin_n2);
    r.input('ad_n',       sql.VarChar(10), ad_n);   r.input('ad_n1',  sql.VarChar(10), ad_n1);
    r.input('ad_n2',      sql.VarChar(10), ad_n2);
    r.input('afin_n',     sql.VarChar(10), afin_n); r.input('afin_n1',sql.VarChar(10), afin_n1);
    r.input('afin_n2',    sql.VarChar(10), afin_n2);
    r.input('scan_start', sql.VarChar(10), scan_start);
    r.input('scan_end',   sql.VarChar(10), scan_end);
    if (glissantQ) {
      r.input('gd_n',  sql.VarChar(10), gd_n);  r.input('gf_n',  sql.VarChar(10), gf_n);
      r.input('gd_n1', sql.VarChar(10), gd_n1); r.input('gf_n1', sql.VarChar(10), gf_n1);
      r.input('gd_n2', sql.VarChar(10), gd_n2); r.input('gf_n2', sql.VarChar(10), gf_n2);
    }
    addRepParams(r);
    return r;
  }

  try {
    const dbsPools = await getConnPools(req.query.dbs, req.user?.database);
    // [DIAG] Log SQL params pour comparer viewer vs export
    console.log('[DIAG /rapport-ca] params:', JSON.stringify({
      annee: anneeQ, full, actif, repF, dbs: req.query.dbs,
      md_n, mfin_n, ad_n, afin_n, scan_start, scan_end
    }));
    // Requête unique : CA + marges SF/AF par fenêtre temporelle
    const SQL_ALL = `
      SELECT
        ${caS(condJ_n)} AS ca_j_n,  ${caS(condJ_n1)} AS ca_j_n1, ${caS(condJ_n2)} AS ca_j_n2,
        ${caS(condM_n)} AS ca_m_n,  ${caS(condM_n1)} AS ca_m_n1, ${caS(condM_n2)} AS ca_m_n2,
        ${caS(condA_n)} AS ca_a_n,  ${caS(condA_n1)} AS ca_a_n1, ${caS(condA_n2)} AS ca_a_n2,
        ${caS(condG_n)} AS ca_g_n,  ${caS(condG_n1)} AS ca_g_n1, ${caS(condG_n2)} AS ca_g_n2,
        ${mgSF(condJ_n)} AS sf_j_n,  ${mgSF(condJ_n1)} AS sf_j_n1, ${mgSF(condJ_n2)} AS sf_j_n2,
        ${mgSF(condM_n)} AS sf_m_n,  ${mgSF(condM_n1)} AS sf_m_n1, ${mgSF(condM_n2)} AS sf_m_n2,
        ${mgSF(condA_n)} AS sf_a_n,  ${mgSF(condA_n1)} AS sf_a_n1, ${mgSF(condA_n2)} AS sf_a_n2,
        ${mgSF(condG_n)} AS sf_g_n,  ${mgSF(condG_n1)} AS sf_g_n1, ${mgSF(condG_n2)} AS sf_g_n2,
        ${mgAF(condJ_n)} AS af_j_n,  ${mgAF(condJ_n1)} AS af_j_n1, ${mgAF(condJ_n2)} AS af_j_n2,
        ${mgAF(condM_n)} AS af_m_n,  ${mgAF(condM_n1)} AS af_m_n1, ${mgAF(condM_n2)} AS af_m_n2,
        ${mgAF(condA_n)} AS af_a_n,  ${mgAF(condA_n1)} AS af_a_n1, ${mgAF(condA_n2)} AS af_a_n2,
        ${mgAF(condG_n)} AS af_g_n,  ${mgAF(condG_n1)} AS af_g_n1, ${mgAF(condG_n2)} AS af_g_n2
      ${LINE_FROM}
      WHERE ${LINE_WHERE_FACT} ${repF} ${actifF}
        AND pv.PCVDATEEFFET >= @scan_start AND pv.PCVDATEEFFET <= @scan_end`;

    const allR = await Promise.all(dbsPools.map(({ pool }) =>
      addParams(pool.request()).query(SQL_ALL)
    ));
    const agg = sumAggRecords(allR.map(r => r.recordset[0]));
    const caAgg = agg, mgAgg = agg;

    const p = (caKeys, sfKeys, afKeys) => ({
      ca:   caKeys.map(k => num(caAgg[k])),
      mgsf: sfKeys.map(k => num(mgAgg[k])),
      mgaf: afKeys.map(k => num(mgAgg[k])),
    });

    // Labels d'années affichés : en YTD exercice, on cale sur yd (année du jour)
    // pour éviter le décalage (ex: exercice 2025 → 2026, l'utilisateur veut voir 2026 en N)
    const yLabel = isYtdExe ? yd : ya;
    // Libellés fiscaux "YYYY/YYYY" quand l'exercice chevauche 2 années calendaires
    const crossYear = isExe && exeStart && exeEnd &&
      parseInt(exeStart.split('-')[0]) !== parseInt(exeEnd.split('-')[0]);
    const yStart = crossYear ? parseInt(exeStart.split('-')[0]) : null;
    const anneesLabel = crossYear
      ? [`${yStart+1}-${yStart}`, `${yStart}-${yStart-1}`, `${yStart-1}-${yStart-2}`]
      : null;
    res.json({
      generatedAt: new Date().toISOString(),
      today: dn, pr, isFull: full, isYtdExe,
      annees:    [yLabel, yLabel-1, yLabel-2],
      anneesLabel,
      annees_g:  glissantQ ? [yn, yn-1, yn-2] : null,
      dateDebut: ad_n, dateFin: afin_n, moisFin: mfin_n,
      glissantLabel, glissantDebut: gd_n, glissantFin: gf_n,
      jour:     p(['ca_j_n','ca_j_n1','ca_j_n2'], ['sf_j_n','sf_j_n1','sf_j_n2'], ['af_j_n','af_j_n1','af_j_n2']),
      mois:     p(['ca_m_n','ca_m_n1','ca_m_n2'], ['sf_m_n','sf_m_n1','sf_m_n2'], ['af_m_n','af_m_n1','af_m_n2']),
      annee:    p(['ca_a_n','ca_a_n1','ca_a_n2'], ['sf_a_n','sf_a_n1','sf_a_n2'], ['af_a_n','af_a_n1','af_a_n2']),
      glissant: glissantQ ? p(['ca_g_n','ca_g_n1','ca_g_n2'], ['sf_g_n','sf_g_n1','sf_g_n2'], ['af_g_n','af_g_n1','af_g_n2']) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CA + marge par commercial
router.get('/rapport-ca-commerciaux', async (req, res) => {
  const pr        = resolvePrCol(req.query.pr);
  const pa        = resolvePaCol(req.query.pa);
  const full      = req.query.full === '1';
  const actifCond = (() => { const a = parseActif(req.query); return a ? ` AND t.TIRISACTIF='${a}'` : ''; })();

  const now = parseToday(req.query);
  const yn = now.getFullYear(), mn = now.getMonth() + 1, dn_day = now.getDate();
  const MOIS_FR_COURT = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

  function shiftYear(dateStr, delta) {
    const p = dateStr.split('-');
    return `${parseInt(p[0]) + delta}-${p[1]}-${p[2]}`;
  }

  const anneeQ = req.query.annee;
  let ya = yn, isExe = false, isYtdExe = false, exeStart = null, exeEnd = null;
  if (anneeQ && anneeQ !== 'ytd') {
    if (String(anneeQ).startsWith('ytd_exe:')) {
      isExe = true; isYtdExe = true;
      const parts = String(anneeQ).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else if (String(anneeQ).startsWith('exe:')) {
      isExe = true;
      const parts = String(anneeQ).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else {
      ya = parseInt(anneeQ) || yn;
    }
  }

  // Pour ytd_exe, les dates "de référence jour" sont calées sur aujourd'hui réel
  const yd = isYtdExe ? yn : ya;

  const ad_n  = isExe ? exeStart              : `${ya}-01-01`;
  const ad_n1 = isExe ? shiftYear(exeStart,-1): `${ya-1}-01-01`;
  const ad_n2 = isExe ? shiftYear(exeStart,-2): `${ya-2}-01-01`;

  let afin_n, afin_n1, afin_n2;
  if (isYtdExe) {
    afin_n  = `${yd}-${pad(mn)}-${pad(dn_day)}`;
    afin_n1 = `${yd-1}-${pad(mn)}-${pad(dn_day)}`;
    afin_n2 = `${yd-2}-${pad(mn)}-${pad(dn_day)}`;
  } else if (full) {
    afin_n  = isExe ? exeEnd                : `${ya}-12-31`;
    afin_n1 = isExe ? shiftYear(exeEnd, -1) : `${ya-1}-12-31`;
    afin_n2 = isExe ? shiftYear(exeEnd, -2) : `${ya-2}-12-31`;
  } else {
    afin_n  = ya === yn ? `${yn}-${pad(mn)}-${pad(dn_day)}` : `${ya}-${pad(mn)}-${pad(dn_day)}`;
    afin_n1 = `${ya-1}-${pad(mn)}-${pad(dn_day)}`;
    afin_n2 = `${ya-2}-${pad(mn)}-${pad(dn_day)}`;
  }

  const today = `${yn}-${pad(mn)}-${pad(dn_day)}`;

  // Mois en cours : si l'année sélectionnée est l'année courante, on prend du 1er jusqu'à aujourd'hui,
  // sinon on prend le mois complet (même numéro de mois).
  // Pour ytd_exe, on cale sur aujourd'hui réel (yd = yn).
  const mLastDay   = new Date(yd,   mn, 0).getDate();
  const mLastDayN1 = new Date(yd-1, mn, 0).getDate();
  const md_n    = `${yd}-${pad(mn)}-01`;
  const mfin_n  = yd === yn ? `${yd}-${pad(mn)}-${pad(dn_day)}` : `${yd}-${pad(mn)}-${pad(mLastDay)}`;
  const md_n1   = `${yd-1}-${pad(mn)}-01`;
  const mfin_n1 = yd === yn ? `${yd-1}-${pad(mn)}-${pad(dn_day)}` : `${yd-1}-${pad(mn)}-${pad(mLastDayN1)}`;
  const moisLabel = `${MOIS_FR_COURT[mn-1]} ${yd}`;

  const cA_n  = `pv.PCVDATEEFFET>=@ad_n  AND pv.PCVDATEEFFET<=@afin_n`;
  const cA_n1 = `pv.PCVDATEEFFET>=@ad_n1 AND pv.PCVDATEEFFET<=@afin_n1`;
  const cA_n2 = `pv.PCVDATEEFFET>=@ad_n2 AND pv.PCVDATEEFFET<=@afin_n2`;
  const cM_n  = `pv.PCVDATEEFFET>=@md_n  AND pv.PCVDATEEFFET<=@mfin_n`;
  const cM_n1 = `pv.PCVDATEEFFET>=@md_n1 AND pv.PCVDATEEFFET<=@mfin_n1`;

  function addP(r) {
    r.input('ad_n',   sql.VarChar(10), ad_n);   r.input('afin_n',  sql.VarChar(10), afin_n);
    r.input('ad_n1',  sql.VarChar(10), ad_n1);  r.input('afin_n1', sql.VarChar(10), afin_n1);
    r.input('ad_n2',  sql.VarChar(10), ad_n2);  r.input('afin_n2', sql.VarChar(10), afin_n2);
    r.input('md_n',   sql.VarChar(10), md_n);   r.input('mfin_n',  sql.VarChar(10), mfin_n);
    r.input('md_n1',  sql.VarChar(10), md_n1);  r.input('mfin_n1', sql.VarChar(10), mfin_n1);
    return r;
  }

  // Requête unique groupée par commercial : CA, marges SF/AF
  const SQL_COM_ALL = `
    SELECT
      ISNULL(t.TIRID, 0) AS tirid,
      ISNULL(RTRIM(t.TIRSOCIETE), 'Non assigné') AS nom,
      SUM(CASE WHEN ${cA_n}  THEN ${exprCA()} ELSE 0 END) AS ca_n,
      SUM(CASE WHEN ${cA_n1} THEN ${exprCA()} ELSE 0 END) AS ca_n1,
      SUM(CASE WHEN ${cA_n2} THEN ${exprCA()} ELSE 0 END) AS ca_n2,
      SUM(CASE WHEN ${cM_n}  THEN ${exprCA()} ELSE 0 END) AS ca_m_n,
      SUM(CASE WHEN ${cM_n1} THEN ${exprCA()} ELSE 0 END) AS ca_m_n1,
      SUM(CASE WHEN ${cA_n}  THEN ${exprMgSf(pr)} ELSE 0 END) AS sf_n,
      SUM(CASE WHEN ${cA_n1} THEN ${exprMgSf(pr)} ELSE 0 END) AS sf_n1,
      SUM(CASE WHEN ${cA_n2} THEN ${exprMgSf(pr)} ELSE 0 END) AS sf_n2,
      SUM(CASE WHEN ${cM_n}  THEN ${exprMgSf(pr)} ELSE 0 END) AS sf_m_n,
      SUM(CASE WHEN ${cM_n1} THEN ${exprMgSf(pr)} ELSE 0 END) AS sf_m_n1,
      SUM(CASE WHEN ${cA_n}  THEN ${exprMgAf(pr)} ELSE 0 END) AS af_n,
      SUM(CASE WHEN ${cA_n1} THEN ${exprMgAf(pr)} ELSE 0 END) AS af_n1,
      SUM(CASE WHEN ${cA_n2} THEN ${exprMgAf(pr)} ELSE 0 END) AS af_n2,
      SUM(CASE WHEN ${cM_n}  THEN ${exprMgAf(pr)} ELSE 0 END) AS af_m_n,
      SUM(CASE WHEN ${cM_n1} THEN ${exprMgAf(pr)} ELSE 0 END) AS af_m_n1
    ${LINE_FROM}
    LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID_REP AND t.TIRTYPE='R'${actifCond}
    WHERE ${LINE_WHERE_FACT}
      AND (
        (pv.PCVDATEEFFET >= @ad_n2 AND pv.PCVDATEEFFET <= @afin_n)
        OR (pv.PCVDATEEFFET >= @md_n1 AND pv.PCVDATEEFFET <= @mfin_n1)
      )
    GROUP BY t.TIRID, t.TIRSOCIETE
    ORDER BY ca_n DESC`;

  try {
    const dbsPools = await getConnPools(req.query.dbs, req.user?.database);
    const num = v => parseFloat(v) || 0;

    const allRowArrays = await Promise.all(dbsPools.map(async ({ pool }) => {
      const r = await addP(pool.request()).query(SQL_COM_ALL);
      return r.recordset.map(row => ({
        nom: row.nom,
        ca:   [num(row.ca_n),  num(row.ca_n1),  num(row.ca_n2)],
        mgsf: [num(row.sf_n), num(row.sf_n1), num(row.sf_n2)],
        mgaf: [num(row.af_n), num(row.af_n1), num(row.af_n2)],
        cam:   [num(row.ca_m_n),  num(row.ca_m_n1)],
        mgsfm: [num(row.sf_m_n), num(row.sf_m_n1)],
        mgafm: [num(row.af_m_n), num(row.af_m_n1)],
      }));
    }));

    const mergedMap = {};
    for (const rows of allRowArrays) {
      for (const r of rows) {
        const key = r.nom.trim().toLowerCase();
        if (!mergedMap[key]) mergedMap[key] = { nom: r.nom, ca: [...r.ca], mgsf: [...r.mgsf], mgaf: [...r.mgaf], cam: [...r.cam], mgsfm: [...r.mgsfm], mgafm: [...r.mgafm] };
        else {
          for (let i = 0; i < 3; i++) { mergedMap[key].ca[i] += r.ca[i]; mergedMap[key].mgsf[i] += r.mgsf[i]; mergedMap[key].mgaf[i] += r.mgaf[i]; }
          for (let i = 0; i < 2; i++) { mergedMap[key].cam[i] += r.cam[i]; mergedMap[key].mgsfm[i] += r.mgsfm[i]; mergedMap[key].mgafm[i] += r.mgafm[i]; }
        }
      }
    }
    const rows = Object.values(mergedMap).sort((a, b) => b.ca[0] - a.ca[0]);

    // Ligne total
    const sum3 = key => rows.reduce((acc, r) => [acc[0]+r[key][0], acc[1]+r[key][1], acc[2]+r[key][2]], [0,0,0]);
    const sum2 = key => rows.reduce((acc, r) => [acc[0]+r[key][0], acc[1]+r[key][1]], [0,0]);
    const total = { nom: 'TOTAL', ca: sum3('ca'), mgsf: sum3('mgsf'), mgaf: sum3('mgaf'), cam: sum2('cam'), mgsfm: sum2('mgsfm'), mgafm: sum2('mgafm') };

    // Labels d'années : alignés sur yd en YTD exercice (sinon = ya)
    const yLabel = isYtdExe ? yd : ya;
    // Libellés fiscaux "YYYY/YYYY" quand l'exercice chevauche 2 années calendaires
    const crossYear = isExe && exeStart && exeEnd &&
      parseInt(exeStart.split('-')[0]) !== parseInt(exeEnd.split('-')[0]);
    const yStart = crossYear ? parseInt(exeStart.split('-')[0]) : null;
    const anneesLabel = crossYear
      ? [`${yStart+1}-${yStart}`, `${yStart}-${yStart-1}`, `${yStart-1}-${yStart-2}`]
      : null;
    res.json({
      generatedAt: new Date().toISOString(),
      today, isFull: full, isYtdExe, pr,
      annees: [yLabel, yLabel-1, yLabel-2],
      anneesLabel,
      dateDebut: ad_n, dateFin: afin_n,
      moisLabel, moisDebut: md_n, moisFin: mfin_n,
      rows, total,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Email / Planification builtins ─────────────────────────────────────────────

const ExcelJS    = require('exceljs');
const puppeteer  = require('puppeteer');

const BUILTIN_SCHED_FILE  = path.join(__dirname, '../../data/builtin-schedules.json');
const BUILTIN_TITLES_FILE = path.join(__dirname, '../../data/builtin-titles.json');
const SETTINGS_FILE       = path.join(__dirname, '../../data/settings.json');

const DEFAULT_BUILTIN_TITLES = {
  rapport_ca: 'CA Global',
  rapport_commerciaux: 'CA par Commercial',
  rapport_reglement: 'Règlement clients',
  segmentation: 'Segmentation',
  sections: {
    rapport_ca: {
      today:     "Aujourd'hui",
      month:     'Mois en cours',
      year:      'CA Global — Année',
      evolution: 'Évolution mensuelle',
    },
    rapport_commerciaux: {
      month:        'Mois en cours',
      year:         'CA par Commercial — Année',
      distribution: 'Répartition CA',
    },
    rapport_reglement: {
      summary:    'Synthèse — DSO global',
      moyens:     'Top 20 payeurs moyens',
      mauvais:    'Top 20 mauvais payeurs',
      commerciaux:'DSO par commercial',
    },
    segmentation: {
      clients_global:  'CA HT par {dim} — {periode_n} vs {periode_n1}',
      clients_rep:     'CA par commercial — top segments ({dim}) — {periode_n}',
      articles_global: 'CA HT par {dim} — {periode_n} vs {periode_n1}',
      articles_rep:    'CA par commercial — top segments ({dim}) — {periode_n}',
    },
  },
};

const BUILTIN_SECTIONS = {
  rapport_ca: [
    { key:'today',     label:"Aujourd'hui",              icon:'📅' },
    { key:'month',     label:'Mois en cours',             icon:'📆' },
    { key:'year',      label:'CA Global — Année',         icon:'📋' },
    { key:'evolution', label:'Évolution mensuelle',       icon:'📊' },
  ],
  rapport_commerciaux: [
    { key:'month',        label:'Mois en cours',             icon:'📆' },
    { key:'year',         label:'CA par Commercial — Année', icon:'👥' },
    { key:'distribution', label:'Répartition CA',            icon:'📊' },
  ],
  rapport_reglement: [
    { key:'summary',     label:'Synthèse',                  icon:'💶' },
    { key:'moyens',      label:'Top payeurs moyens',         icon:'🟡' },
    { key:'mauvais',     label:'Top mauvais payeurs',        icon:'🔴' },
    { key:'commerciaux', label:'DSO par commercial',         icon:'👥' },
  ],
  segmentation: [
    { key:'clients_global',  label:'Clients — CA global',         icon:'📊' },
    { key:'clients_rep',     label:'Clients — par commercial',    icon:'👥' },
    { key:'articles_global', label:'Articles — CA global',        icon:'📊' },
    { key:'articles_rep',    label:'Articles — par commercial',   icon:'👥' },
  ],
};

function readBuiltinSched() {
  try { return JSON.parse(fs.readFileSync(BUILTIN_SCHED_FILE, 'utf8')); }
  catch {
    return {
      pages: ['rapport_ca', 'rapport_commerciaux'],
      periode: 'ytd', pr: 'PLVCRUMP', mg: 'sf', format: 'html',
      schedule: { enabled: false, cron: '0 8 * * 1', recipients: [] },
    };
  }
}
function writeBuiltinSched(data) {
  fs.mkdirSync(path.dirname(BUILTIN_SCHED_FILE), { recursive: true });
  fs.writeFileSync(BUILTIN_SCHED_FILE, JSON.stringify(data, null, 2));
}
function readBuiltinTitles() {
  try {
    const saved = JSON.parse(fs.readFileSync(BUILTIN_TITLES_FILE, 'utf8'));
    const sections = {
      rapport_ca:          { ...DEFAULT_BUILTIN_TITLES.sections.rapport_ca,          ...(saved.sections?.rapport_ca          || {}) },
      rapport_commerciaux: { ...DEFAULT_BUILTIN_TITLES.sections.rapport_commerciaux, ...(saved.sections?.rapport_commerciaux || {}) },
      rapport_reglement:   { ...DEFAULT_BUILTIN_TITLES.sections.rapport_reglement,   ...(saved.sections?.rapport_reglement   || {}) },
      segmentation:        { ...DEFAULT_BUILTIN_TITLES.sections.segmentation,        ...(saved.sections?.segmentation        || {}) },
    };
    return { ...DEFAULT_BUILTIN_TITLES, ...saved, sections };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_BUILTIN_TITLES)); }
}
function writeBuiltinTitles(data) {
  fs.mkdirSync(path.dirname(BUILTIN_TITLES_FILE), { recursive: true });
  fs.writeFileSync(BUILTIN_TITLES_FILE, JSON.stringify(data, null, 2));
}
function readSmtpCfg() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))?.smtp || {}; }
  catch { return {}; }
}
async function sendBuiltinEmail(recipients, subject, html) {
  const smtp = readSmtpCfg();
  if (!smtp.host || !smtp.user) throw new Error('SMTP non configuré — Paramètres > Email');
  const t = nodemailer.createTransport({
    host: smtp.host, port: parseInt(smtp.port) || 587,
    secure: smtp.secure === true || smtp.secure === 'true',
    auth: { user: smtp.user, pass: smtp.password },
    family: 4,
  });
  await t.sendMail({
    from: smtp.from || smtp.user,
    to: Array.isArray(recipients) ? recipients.join(', ') : recipients,
    subject, html,
  });
}

function emailCss() {
  return `<style>
    body{font-family:Arial,Helvetica,sans-serif;background:#f0f2f5;margin:0;padding:20px}
    .wrap{max-width:940px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.12)}
    .hdr{background:#1a237e;color:#fff;padding:14px 28px}
    .hdr h1{margin:0;font-size:18px;font-weight:700} .hdr p{margin:0;font-size:12px;opacity:.8}
    .rapport-header{background:#eef1f8;border-left:4px solid #1a237e;padding:12px 28px}
    .rapport-header h1{margin:0;font-size:20px;font-weight:700;color:#1a237e}
    .section{padding:20px 28px;border-bottom:1px solid #e8ecf0}
    .section h2{margin:0 0 4px;font-size:14px;color:#1a237e;font-weight:700;border-bottom:2px solid #e8ecf0;padding-bottom:6px}
    .sub{font-size:11px;color:#888;margin-bottom:10px}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
    th{background:#e8ecf4;color:#333;font-weight:700;padding:7px 10px;text-align:right;border-bottom:2px solid #c8d0df}
    th:first-child{text-align:left}
    td{padding:6px 10px;text-align:right;border-bottom:1px solid #eef0f4;color:#333;vertical-align:top}
    td:first-child{text-align:left;font-weight:600;color:#222;white-space:nowrap}
    .row-total td{border-top:2px solid #c8d0df;font-weight:700;background:#f0f4fb}
    .pos{color:#2e7d32} .neg{color:#c62828}
    .mg{font-size:10px;color:#888;display:block;margin-top:2px}
    .ftr{padding:14px 28px;font-size:11px;color:#aaa;text-align:center;background:#f8f9fb}
  </style>`;
}

function fmtE(n) { return new Intl.NumberFormat('fr-FR',{maximumFractionDigits:0}).format(n||0)+' €'; }
function fmtP(n) { return n!==null&&!isNaN(n) ? n.toFixed(1)+'%' : '—'; }
function evolCell(n, ref) {
  const delta = (typeof n === 'number' && typeof ref === 'number') ? (n - ref) : null;
  const pct   = ref ? (n - ref) / ref * 100 : null;
  if (delta === null && pct === null) return '—';
  const pos   = (delta ?? pct ?? 0) >= 0;
  const arrow = pos ? '▲' : '▼';
  const cls   = pos ? 'pos' : 'neg';
  const parts = [];
  if (delta !== null) parts.push(`${pos ? '+' : ''}${fmtE(delta)}`);
  if (pct   !== null) parts.push(`${pos ? '+' : ''}${pct.toFixed(1)}%`);
  return `<span class="${cls}">${arrow} ${parts.join(' · ')}</span>`;
}
function mgPct(mg, ca) { return ca>0 ? mg/ca*100 : null; }

async function buildEmailCaGlobal(pools, isFull, prCol, sec = {}, annee = null, asof = null) {
  const now = asofToDate(asof);
  const yn = now.getFullYear(), mn = now.getMonth()+1, dn = now.getDate();
  const MOIS_FR_G = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

  // Parse annee : supporte ytd_exe:d0:d1, exe:d0:d1, ou calendaire
  let ya = yn, isExe = false, isYtdExe = false, exeStart = null, exeEnd = null;
  if (annee && annee !== 'ytd') {
    if (String(annee).startsWith('ytd_exe:')) {
      isExe = true; isYtdExe = true;
      const parts = String(annee).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else if (String(annee).startsWith('exe:')) {
      isExe = true;
      const parts = String(annee).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else {
      ya = parseInt(annee) || yn;
    }
  }
  const yd = isYtdExe ? yn : ya;
  const shiftYear = (dateStr, delta) => {
    const p = dateStr.split('-');
    return `${parseInt(p[0]) + delta}-${p[1]}-${p[2]}`;
  };

  const dayStr = `${pad(mn)}-${pad(dn)}`;
  const todayStr = `${yn}-${pad(mn)}-${pad(dn)}`;

  const ad_n  = isExe ? exeStart                : `${ya}-01-01`;
  const ad_n1 = isExe ? shiftYear(exeStart, -1) : `${ya-1}-01-01`;
  const ad_n2 = isExe ? shiftYear(exeStart, -2) : `${ya-2}-01-01`;

  let afin_n, afin_n1, afin_n2;
  if (isYtdExe) {
    afin_n  = todayStr;
    afin_n1 = shiftYear(todayStr, -1);
    afin_n2 = shiftYear(todayStr, -2);
  } else if (isExe && isFull) {
    afin_n  = exeEnd;
    afin_n1 = shiftYear(exeEnd, -1);
    afin_n2 = shiftYear(exeEnd, -2);
  } else if (isExe) {
    afin_n  = todayStr;
    afin_n1 = shiftYear(todayStr, -1);
    afin_n2 = shiftYear(todayStr, -2);
  } else {
    afin_n  = isFull ? `${ya}-12-31`   : `${ya}-${dayStr}`;
    afin_n1 = isFull ? `${ya-1}-12-31` : `${ya-1}-${dayStr}`;
    afin_n2 = isFull ? `${ya-2}-12-31` : `${ya-2}-${dayStr}`;
  }

  // Today
  const jn=`${yd}-${dayStr}`, jn1=`${yd-1}-${dayStr}`, jn2=`${yd-2}-${dayStr}`;

  // Month bounds (YTD up to today) — basé sur yd (année du jour, même en ytd_exe)
  const md_n=`${yd}-${pad(mn)}-01`,  md_n1=`${yd-1}-${pad(mn)}-01`,  md_n2=`${yd-2}-${pad(mn)}-01`;
  const mfin_n=jn, mfin_n1=jn1, mfin_n2=jn2;

  const scan_start = ad_n2, scan_end = afin_n;

  const cJ_n=`pv.PCVDATEEFFET=@jn`, cJ_n1=`pv.PCVDATEEFFET=@jn1`, cJ_n2=`pv.PCVDATEEFFET=@jn2`;
  const cM_n=`pv.PCVDATEEFFET>=@md_n AND pv.PCVDATEEFFET<=@mfin_n`;
  const cM_n1=`pv.PCVDATEEFFET>=@md_n1 AND pv.PCVDATEEFFET<=@mfin_n1`;
  const cM_n2=`pv.PCVDATEEFFET>=@md_n2 AND pv.PCVDATEEFFET<=@mfin_n2`;
  const cA_n=`pv.PCVDATEEFFET>=@ad_n AND pv.PCVDATEEFFET<=@afin_n`;
  const cA_n1=`pv.PCVDATEEFFET>=@ad_n1 AND pv.PCVDATEEFFET<=@afin_n1`;
  const cA_n2=`pv.PCVDATEEFFET>=@ad_n2 AND pv.PCVDATEEFFET<=@afin_n2`;

  function addD(r) {
    r.input('jn',sql.VarChar(10),jn);           r.input('jn1',sql.VarChar(10),jn1);         r.input('jn2',sql.VarChar(10),jn2);
    r.input('md_n',sql.VarChar(10),md_n);       r.input('md_n1',sql.VarChar(10),md_n1);     r.input('md_n2',sql.VarChar(10),md_n2);
    r.input('mfin_n',sql.VarChar(10),mfin_n);   r.input('mfin_n1',sql.VarChar(10),mfin_n1); r.input('mfin_n2',sql.VarChar(10),mfin_n2);
    r.input('ad_n',sql.VarChar(10),ad_n);       r.input('ad_n1',sql.VarChar(10),ad_n1);     r.input('ad_n2',sql.VarChar(10),ad_n2);
    r.input('afin_n',sql.VarChar(10),afin_n);   r.input('afin_n1',sql.VarChar(10),afin_n1); r.input('afin_n2',sql.VarChar(10),afin_n2);
    r.input('scan_start',sql.VarChar(10),scan_start); r.input('scan_end',sql.VarChar(10),scan_end);
    return r;
  }

  // [DIAG] Log SQL params pour comparer viewer vs export
  console.log('[DIAG buildEmailCaGlobal] params:', JSON.stringify({
    annee, isFull, prCol, asof,
    md_n, mfin_n, ad_n, afin_n, scan_start, scan_end
  }));

  const allR = await Promise.all(pools.map(({ pool }) => Promise.all([
    // CA + marges (une seule requête)
    addD(pool.request()).query(`
      SELECT
        SUM(CASE WHEN ${cJ_n}  THEN ${exprCA()} ELSE 0 END) AS ca_j_n,
        SUM(CASE WHEN ${cJ_n1} THEN ${exprCA()} ELSE 0 END) AS ca_j_n1,
        SUM(CASE WHEN ${cJ_n2} THEN ${exprCA()} ELSE 0 END) AS ca_j_n2,
        SUM(CASE WHEN ${cM_n}  THEN ${exprCA()} ELSE 0 END) AS ca_m_n,
        SUM(CASE WHEN ${cM_n1} THEN ${exprCA()} ELSE 0 END) AS ca_m_n1,
        SUM(CASE WHEN ${cM_n2} THEN ${exprCA()} ELSE 0 END) AS ca_m_n2,
        SUM(CASE WHEN ${cA_n}  THEN ${exprCA()} ELSE 0 END) AS ca_n,
        SUM(CASE WHEN ${cA_n1} THEN ${exprCA()} ELSE 0 END) AS ca_n1,
        SUM(CASE WHEN ${cA_n2} THEN ${exprCA()} ELSE 0 END) AS ca_n2,
        SUM(CASE WHEN ${cJ_n}  THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_j_n,
        SUM(CASE WHEN ${cJ_n1} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_j_n1,
        SUM(CASE WHEN ${cJ_n2} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_j_n2,
        SUM(CASE WHEN ${cM_n}  THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_m_n,
        SUM(CASE WHEN ${cM_n1} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_m_n1,
        SUM(CASE WHEN ${cM_n2} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_m_n2,
        SUM(CASE WHEN ${cA_n}  THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_n,
        SUM(CASE WHEN ${cA_n1} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_n1,
        SUM(CASE WHEN ${cA_n2} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_n2,
        SUM(CASE WHEN ${cJ_n}  THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_j_n,
        SUM(CASE WHEN ${cJ_n1} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_j_n1,
        SUM(CASE WHEN ${cJ_n2} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_j_n2,
        SUM(CASE WHEN ${cM_n}  THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_m_n,
        SUM(CASE WHEN ${cM_n1} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_m_n1,
        SUM(CASE WHEN ${cM_n2} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_m_n2,
        SUM(CASE WHEN ${cA_n}  THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_n,
        SUM(CASE WHEN ${cA_n1} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_n1,
        SUM(CASE WHEN ${cA_n2} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_n2
      ${LINE_FROM}
      WHERE ${LINE_WHERE_FACT}
        AND pv.PCVDATEEFFET>=@scan_start AND pv.PCVDATEEFFET<=@scan_end`),
    // Monthly CA for bar chart
    pool.request()
      .input('bc_ad_n',sql.VarChar(10),ad_n).input('bc_afin_n',sql.VarChar(10),afin_n)
      .input('bc_ad_n1',sql.VarChar(10),ad_n1).input('bc_afin_n1',sql.VarChar(10),afin_n1)
      .query(`
        SELECT MONTH(pv.PCVDATEEFFET) AS mois,
               CASE WHEN pv.PCVDATEEFFET>=@bc_ad_n AND pv.PCVDATEEFFET<=@bc_afin_n THEN 'n' ELSE 'n1' END AS periode,
               SUM(${exprCA()}) AS ca
        ${LINE_FROM}
        WHERE ${LINE_WHERE_FACT}
          AND ((pv.PCVDATEEFFET>=@bc_ad_n AND pv.PCVDATEEFFET<=@bc_afin_n)
            OR (pv.PCVDATEEFFET>=@bc_ad_n1 AND pv.PCVDATEEFFET<=@bc_afin_n1))
        GROUP BY MONTH(pv.PCVDATEEFFET),
          CASE WHEN pv.PCVDATEEFFET>=@bc_ad_n AND pv.PCVDATEEFFET<=@bc_afin_n THEN 'n' ELSE 'n1' END`),
  ])));

  const num = v => parseFloat(v)||0;
  // Après fusion CA+marges : allR = [[aggResult, monthlyResult], ...]
  const agg = sumAggRecords(allR.map(([r]) => r.recordset[0]));
  const ca = agg, mg = agg;

  // Merge monthly chart data across pools
  const bcMap = {};
  for (const [,mr] of allR) {
    for (const row of mr.recordset) {
      const key = `${row.periode}-${row.mois}`;
      bcMap[key] = (bcMap[key]||0) + (parseFloat(row.ca)||0);
    }
  }
  // Mois du graphique : itère du début à la fin de la période N (fiscal ou calendaire)
  const monthLabels=[], monthN=[], monthN1=[];
  const iter = new Date(ad_n + 'T00:00:00');
  const endIter = new Date(afin_n + 'T00:00:00');
  while (iter <= endIter) {
    const m = iter.getMonth() + 1, y = iter.getFullYear();
    // Label avec année courte si l'exercice chevauche 2 années calendaires
    const crossYear = isExe && exeStart && exeEnd && parseInt(exeStart.split('-')[0]) !== parseInt(exeEnd.split('-')[0]);
    monthLabels.push(crossYear ? `${MOIS_COURT[m-1]} ${String(y).slice(2)}` : MOIS_COURT[m-1]);
    monthN.push(bcMap[`n-${m}`] || 0);
    monthN1.push(bcMap[`n1-${m}`] || 0);
    iter.setMonth(iter.getMonth() + 1);
  }

  // Libellés de l'exercice (affichage)
  const crossYear = isExe && exeStart && exeEnd && parseInt(exeStart.split('-')[0]) !== parseInt(exeEnd.split('-')[0]);
  const exeLabelN  = crossYear ? `${ya+1}-${ya}`   : String(ya);
  const exeLabelN1 = crossYear ? `${ya}-${ya-1}`   : String(ya-1);
  const exeLabelN2 = crossYear ? `${ya-1}-${ya-2}` : String(ya-2);

  const _df = getServerDateFormat();
  const periodLabel = isExe
    ? (isYtdExe ? `Exercice ${exeLabelN} — YTD au ${pad(dn)}/${pad(mn)}/${yn}` : `Exercice ${exeLabelN} — ${formatISODate(ad_n, _df)} → ${formatISODate(afin_n, _df)}`)
    : (isFull   ? `${ya} — Année complète` : `${ya} — YTD au ${pad(dn)}/${pad(mn)}`);
  const nomMois = MOIS_FR_G[mn-1];
  const todayFmt = `${pad(dn)}/${pad(mn)}/${yn}`;

  function sectionTable(title, icon, sub, c, s, a) {
    const [ca0,ca1,ca2]=c, [sf0,sf1,sf2]=s, [af0,af1,af2]=a;
    return `
    <div class="section">
      <h2>${icon} ${title}</h2>
      <div class="sub">${sub}</div>
      <table>
        <thead><tr><th></th><th>${exeLabelN} (N)</th><th>${exeLabelN1} (N-1)</th><th>Évol N/N-1</th><th>${exeLabelN2} (N-2)</th><th>Évol N/N-2</th></tr></thead>
        <tbody>
          <tr><td>CA HT</td><td>${fmtE(ca0)}</td><td>${fmtE(ca1)}</td><td>${evolCell(ca0,ca1)}</td><td>${fmtE(ca2)}</td><td>${evolCell(ca0,ca2)}</td></tr>
          <tr><td>Marge SF</td>
            <td>${fmtE(sf0)}<span class="mg">${fmtP(mgPct(sf0,ca0))}</span></td>
            <td>${fmtE(sf1)}<span class="mg">${fmtP(mgPct(sf1,ca1))}</span></td>
            <td>${evolCell(sf0,sf1)}</td>
            <td>${fmtE(sf2)}<span class="mg">${fmtP(mgPct(sf2,ca2))}</span></td>
            <td>${evolCell(sf0,sf2)}</td>
          </tr>
          <tr class="row-total"><td>Marge AF</td>
            <td>${fmtE(af0)}<span class="mg">${fmtP(mgPct(af0,ca0))}</span></td>
            <td>${fmtE(af1)}<span class="mg">${fmtP(mgPct(af1,ca1))}</span></td>
            <td>${evolCell(af0,af1)}</td>
            <td>${fmtE(af2)}<span class="mg">${fmtP(mgPct(af2,ca2))}</span></td>
            <td>${evolCell(af0,af2)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
  }

  const chartId = `bar_${Date.now()}`;
  const chartData = {
    labels: monthLabels,
    datasets: [
      { label: exeLabelN,   data: monthN,  backgroundColor: '#2196F3', borderRadius: 4 },
      { label: exeLabelN1,  data: monthN1, backgroundColor: '#4CAF5080', borderRadius: 4 },
    ]
  };

  return `
    ${sectionTable(sec.today     || "Aujourd'hui",        '📅', todayFmt,
      [num(ca.ca_j_n),num(ca.ca_j_n1),num(ca.ca_j_n2)],
      [num(mg.sf_j_n),num(mg.sf_j_n1),num(mg.sf_j_n2)],
      [num(mg.af_j_n),num(mg.af_j_n1),num(mg.af_j_n2)])}
    ${sectionTable(sec.month     || 'Mois en cours',      '📆', `${nomMois} ${yn}`,
      [num(ca.ca_m_n),num(ca.ca_m_n1),num(ca.ca_m_n2)],
      [num(mg.sf_m_n),num(mg.sf_m_n1),num(mg.sf_m_n2)],
      [num(mg.af_m_n),num(mg.af_m_n1),num(mg.af_m_n2)])}
    ${sectionTable(
      // Suffixe le titre user selon le mode pour aligner avec le viewer
      // (Exercice en cours (YTD) / Exercice complet / Année calendaire)
      (sec.year || (isExe ? 'Exercice' : 'CA Global — Année'))
        + (isYtdExe ? ' (YTD)' : (isExe ? ' (Exercice complet)' : '')),
      '📋', periodLabel,
      [num(ca.ca_n),num(ca.ca_n1),num(ca.ca_n2)],
      [num(mg.sf_n),num(mg.sf_n1),num(mg.sf_n2)],
      [num(mg.af_n),num(mg.af_n1),num(mg.af_n2)])}
    <div class="section">
      <h2>📊 ${sec.evolution || 'Évolution mensuelle'} — ${exeLabelN}</h2>
      <div class="sub">${periodLabel}</div>
      <div style="display:flex;justify-content:center;padding:12px 0">
        <canvas id="${chartId}" width="600" height="280"></canvas>
      </div>
      <script>
        (function(){
          var ctx = document.getElementById('${chartId}');
          if (!ctx || typeof Chart === 'undefined') return;
          new Chart(ctx, { type:'bar', data: ${JSON.stringify(chartData)},
            options:{
              plugins:{ legend:{ labels:{ color:'#e2e8f0' } } },
              scales:{
                x:{ ticks:{ color:'#8892a4' }, grid:{ color:'#2a2d3e' } },
                y:{ ticks:{ color:'#8892a4' }, grid:{ color:'#2a2d3e' } }
              }
            }
          });
        })();
      </script>
    </div>`;
}

async function buildEmailCaCommerciaux(pools, isFull, prCol, mgType, sec = {}, annee = null, asof = null) {
  const now = asofToDate(asof);
  const yn = now.getFullYear(), mn = now.getMonth()+1, dn = now.getDate();
  const MOIS_FR = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

  // Parse annee : supporte ytd_exe:d0:d1, exe:d0:d1
  let ya = yn, isExe = false, isYtdExe = false, exeStart = null, exeEnd = null;
  if (annee && annee !== 'ytd') {
    if (String(annee).startsWith('ytd_exe:')) {
      isExe = true; isYtdExe = true;
      const parts = String(annee).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else if (String(annee).startsWith('exe:')) {
      isExe = true;
      const parts = String(annee).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else {
      ya = parseInt(annee) || yn;
    }
  }
  const yd = isYtdExe ? yn : ya;
  const shiftYear = (dateStr, delta) => {
    const p = dateStr.split('-');
    return `${parseInt(p[0]) + delta}-${p[1]}-${p[2]}`;
  };

  const dayStr = `${pad(mn)}-${pad(dn)}`;
  const todayStr = `${yn}-${pad(mn)}-${pad(dn)}`;
  const ad_n  = isExe ? exeStart                : `${ya}-01-01`;
  const ad_n1 = isExe ? shiftYear(exeStart, -1) : `${ya-1}-01-01`;
  let afin_n, afin_n1;
  if (isYtdExe) {
    afin_n  = todayStr;
    afin_n1 = shiftYear(todayStr, -1);
  } else if (isExe && isFull) {
    afin_n  = exeEnd;
    afin_n1 = shiftYear(exeEnd, -1);
  } else if (isExe) {
    afin_n  = todayStr;
    afin_n1 = shiftYear(todayStr, -1);
  } else {
    afin_n  = isFull ? `${ya}-12-31`   : `${ya}-${dayStr}`;
    afin_n1 = isFull ? `${ya-1}-12-31` : `${ya-1}-${dayStr}`;
  }

  // Mois en cours — basé sur yd (année du jour, même en ytd_exe)
  const mLastDay   = new Date(yd, mn, 0).getDate();
  const mLastDayN1 = new Date(yd-1, mn, 0).getDate();
  const md_n    = `${yd}-${pad(mn)}-01`;
  const mfin_n  = `${yd}-${pad(mn)}-${pad(dn)}`;
  const md_n1   = `${yd-1}-${pad(mn)}-01`;
  const mfin_n1 = `${yd-1}-${pad(mn)}-${pad(dn)}`;
  // Libellé du mois en cours = mois calendaire courant (toujours yn, jamais yd
   // qui peut être l'année de début d'exercice et donc différer)
  const moisLabel = `${MOIS_FR[mn-1]} ${yn}`;
  const crossYear = isExe && exeStart && exeEnd && parseInt(exeStart.split('-')[0]) !== parseInt(exeEnd.split('-')[0]);
  const exeLabelN  = crossYear ? `${ya+1}-${ya}` : String(ya);
  const exeLabelN1 = crossYear ? `${ya}-${ya-1}` : String(ya-1);

  function addD(r) {
    r.input('ad_n',sql.VarChar(10),ad_n);     r.input('afin_n',sql.VarChar(10),afin_n);
    r.input('ad_n1',sql.VarChar(10),ad_n1);   r.input('afin_n1',sql.VarChar(10),afin_n1);
    r.input('md_n',sql.VarChar(10),md_n);     r.input('mfin_n',sql.VarChar(10),mfin_n);
    r.input('md_n1',sql.VarChar(10),md_n1);   r.input('mfin_n1',sql.VarChar(10),mfin_n1);
    return r;
  }

  const cN   = `pv.PCVDATEEFFET>=@ad_n   AND pv.PCVDATEEFFET<=@afin_n`;
  const cN1  = `pv.PCVDATEEFFET>=@ad_n1  AND pv.PCVDATEEFFET<=@afin_n1`;
  const cMN  = `pv.PCVDATEEFFET>=@md_n   AND pv.PCVDATEEFFET<=@mfin_n`;
  const cMN1 = `pv.PCVDATEEFFET>=@md_n1  AND pv.PCVDATEEFFET<=@mfin_n1`;
  const mgLabel = mgType === 'af' ? 'AF' : 'SF';
  const mgExprFn = mgType === 'af' ? exprMgAf : exprMgSf;

  const num = v => parseFloat(v)||0;
  const allRowArrays = await Promise.all(pools.map(async ({ pool }) => {
    // Requête unique : CA + marges
    const res = await addD(pool.request()).query(`
        SELECT ISNULL(t.TIRID,0) AS tirid, ISNULL(RTRIM(t.TIRSOCIETE),'Non assigné') AS nom,
          SUM(CASE WHEN ${cN}   THEN ${exprCA()} ELSE 0 END) AS ca_n,
          SUM(CASE WHEN ${cN1}  THEN ${exprCA()} ELSE 0 END) AS ca_n1,
          SUM(CASE WHEN ${cMN}  THEN ${exprCA()} ELSE 0 END) AS ca_m_n,
          SUM(CASE WHEN ${cMN1} THEN ${exprCA()} ELSE 0 END) AS ca_m_n1,
          SUM(CASE WHEN ${cN}   THEN ${mgExprFn(prCol)} ELSE 0 END) AS mg_n,
          SUM(CASE WHEN ${cN1}  THEN ${mgExprFn(prCol)} ELSE 0 END) AS mg_n1,
          SUM(CASE WHEN ${cMN}  THEN ${mgExprFn(prCol)} ELSE 0 END) AS mg_m_n,
          SUM(CASE WHEN ${cMN1} THEN ${mgExprFn(prCol)} ELSE 0 END) AS mg_m_n1
        ${LINE_FROM}
        LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID_REP AND t.TIRTYPE='R' AND t.TIRISACTIF='O'
        WHERE ${LINE_WHERE_FACT}
          AND (
            (pv.PCVDATEEFFET>=@ad_n1 AND pv.PCVDATEEFFET<=@afin_n)
            OR (pv.PCVDATEEFFET>=@md_n1 AND pv.PCVDATEEFFET<=@mfin_n1)
          )
        GROUP BY t.TIRID,t.TIRSOCIETE ORDER BY ca_n DESC`);
    return res.recordset.map(r => ({
      nom:  r.nom,
      ca:   [num(r.ca_n),   num(r.ca_n1)],
      mg:   [num(r.mg_n),   num(r.mg_n1)],
      cam:  [num(r.ca_m_n), num(r.ca_m_n1)],
      mgm:  [num(r.mg_m_n), num(r.mg_m_n1)],
    }));
  }));

  const mergedMap = {};
  for (const rows of allRowArrays) {
    for (const r of rows) {
      const key = r.nom.trim().toLowerCase();
      if (!mergedMap[key]) mergedMap[key] = { nom: r.nom, ca: [...r.ca], mg: [...r.mg], cam: [...r.cam], mgm: [...r.mgm] };
      else {
        mergedMap[key].ca[0]  += r.ca[0];  mergedMap[key].ca[1]  += r.ca[1];
        mergedMap[key].mg[0]  += r.mg[0];  mergedMap[key].mg[1]  += r.mg[1];
        mergedMap[key].cam[0] += r.cam[0]; mergedMap[key].cam[1] += r.cam[1];
        mergedMap[key].mgm[0] += r.mgm[0]; mergedMap[key].mgm[1] += r.mgm[1];
      }
    }
  }
  const rows = Object.values(mergedMap).sort((a, b) => b.ca[0] - a.ca[0]);

  const sumK  = key => rows.reduce((acc,r)=>[acc[0]+r[key][0],acc[1]+r[key][1]],[0,0]);
  const total = { nom:'TOTAL', ca:sumK('ca'), mg:sumK('mg'), cam:sumK('cam'), mgm:sumK('mgm') };

  function rowE(r, isTotal) {
    const [ca0,ca1]=r.ca, [mg0,mg1]=r.mg;
    return `<tr class="${isTotal?'row-total':''}">
      <td>${r.nom}</td>
      <td>${fmtE(ca0)}</td>
      <td>${fmtE(mg0)}<span class="mg">${fmtP(mgPct(mg0,ca0))}</span></td>
      <td>${fmtE(ca1)}</td>
      <td>${fmtE(mg1)}<span class="mg">${fmtP(mgPct(mg1,ca1))}</span></td>
      <td>${evolCell(ca0,ca1)}</td>
      <td>${evolCell(mg0,mg1)}</td>
    </tr>`;
  }

  function rowM(r, isTotal) {
    const [ca0,ca1]=r.cam, [mg0,mg1]=r.mgm;
    return `<tr class="${isTotal?'row-total':''}">
      <td>${r.nom}</td>
      <td>${fmtE(ca0)}</td>
      <td>${fmtE(mg0)}<span class="mg">${fmtP(mgPct(mg0,ca0))}</span></td>
      <td>${fmtE(ca1)}</td>
      <td>${fmtE(mg1)}<span class="mg">${fmtP(mgPct(mg1,ca1))}</span></td>
      <td>${evolCell(ca0,ca1)}</td>
      <td>${evolCell(mg0,mg1)}</td>
    </tr>`;
  }

  const periodLabel = isFull ? `${exeLabelN} — Année complète` : `${exeLabelN} — YTD au ${pad(dn)}/${pad(mn)}/${yn}`;

  // Pie chart data (top 12 by annual CA N)
  const PIE_COLORS = ['#2196F3','#4CAF50','#FF9800','#9C27B0','#F44336','#00BCD4','#FF5722','#8BC34A','#E91E63','#03A9F4','#CDDC39','#795548'];
  const top12 = rows.filter(r=>r.ca[0]>0).slice(0,12);
  const totalCa = top12.reduce((s,r)=>s+r.ca[0],0);
  const chartId = `pie_${Date.now()}`;
  const chartData = {
    labels: top12.map(r => r.nom),
    datasets: [{ data: top12.map(r => r.ca[0]), backgroundColor: top12.map((_,i) => PIE_COLORS[i % PIE_COLORS.length]), borderColor: '#1a1d2e', borderWidth: 2 }]
  };

  return `
    <div class="section">
      <h2>📆 ${sec.month || 'Mois en cours'} — ${moisLabel}</h2>
      <div class="sub">${moisLabel} · Marge ${mgLabel}</div>
      <table>
        <thead><tr>
          <th>Commercial</th>
          <th>CA ${moisLabel}</th><th>Mg ${mgLabel}</th>
          <th>CA ${MOIS_FR[mn-1]} ${yn-1}</th><th>Mg ${mgLabel}</th>
          <th>Évol CA</th><th>Évol Mg</th>
        </tr></thead>
        <tbody>
          ${[...rows].sort((a,b)=>b.cam[0]-a.cam[0]).map(r=>rowM(r,false)).join('')}
          ${rowM(total,true)}
        </tbody>
      </table>
    </div>
    <div class="section">
      <h2>👥 ${sec.year || 'CA par Commercial — Année'}</h2>
      <div class="sub">${periodLabel} · Marge ${mgLabel}</div>
      <table>
        <thead><tr>
          <th>Commercial</th>
          <th>CA ${exeLabelN} (N)</th><th>Mg ${mgLabel} (N)</th>
          <th>CA ${exeLabelN1} (N-1)</th><th>Mg ${mgLabel} (N-1)</th>
          <th>Évol CA N/N-1</th><th>Évol Mg N/N-1</th>
        </tr></thead>
        <tbody>
          ${rows.map(r=>rowE(r,false)).join('')}
          ${rowE(total,true)}
        </tbody>
      </table>
    </div>
    <div class="section">
      <h2>📊 ${sec.distribution || 'Répartition CA'} — ${exeLabelN}</h2>
      <div class="sub">${periodLabel}</div>
      <div style="text-align:center;padding:12px 0">
        <div style="display:inline-block;width:346px;height:432px">
          <canvas id="${chartId}"></canvas>
        </div>
      </div>
      <script>
        (function(){
          var ctx = document.getElementById('${chartId}');
          if (!ctx || typeof Chart === 'undefined') return;
          new Chart(ctx, { type:'doughnut', data: ${JSON.stringify(chartData)},
            options:{ responsive:true, maintainAspectRatio:false,
              plugins:{ legend:{ position:'bottom', labels:{ color:'#1a237e', font:{size:13,weight:'600'}, boxWidth:16, padding:10 } } } }
          });
        })();
      </script>
    </div>`;
}

async function buildBuiltinExcel(config) {
  const { pages=['rapport_ca','rapport_commerciaux'], periode='ytd', annee=null, pr='PLVCRUMP', mg='sf', dbs, asof=null, _userDatabase=null, _userConnId=null, _societe=null } = config;
  const isFull = periode === 'full';
  const prCol  = resolvePrCol(pr);
  const mgLabel = mg === 'af' ? 'AF' : 'SF';
  const pools  = await getConnPools(dbs, { database: _userDatabase, connId: _userConnId });
  // Multi-base : concatène les sociétés de chaque pool. _societe (req.user.societe) ne s'applique que mono-base.
  const societes = pools.length === 1 && _societe
    ? [_societe]
    : (await Promise.all(pools.map(p => fetchSocieteFromPool(p.pool)))).filter(Boolean);
  const societeLabel = societes.join(' / ');
  const societePrefix = societeLabel ? `${societeLabel} — ` : '';
  const titles = readBuiltinTitles();
  const titleCA  = societePrefix + (titles.rapport_ca          || 'CA Global');
  const titleCOM = societePrefix + (titles.rapport_commerciaux || 'CA par Commercial');
  const secCA    = titles.sections?.rapport_ca          || {};
  const secCOM   = titles.sections?.rapport_commerciaux || {};
  const usedSheetNames = new Set();
  const shName = (s) => {
    let name = s.replace(/[*?:/\\[\]]/g,'').trim();
    // Titre > 31 chars avec séparateur ' - ' : garde la dernière partie (la section)
    // pour éviter que toutes les feuilles partagent le même préfixe tronqué.
    if (name.length > 31 && name.includes(' - ')) {
      const tail = name.split(' - ').pop().trim();
      if (tail.length >= 3) name = tail;
    }
    name = name.slice(0, 31) || 'Feuille';
    // Dédup case-insensitive (ExcelJS rejette les doublons non sensibles à la casse)
    if (!usedSheetNames.has(name.toLowerCase())) {
      usedSheetNames.add(name.toLowerCase());
      return name;
    }
    const base = name.slice(0, 28);
    let n = 2;
    while (usedSheetNames.has(`${base} ${n}`.toLowerCase())) n++;
    const out = `${base} ${n}`;
    usedSheetNames.add(out.toLowerCase());
    return out;
  };
  const now = asofToDate(asof);
  const yn = now.getFullYear(), mn = now.getMonth()+1, dn = now.getDate();

  // Parse annee : supporte ytd_exe:d0:d1 / exe:d0:d1 / année calendaire / null
  let ya = yn, isExe = false, isYtdExe = false, exeStart = null, exeEnd = null;
  if (annee && annee !== 'ytd') {
    if (String(annee).startsWith('ytd_exe:')) {
      isExe = true; isYtdExe = true;
      const parts = String(annee).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else if (String(annee).startsWith('exe:')) {
      isExe = true;
      const parts = String(annee).split(':');
      exeStart = parts[1]; exeEnd = parts[2];
      ya = parseInt(exeStart.split('-')[0]);
    } else {
      ya = parseInt(annee) || yn;
    }
  }
  const dayStr = `${pad(mn)}-${pad(dn)}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'TB Reporting';
  wb.created = now;

  const headerFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1A237E' } };
  const headerFont = { bold:true, color:{ argb:'FFFFFFFF' }, size:10 };
  const totalFill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE8ECF4' } };
  const totalFont  = { bold:true, size:10 };
  const numFmt     = '#,##0';
  const pctFmt     = '0.0"%"';
  const borderThin = { style:'thin', color:{ argb:'FFC8D0DF' } };
  const border     = { top:borderThin, left:borderThin, bottom:borderThin, right:borderThin };

  function setHeader(ws, cols) {
    const row = ws.addRow(cols.map(c => c.header));
    row.eachCell(cell => {
      cell.fill = headerFill; cell.font = headerFont;
      cell.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
      cell.border = border;
    });
    ws.columns = cols;
    ws.getRow(1).height = 28;
  }

  // ── Sheets: CA Global (Année + Mois en cours + Aujourd'hui) ─────────────────
  if (pages.includes('rapport_ca')) {
    const yd = isYtdExe ? yn : ya;
    const shiftYear = (dateStr, delta) => {
      const p = dateStr.split('-');
      return `${parseInt(p[0]) + delta}-${p[1]}-${p[2]}`;
    };
    const todayStr = `${yn}-${pad(mn)}-${pad(dn)}`;
    const ad_n  = isExe ? exeStart                : `${ya}-01-01`;
    const ad_n1 = isExe ? shiftYear(exeStart, -1) : `${ya-1}-01-01`;
    const ad_n2 = isExe ? shiftYear(exeStart, -2) : `${ya-2}-01-01`;
    let afin_n, afin_n1, afin_n2;
    if (isYtdExe) {
      afin_n  = todayStr;
      afin_n1 = shiftYear(todayStr, -1);
      afin_n2 = shiftYear(todayStr, -2);
    } else if (isExe && isFull) {
      afin_n  = exeEnd;
      afin_n1 = shiftYear(exeEnd, -1);
      afin_n2 = shiftYear(exeEnd, -2);
    } else if (isExe) {
      afin_n  = todayStr;
      afin_n1 = shiftYear(todayStr, -1);
      afin_n2 = shiftYear(todayStr, -2);
    } else {
      afin_n  = isFull ? `${ya}-12-31`   : `${ya}-${dayStr}`;
      afin_n1 = isFull ? `${ya-1}-12-31` : `${ya-1}-${dayStr}`;
      afin_n2 = isFull ? `${ya-2}-12-31` : `${ya-2}-${dayStr}`;
    }
    const jn=`${yd}-${dayStr}`, jn1=`${yd-1}-${dayStr}`, jn2=`${yd-2}-${dayStr}`;
    const md_n=`${yd}-${pad(mn)}-01`, md_n1=`${yd-1}-${pad(mn)}-01`, md_n2=`${yd-2}-${pad(mn)}-01`;
    const mfin_n=jn, mfin_n1=jn1, mfin_n2=jn2;
    const scan_start=ad_n2, scan_end=afin_n > jn ? afin_n : jn;

    const cJ_n=`pv.PCVDATEEFFET=@jn`,   cJ_n1=`pv.PCVDATEEFFET=@jn1`,   cJ_n2=`pv.PCVDATEEFFET=@jn2`;
    const cM_n=`pv.PCVDATEEFFET>=@md_n AND pv.PCVDATEEFFET<=@mfin_n`;
    const cM_n1=`pv.PCVDATEEFFET>=@md_n1 AND pv.PCVDATEEFFET<=@mfin_n1`;
    const cM_n2=`pv.PCVDATEEFFET>=@md_n2 AND pv.PCVDATEEFFET<=@mfin_n2`;
    const cA_n=`pv.PCVDATEEFFET>=@ad_n AND pv.PCVDATEEFFET<=@afin_n`;
    const cA_n1=`pv.PCVDATEEFFET>=@ad_n1 AND pv.PCVDATEEFFET<=@afin_n1`;
    const cA_n2=`pv.PCVDATEEFFET>=@ad_n2 AND pv.PCVDATEEFFET<=@afin_n2`;
    function addDG(r) {
      r.input('jn',sql.VarChar(10),jn);       r.input('jn1',sql.VarChar(10),jn1);      r.input('jn2',sql.VarChar(10),jn2);
      r.input('md_n',sql.VarChar(10),md_n);   r.input('md_n1',sql.VarChar(10),md_n1);  r.input('md_n2',sql.VarChar(10),md_n2);
      r.input('mfin_n',sql.VarChar(10),mfin_n); r.input('mfin_n1',sql.VarChar(10),mfin_n1); r.input('mfin_n2',sql.VarChar(10),mfin_n2);
      r.input('ad_n',sql.VarChar(10),ad_n);   r.input('ad_n1',sql.VarChar(10),ad_n1);  r.input('ad_n2',sql.VarChar(10),ad_n2);
      r.input('afin_n',sql.VarChar(10),afin_n); r.input('afin_n1',sql.VarChar(10),afin_n1); r.input('afin_n2',sql.VarChar(10),afin_n2);
      r.input('scan_start',sql.VarChar(10),scan_start); r.input('scan_end',sql.VarChar(10),scan_end);
      return r;
    }
    const allRG = await Promise.all(pools.map(({ pool }) =>
      addDG(pool.request()).query(`
        SELECT
          SUM(CASE WHEN ${cJ_n}  THEN ${exprCA()} ELSE 0 END) AS ca_j_n,
          SUM(CASE WHEN ${cJ_n1} THEN ${exprCA()} ELSE 0 END) AS ca_j_n1,
          SUM(CASE WHEN ${cJ_n2} THEN ${exprCA()} ELSE 0 END) AS ca_j_n2,
          SUM(CASE WHEN ${cM_n}  THEN ${exprCA()} ELSE 0 END) AS ca_m_n,
          SUM(CASE WHEN ${cM_n1} THEN ${exprCA()} ELSE 0 END) AS ca_m_n1,
          SUM(CASE WHEN ${cM_n2} THEN ${exprCA()} ELSE 0 END) AS ca_m_n2,
          SUM(CASE WHEN ${cA_n}  THEN ${exprCA()} ELSE 0 END) AS ca_n,
          SUM(CASE WHEN ${cA_n1} THEN ${exprCA()} ELSE 0 END) AS ca_n1,
          SUM(CASE WHEN ${cA_n2} THEN ${exprCA()} ELSE 0 END) AS ca_n2,
          SUM(CASE WHEN ${cJ_n}  THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_j_n,
          SUM(CASE WHEN ${cJ_n1} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_j_n1,
          SUM(CASE WHEN ${cJ_n2} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_j_n2,
          SUM(CASE WHEN ${cM_n}  THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_m_n,
          SUM(CASE WHEN ${cM_n1} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_m_n1,
          SUM(CASE WHEN ${cM_n2} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_m_n2,
          SUM(CASE WHEN ${cA_n}  THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_n,
          SUM(CASE WHEN ${cA_n1} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_n1,
          SUM(CASE WHEN ${cA_n2} THEN ${exprMgSf(prCol)} ELSE 0 END) AS sf_n2,
          SUM(CASE WHEN ${cJ_n}  THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_j_n,
          SUM(CASE WHEN ${cJ_n1} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_j_n1,
          SUM(CASE WHEN ${cJ_n2} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_j_n2,
          SUM(CASE WHEN ${cM_n}  THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_m_n,
          SUM(CASE WHEN ${cM_n1} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_m_n1,
          SUM(CASE WHEN ${cM_n2} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_m_n2,
          SUM(CASE WHEN ${cA_n}  THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_n,
          SUM(CASE WHEN ${cA_n1} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_n1,
          SUM(CASE WHEN ${cA_n2} THEN ${exprMgAf(prCol)} ELSE 0 END) AS af_n2
        ${LINE_FROM}
        WHERE ${LINE_WHERE_FACT}
          AND pv.PCVDATEEFFET>=@scan_start AND pv.PCVDATEEFFET<=@scan_end`)
    ));

    const num = v => parseFloat(v)||0;
    const aggG = sumAggRecords(allRG.map(r => r.recordset[0]));
    const caG = aggG, mgdG = aggG;
    const periodLabel = isFull ? `${ya} — Année complète` : `${ya} — YTD au ${pad(dn)}/${pad(mn)}`;
    const MOIS_XL_G = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
    const moisLblG = `${MOIS_XL_G[mn-1]} ${ya}`;
    const todayLblG = `${pad(dn)}/${pad(mn)}/${ya}`;

    // Layout aligné sur l'export HTML : 1 ligne par mesure (CA HT / Marge SF / Marge AF)
    // Colonnes : N | % | N-1 | % | Évol € N/N-1 | Évol % N/N-1 | N-2 | % | Évol € N/N-2 | Évol % N/N-2
    const globalCols = [
      { header:'',              key:'lbl',       width:18 },
      { header:`N`,             key:'n',         width:16 },
      { header:`%`,             key:'np',        width:8  },
      { header:`N-1`,           key:'n1',        width:16 },
      { header:`%`,             key:'n1p',       width:8  },
      { header:`Évol € N/N-1`,  key:'ev1_eur',   width:14 },
      { header:`Évol % N/N-1`,  key:'ev1_pct',   width:12 },
      { header:`N-2`,           key:'n2',        width:16 },
      { header:`%`,             key:'n2p',       width:8  },
      { header:`Évol € N/N-2`,  key:'ev2_eur',   width:14 },
      { header:`Évol % N/N-2`,  key:'ev2_pct',   width:12 },
    ];
    // Colonnes % (1-indexed) : 3, 5, 7, 9, 11
    const isPct = i => [3,5,7,9,11].includes(i);
    const delta = (a,b) => (typeof a === 'number' && typeof b === 'number') ? (a - b) : null;
    const pctEv = (a,b) => (b && b !== 0) ? (a - b) / b * 100 : null;
    const mgPctG = (m, c) => (c && c !== 0) ? m / c * 100 : null;

    // Crée une feuille unique avec 3 sections (Aujourd'hui, Mois, Année)
    const ws = wb.addWorksheet(shName(titleCA));
    // Titre principal
    ws.addRow([titleCA]);
    ws.getRow(1).font = { bold:true, size:14, color:{ argb:'FF1A237E' } };
    // Largeur colonnes
    ws.columns = globalCols;

    function addSection(sectionTitle, c, s, a) {
      ws.addRow([]);
      const titleRow = ws.addRow([sectionTitle]);
      titleRow.font = { bold:true, size:12, color:{ argb:'FF1A237E' } };
      titleRow.alignment = { vertical:'middle' };
      const hdrRow = ws.addRow(globalCols.map(x => x.header));
      hdrRow.eachCell(cell => { cell.fill=headerFill; cell.font=headerFont; cell.alignment={horizontal:'center',vertical:'middle'}; cell.border=border; });
      hdrRow.height = 22;
      const rows = [
        [`CA HT`,    c[0], null,           c[1], null,           delta(c[0],c[1]), pctEv(c[0],c[1]),
                     c[2], null,           delta(c[0],c[2]), pctEv(c[0],c[2])],
        [`Marge SF`, s[0], mgPctG(s[0],c[0]), s[1], mgPctG(s[1],c[1]), delta(s[0],s[1]), pctEv(s[0],s[1]),
                     s[2], mgPctG(s[2],c[2]), delta(s[0],s[2]), pctEv(s[0],s[2])],
        [`Marge AF`, a[0], mgPctG(a[0],c[0]), a[1], mgPctG(a[1],c[1]), delta(a[0],a[1]), pctEv(a[0],a[1]),
                     a[2], mgPctG(a[2],c[2]), delta(a[0],a[2]), pctEv(a[0],a[2])],
      ];
      rows.forEach(vals => {
        const row = ws.addRow(vals);
        vals.forEach((v,i) => {
          const cell = row.getCell(i+1);
          cell.border = border;
          if (typeof v === 'number') cell.numFmt = isPct(i+1) ? pctFmt : numFmt;
        });
        row.getCell(1).font = { bold:true };
      });
    }

    addSection(`📅 ${secCA.today || "Aujourd'hui"} — ${todayLblG}`,
      [num(caG.ca_j_n), num(caG.ca_j_n1), num(caG.ca_j_n2)],
      [num(mgdG.sf_j_n), num(mgdG.sf_j_n1), num(mgdG.sf_j_n2)],
      [num(mgdG.af_j_n), num(mgdG.af_j_n1), num(mgdG.af_j_n2)]);

    addSection(`📆 ${secCA.month || 'Mois en cours'} — ${moisLblG}`,
      [num(caG.ca_m_n), num(caG.ca_m_n1), num(caG.ca_m_n2)],
      [num(mgdG.sf_m_n), num(mgdG.sf_m_n1), num(mgdG.sf_m_n2)],
      [num(mgdG.af_m_n), num(mgdG.af_m_n1), num(mgdG.af_m_n2)]);

    const yearTitle = (secCA.year || (isExe ? 'Exercice' : 'CA Global — Année'))
      + (isYtdExe ? ' (YTD)' : (isExe ? ' (Exercice complet)' : ''));
    addSection(`📋 ${yearTitle} — ${periodLabel}`,
      [num(caG.ca_n), num(caG.ca_n1), num(caG.ca_n2)],
      [num(mgdG.sf_n), num(mgdG.sf_n1), num(mgdG.sf_n2)],
      [num(mgdG.af_n), num(mgdG.af_n1), num(mgdG.af_n2)]);

    // ── Feuille Évolution mensuelle (bar chart N vs N-1) ─────────────────────
    try {
      const allRGMonth = await Promise.all(pools.map(({ pool }) =>
        pool.request()
          .input('bc_ad_n',  sql.VarChar(10), ad_n)
          .input('bc_afin_n',sql.VarChar(10), afin_n)
          .input('bc_ad_n1', sql.VarChar(10), ad_n1)
          .input('bc_afin_n1',sql.VarChar(10), afin_n1)
          .query(`
            SELECT MONTH(pv.PCVDATEEFFET) AS mois,
                   CASE WHEN pv.PCVDATEEFFET>=@bc_ad_n AND pv.PCVDATEEFFET<=@bc_afin_n THEN 'n' ELSE 'n1' END AS periode,
                   SUM(${exprCA()}) AS ca
            ${LINE_FROM}
            WHERE ${LINE_WHERE_FACT}
              AND ((pv.PCVDATEEFFET>=@bc_ad_n AND pv.PCVDATEEFFET<=@bc_afin_n)
                OR (pv.PCVDATEEFFET>=@bc_ad_n1 AND pv.PCVDATEEFFET<=@bc_afin_n1))
            GROUP BY MONTH(pv.PCVDATEEFFET),
              CASE WHEN pv.PCVDATEEFFET>=@bc_ad_n AND pv.PCVDATEEFFET<=@bc_afin_n THEN 'n' ELSE 'n1' END`)
      ));
      const bcMap = {};
      for (const r of allRGMonth) {
        for (const row of r.recordset) {
          const key = `${row.periode}-${row.mois}`;
          bcMap[key] = (bcMap[key]||0) + (parseFloat(row.ca)||0);
        }
      }
      const monthLabels = [], monthN = [], monthN1 = [];
      const iter = new Date(ad_n + 'T00:00:00');
      const endIter = new Date(afin_n + 'T00:00:00');
      const crossYear = isExe && exeStart && exeEnd && parseInt(exeStart.split('-')[0]) !== parseInt(exeEnd.split('-')[0]);
      while (iter <= endIter) {
        const m = iter.getMonth() + 1, y = iter.getFullYear();
        monthLabels.push(crossYear ? `${MOIS_XL_G[m-1]} ${String(y).slice(2)}` : MOIS_XL_G[m-1]);
        monthN.push(bcMap[`n-${m}`]  || 0);
        monthN1.push(bcMap[`n1-${m}`] || 0);
        iter.setMonth(iter.getMonth() + 1);
      }
      const labelN  = crossYear ? `${ya+1}-${ya}` : String(ya);
      const labelN1 = crossYear ? `${ya}-${ya-1}` : String(ya-1);
      const pngBuf = await renderBarPng(monthLabels, monthN, monthN1, labelN, labelN1);
      const wsE = wb.addWorksheet(shName(`${titleCA} - ${secCA.evolution || 'Évolution'}`));
      wsE.addRow([`${titleCA} — ${secCA.evolution || 'Évolution mensuelle'} — ${periodLabel}`]);
      wsE.getRow(1).font = { bold:true, size:11, color:{ argb:'FF1A237E' } };
      wsE.addRow([]);
      const imgId = wb.addImage({ buffer: pngBuf, extension: 'png' });
      wsE.addImage(imgId, 'A3:L28');
    } catch (e) {
      console.warn('[Excel Évolution mensuelle]', e.message);
    }
  }

  // ── Sheets: CA par Commercial (Année + Mois en cours) ────────────────────────
  if (pages.includes('rapport_commerciaux')) {
    const yd = isYtdExe ? yn : ya;
    const shiftYear2 = (dateStr, delta) => {
      const p = dateStr.split('-');
      return `${parseInt(p[0]) + delta}-${p[1]}-${p[2]}`;
    };
    const todayStr2 = `${yn}-${pad(mn)}-${pad(dn)}`;
    const ad_n  = isExe ? exeStart                 : `${ya}-01-01`;
    const ad_n1 = isExe ? shiftYear2(exeStart, -1) : `${ya-1}-01-01`;
    let afin_n, afin_n1;
    if (isYtdExe) {
      afin_n  = todayStr2;
      afin_n1 = shiftYear2(todayStr2, -1);
    } else if (isExe && isFull) {
      afin_n  = exeEnd;
      afin_n1 = shiftYear2(exeEnd, -1);
    } else if (isExe) {
      afin_n  = todayStr2;
      afin_n1 = shiftYear2(todayStr2, -1);
    } else {
      afin_n  = isFull ? `${ya}-12-31`   : `${ya}-${dayStr}`;
      afin_n1 = isFull ? `${ya-1}-12-31` : `${ya-1}-${dayStr}`;
    }

    // Mois en cours — basé sur yd (année du jour)
    const md_n   = `${yd}-${pad(mn)}-01`;
    const mfin_n = `${yd}-${pad(mn)}-${pad(dn)}`;
    const md_n1  = `${yd-1}-${pad(mn)}-01`;
    const mfin_n1= `${yd-1}-${pad(mn)}-${pad(dn)}`;
    const MOIS_XL = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
    const moisLbl = `${MOIS_XL[mn-1]} ${yd}`;

    const cN   = `pv.PCVDATEEFFET>=@ad_n   AND pv.PCVDATEEFFET<=@afin_n`;
    const cN1  = `pv.PCVDATEEFFET>=@ad_n1  AND pv.PCVDATEEFFET<=@afin_n1`;
    const cMN  = `pv.PCVDATEEFFET>=@md_n   AND pv.PCVDATEEFFET<=@mfin_n`;
    const cMN1 = `pv.PCVDATEEFFET>=@md_n1  AND pv.PCVDATEEFFET<=@mfin_n1`;
    const mgExprFn2 = mg === 'af' ? exprMgAf : exprMgSf;

    function addDC(r) {
      r.input('ad_n',sql.VarChar(10),ad_n);     r.input('afin_n',sql.VarChar(10),afin_n);
      r.input('ad_n1',sql.VarChar(10),ad_n1);   r.input('afin_n1',sql.VarChar(10),afin_n1);
      r.input('md_n',sql.VarChar(10),md_n);     r.input('mfin_n',sql.VarChar(10),mfin_n);
      r.input('md_n1',sql.VarChar(10),md_n1);   r.input('mfin_n1',sql.VarChar(10),mfin_n1);
      return r;
    }
    const allRC = await Promise.all(pools.map(({ pool }) =>
      addDC(pool.request()).query(`
        SELECT ISNULL(t.TIRID,0) AS tirid, ISNULL(RTRIM(t.TIRSOCIETE),'Non assigné') AS nom,
          SUM(CASE WHEN ${cN}   THEN ${exprCA()} ELSE 0 END) AS ca_n,
          SUM(CASE WHEN ${cN1}  THEN ${exprCA()} ELSE 0 END) AS ca_n1,
          SUM(CASE WHEN ${cMN}  THEN ${exprCA()} ELSE 0 END) AS ca_m_n,
          SUM(CASE WHEN ${cMN1} THEN ${exprCA()} ELSE 0 END) AS ca_m_n1,
          SUM(CASE WHEN ${cN}   THEN ${mgExprFn2(prCol)} ELSE 0 END) AS mg_n,
          SUM(CASE WHEN ${cN1}  THEN ${mgExprFn2(prCol)} ELSE 0 END) AS mg_n1,
          SUM(CASE WHEN ${cMN}  THEN ${mgExprFn2(prCol)} ELSE 0 END) AS mg_m_n,
          SUM(CASE WHEN ${cMN1} THEN ${mgExprFn2(prCol)} ELSE 0 END) AS mg_m_n1
        ${LINE_FROM}
        LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID_REP AND t.TIRTYPE='R' AND t.TIRISACTIF='O'
        WHERE ${LINE_WHERE_FACT}
          AND (
            (pv.PCVDATEEFFET>=@ad_n1 AND pv.PCVDATEEFFET<=@afin_n)
            OR (pv.PCVDATEEFFET>=@md_n1 AND pv.PCVDATEEFFET<=@mfin_n1)
          )
        GROUP BY t.TIRID,t.TIRSOCIETE ORDER BY ca_n DESC`)
    ));

    const num = v => parseFloat(v)||0;
    const exMergedMap = {};
    for (const res of allRC) {
      res.recordset.forEach(r => {
        const key = r.nom.trim().toLowerCase();
        const obj = { nom:r.nom, ca0:num(r.ca_n), ca1:num(r.ca_n1), mg0:num(r.mg_n), mg1:num(r.mg_n1),
                      cam0:num(r.ca_m_n), cam1:num(r.ca_m_n1), mgm0:num(r.mg_m_n), mgm1:num(r.mg_m_n1) };
        if (!exMergedMap[key]) exMergedMap[key] = obj;
        else {
          exMergedMap[key].ca0+=obj.ca0; exMergedMap[key].ca1+=obj.ca1;
          exMergedMap[key].mg0+=obj.mg0; exMergedMap[key].mg1+=obj.mg1;
          exMergedMap[key].cam0+=obj.cam0; exMergedMap[key].cam1+=obj.cam1;
          exMergedMap[key].mgm0+=obj.mgm0; exMergedMap[key].mgm1+=obj.mgm1;
        }
      });
    }
    const exRows = Object.values(exMergedMap).sort((a, b) => b.ca0 - a.ca0);

    function addComRow(ws, cols, r, pctCols) {
      const row = ws.addRow(r);
      cols.forEach((i) => {
        const cell = row.getCell(i);
        cell.numFmt = pctCols.includes(i) ? pctFmt : numFmt;
        cell.border = border;
      });
      row.getCell(1).border = border;
      return row;
    }
    function addComTotal(ws, vals, pctCols) {
      const tRow = ws.addRow(vals);
      tRow.eachCell((cell, i) => {
        cell.fill = totalFill; cell.font = totalFont; cell.border = border;
        if (i > 1) cell.numFmt = pctCols.includes(i) ? pctFmt : numFmt;
      });
    }

    // ── Feuille Année ──
    const periodLabel = isFull ? `${ya} — Année complète` : `${ya} — YTD au ${pad(dn)}/${pad(mn)}`;
    const wsA = wb.addWorksheet(shName(titleCOM));
    wsA.addRow([`${titleCOM} — ${secCOM.year || 'CA par Commercial — Année'} — ${periodLabel} — Marge ${mgLabel}`]);
    wsA.getRow(1).font = { bold:true, size:11, color:{ argb:'FF1A237E' } };
    wsA.addRow([]);
    setHeader(wsA, [
      { header:'Commercial',             key:'nom',      width:24 },
      { header:`CA ${ya} (N)`,           key:'ca_n',     width:18 },
      { header:`Mg ${mgLabel} (N)`,      key:'mg_n',     width:16 },
      { header:`${mgLabel}% (N)`,        key:'mgp_n',    width:10 },
      { header:`CA ${ya-1} (N-1)`,       key:'ca_n1',    width:18 },
      { header:`Mg ${mgLabel} (N-1)`,    key:'mg_n1',    width:16 },
      { header:`${mgLabel}% (N-1)`,      key:'mgp_n1',   width:10 },
      { header:'Évol CA € N/N-1',        key:'evolca_e', width:14 },
      { header:'Évol CA % N/N-1',        key:'evol',     width:14 },
      { header:'Évol Mg € N/N-1',        key:'evolmg_e', width:14 },
      { header:'Évol Mg % N/N-1',        key:'evolmg',   width:14 },
    ]);
    let totA = [0,0,0,0];
    exRows.forEach(r => {
      totA[0]+=r.ca0; totA[1]+=r.ca1; totA[2]+=r.mg0; totA[3]+=r.mg1;
      addComRow(wsA, [2,3,4,5,6,7,8,9,10,11], [
        r.nom, r.ca0, r.mg0, r.ca0>0?r.mg0/r.ca0*100:0,
        r.ca1, r.mg1, r.ca1>0?r.mg1/r.ca1*100:0,
        r.ca0 - r.ca1,
        r.ca1>0?(r.ca0-r.ca1)/r.ca1*100:0,
        r.mg0 - r.mg1,
        r.mg1>0?(r.mg0-r.mg1)/r.mg1*100:0,
      ], [4,7,9,11]);
    });
    addComTotal(wsA, [
      'TOTAL', totA[0], totA[2], totA[0]>0?totA[2]/totA[0]*100:0,
      totA[1], totA[3], totA[1]>0?totA[3]/totA[1]*100:0,
      totA[0] - totA[1],
      totA[1]>0?(totA[0]-totA[1])/totA[1]*100:0,
      totA[2] - totA[3],
      totA[3]>0?(totA[2]-totA[3])/totA[3]*100:0,
    ], [4,7,9,11]);

    // ── Feuille Mois en cours ──
    const exRowsM = Object.values(exMergedMap).sort((a,b)=>b.cam0-a.cam0);
    const wsM = wb.addWorksheet(shName(`${titleCOM} - ${secCOM.month || 'Mois'}`));
    wsM.addRow([`${titleCOM} — ${secCOM.month || 'Mois en cours'} — ${moisLbl} — Marge ${mgLabel}`]);
    wsM.getRow(1).font = { bold:true, size:11, color:{ argb:'FF1A237E' } };
    wsM.addRow([]);
    setHeader(wsM, [
      { header:'Commercial',                  key:'nom',      width:24 },
      { header:`CA ${moisLbl}`,               key:'cam_n',    width:18 },
      { header:`Mg ${mgLabel} ${moisLbl}`,    key:'mgm_n',    width:18 },
      { header:`${mgLabel}%`,                 key:'mgmp_n',   width:10 },
      { header:`CA ${MOIS_XL[mn-1]} ${ya-1}`, key:'cam_n1',   width:18 },
      { header:`Mg ${mgLabel} ${MOIS_XL[mn-1]} ${ya-1}`, key:'mgm_n1', width:18 },
      { header:`${mgLabel}%`,                 key:'mgmp_n1',  width:10 },
      { header:'Évol CA € N/N-1',             key:'evolca_e', width:14 },
      { header:'Évol CA % N/N-1',             key:'evol',     width:14 },
      { header:'Évol Mg € N/N-1',             key:'evolmg_e', width:14 },
      { header:'Évol Mg % N/N-1',             key:'evolmg',   width:14 },
    ]);
    let totM = [0,0,0,0];
    exRowsM.forEach(r => {
      totM[0]+=r.cam0; totM[1]+=r.cam1; totM[2]+=r.mgm0; totM[3]+=r.mgm1;
      addComRow(wsM, [2,3,4,5,6,7,8,9,10,11], [
        r.nom, r.cam0, r.mgm0, r.cam0>0?r.mgm0/r.cam0*100:0,
        r.cam1, r.mgm1, r.cam1>0?r.mgm1/r.cam1*100:0,
        r.cam0 - r.cam1,
        r.cam1>0?(r.cam0-r.cam1)/r.cam1*100:0,
        r.mgm0 - r.mgm1,
        r.mgm1>0?(r.mgm0-r.mgm1)/r.mgm1*100:0,
      ], [4,7,9,11]);
    });
    addComTotal(wsM, [
      'TOTAL', totM[0], totM[2], totM[0]>0?totM[2]/totM[0]*100:0,
      totM[1], totM[3], totM[1]>0?totM[3]/totM[1]*100:0,
      totM[0] - totM[1],
      totM[1]>0?(totM[0]-totM[1])/totM[1]*100:0,
      totM[2] - totM[3],
      totM[3]>0?(totM[2]-totM[3])/totM[3]*100:0,
    ], [4,7,9,11]);

    // ── Feuille Graphique (camembert Top 12) ──
    const top12 = exRows.slice(0, 12);
    if (top12.length) {
      const pngBuf = await renderDoughnutPng(
        top12.map(r => r.nom),
        top12.map(r => r.ca0),
      );
      const wsG = wb.addWorksheet(shName(`${titleCOM} - ${secCOM.distribution || 'Graphique'}`));
      wsG.addRow([`${titleCOM} — ${secCOM.distribution || 'Répartition CA'} — ${ya} — Top ${top12.length} commerciaux`]);
      wsG.getRow(1).font = { bold:true, size:11, color:{ argb:'FF1A237E' } };
      const imgId = wb.addImage({ buffer: pngBuf, extension: 'png' });
      wsG.addImage(imgId, { tl: { col: 0, row: 2 }, ext: { width: 720, height: 480 } });
    }
  }

  // ── Sheets: Règlement clients (Synthèse + Payeurs moyens + Mauvais + DSO par commercial) ──
  // Calculs identiques à /reglement-summary et /reglement-clients : facturé TTC sur 12 mois
  // glissants, période d'activité réelle par client (plancher 30 j) ; DSO global = encours /
  // dailySales agrégé. Seul le 1er pool est utilisé (pas de consolidation multi-bases ici).
  if (pages.includes('rapport_reglement')) {
    const titleRGL = societePrefix + (titles.rapport_reglement || 'Règlement clients');
    const secRGL   = titles.sections?.rapport_reglement || {};
    const pool     = pools[0]?.pool;
    if (pool) {
      // Fenêtre glissante 12 mois finissant à `now` (ou asof si fourni)
      const dFin = now.toISOString().slice(0,10);
      const startD = new Date(now); startD.setMonth(startD.getMonth() - 12);
      const dDeb = startD.toISOString().slice(0,10);
      const periodeLabelRgl = `12 derniers mois (${dDeb} → ${dFin})`;
      const exeStartRgl = await getExeStart(pool, dFin);

      const mkRequest = () => pool.request()
        .input('caDebut',  sql.VarChar(10), dDeb)
        .input('caFin',    sql.VarChar(10), dFin)
        .input('dateFin',  sql.VarChar(10), dFin)
        .input('exeStart', sql.VarChar(10), exeStartRgl);

      // Envoi mail Excel : filtre "actifs uniquement" hardcodé (cohérent avec HTML/PDF)
      const ACTIF_TIER_X = `AND (ter.REPID IS NULL
                                 OR NOT EXISTS (SELECT 1 FROM TIERS rep WITH (NOLOCK) WHERE rep.TIRID=ter.REPID AND rep.TIRTYPE='R')
                                 OR EXISTS (SELECT 1 FROM TIERS rep WITH (NOLOCK) WHERE rep.TIRID=ter.REPID AND rep.TIRTYPE='R' AND rep.TIRISACTIF='O'))`;
      const ACTIF_REP_X = `AND rep.TIRISACTIF='O'`;

      let smRow = {}, moyensRows = [], mauvaisRows = [], commRows = [], dsoGlobal = 0;
      try {
        const summaryR = await mkRequest().query(`
          SELECT
            ISNULL(SUM(ca.ca), 0)            AS facture,
            ISNULL(SUM(en.encours), 0)       AS encours,
            ISNULL(SUM(${DAILY_SALES_EXPR}), 0) AS dailySales,
            COUNT(DISTINCT ter.TIRID)        AS nb_clients,
            COUNT(DISTINCT ter.REPID)        AS nb_commerciaux
          FROM TIERS ter WITH (NOLOCK)
          LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
          LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
          WHERE ter.TIRTYPE = 'C' AND ISNULL(ca.ca, 0) > 0
            ${ACTIF_TIER_X}
        `);
        smRow = summaryR.recordset[0] || {};
        const dailySales = parseFloat(smRow.dailySales) || 0;
        const encours    = parseFloat(smRow.encours) || 0;
        dsoGlobal = dailySales > 0 ? (encours / dailySales) : 0;

        const [moyensR, mauvaisR, commR] = await Promise.all([
          mkRequest().input('seuil', sql.Decimal(10,1), Number.isFinite(dsoGlobal) ? dsoGlobal : 0).query(`
            SELECT TOP 20 label, facture, encours, ratio FROM (
              SELECT
                RTRIM(ter.TIRSOCIETE) AS label,
                ISNULL(ca.ca, 0)      AS facture,
                ISNULL(en.encours, 0) AS encours,
                ${DSO_PER_CLIENT_EXPR} AS ratio
              FROM TIERS ter WITH (NOLOCK)
              LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
              LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
              WHERE ter.TIRTYPE = 'C' AND ISNULL(ca.ca, 0) > 0
                ${ACTIF_TIER_X}
            ) x
            WHERE ratio <= @seuil
            ORDER BY encours DESC
          `),
          mkRequest().input('seuil', sql.Decimal(10,1), Number.isFinite(dsoGlobal) ? dsoGlobal : 0).query(`
            SELECT TOP 20 label, facture, encours, ratio FROM (
              SELECT
                RTRIM(ter.TIRSOCIETE) AS label,
                ISNULL(ca.ca, 0)      AS facture,
                ISNULL(en.encours, 0) AS encours,
                ${DSO_PER_CLIENT_EXPR} AS ratio
              FROM TIERS ter WITH (NOLOCK)
              LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
              LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
              WHERE ter.TIRTYPE = 'C' AND ISNULL(ca.ca, 0) > 0
                ${ACTIF_TIER_X}
            ) x
            WHERE ratio > @seuil
            ORDER BY encours DESC
          `),
          mkRequest().query(`
            SELECT TOP 20
              RTRIM(rep.TIRSOCIETE) AS label,
              COUNT(DISTINCT ter.TIRID) AS nb_clients,
              ISNULL(SUM(ca.ca), 0)      AS facture,
              ISNULL(SUM(en.encours), 0) AS encours,
              ${DSO_AGG_EXPR} AS ratio
            FROM TIERS rep WITH (NOLOCK)
            JOIN TIERS ter WITH (NOLOCK) ON ter.REPID = rep.TIRID AND ter.TIRTYPE = 'C'
            LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
            LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
            WHERE rep.TIRTYPE = 'R'
              ${ACTIF_REP_X}
            GROUP BY rep.TIRID, rep.TIRSOCIETE
            HAVING ISNULL(SUM(ca.ca), 0) > 0
            ORDER BY ratio ASC
          `),
        ]);
        moyensRows  = moyensR.recordset;
        mauvaisRows = mauvaisR.recordset;
        commRows    = commR.recordset;
      } catch (e) {
        console.warn('[Excel rapport_reglement] erreur SQL :', e.message);
      }

      // Couleurs DSO : ≤30 j vert, ≤60 j orange, sinon rouge (cohérent avec la page)
      const dsoFontColor = r => r <= 30 ? 'FF2E7D32' : r <= 60 ? 'FFEF6C00' : 'FFC62828';
      const colorDsoCell = (cell, r) => { cell.font = { color: { argb: dsoFontColor(r) }, bold: true }; };

      // ── Synthèse ──
      const wsS = wb.addWorksheet(shName(`${titleRGL} - ${secRGL.summary || 'Synthèse'}`));
      wsS.addRow([`${titleRGL} — ${secRGL.summary || 'Synthèse — DSO global'} — ${periodeLabelRgl}`]);
      wsS.getRow(1).font = { bold:true, size:11, color:{ argb:'FF1A237E' } };
      wsS.addRow([]);
      setHeader(wsS, [
        { header:'Indicateur', key:'k', width:55 },
        { header:'Valeur',     key:'v', width:22 },
      ]);
      const facture = parseFloat(smRow.facture) || 0;
      const encours = parseFloat(smRow.encours) || 0;
      const rDso = wsS.addRow(['DSO global (Créances ÷ CA quotidien par client)', `${dsoGlobal.toFixed(1)} j`]);
      rDso.eachCell(c => c.border = border); colorDsoCell(rDso.getCell(2), dsoGlobal);
      const rCa = wsS.addRow(['CA TTC (12 derniers mois — PIECEVENTES)', facture]);
      rCa.eachCell(c => c.border = border); rCa.getCell(2).numFmt = numFmt;
      const rEn = wsS.addRow([`Créances clients (solde 411 à ${dFin})`, encours]);
      rEn.eachCell(c => { c.border = border; c.fill = totalFill; c.font = totalFont; });
      rEn.getCell(2).numFmt = numFmt;
      const rNb = wsS.addRow(['Clients facturés / Commerciaux', `${smRow.nb_clients||0} / ${smRow.nb_commerciaux||0}`]);
      rNb.eachCell(c => c.border = border);

      // ── Payeurs moyens ──
      const wsMoy = wb.addWorksheet(shName(`${titleRGL} - ${secRGL.moyens || 'Payeurs moyens'}`));
      wsMoy.addRow([`${titleRGL} — ${secRGL.moyens || 'Top 20 payeurs moyens'} (DSO ≤ ${dsoGlobal.toFixed(1)} j) — ${periodeLabelRgl}`]);
      wsMoy.getRow(1).font = { bold:true, size:11, color:{ argb:'FF1A237E' } };
      wsMoy.addRow([]);
      setHeader(wsMoy, [
        { header:'Client',       key:'label',   width:40 },
        { header:'DSO (jours)',  key:'ratio',   width:14 },
        { header:'Facturé TTC',  key:'facture', width:18 },
        { header:'Créances',     key:'encours', width:18 },
      ]);
      moyensRows.forEach(r => {
        const dso = parseFloat(r.ratio) || 0;
        const row = wsMoy.addRow([r.label, parseFloat(dso.toFixed(1)), parseFloat(r.facture)||0, parseFloat(r.encours)||0]);
        row.eachCell(c => c.border = border);
        row.getCell(2).numFmt = '0.0'; colorDsoCell(row.getCell(2), dso);
        row.getCell(3).numFmt = numFmt;
        row.getCell(4).numFmt = numFmt;
      });

      // ── Mauvais payeurs ──
      const wsMau = wb.addWorksheet(shName(`${titleRGL} - ${secRGL.mauvais || 'Mauvais payeurs'}`));
      wsMau.addRow([`${titleRGL} — ${secRGL.mauvais || 'Top 20 mauvais payeurs'} (DSO > ${dsoGlobal.toFixed(1)} j) — ${periodeLabelRgl}`]);
      wsMau.getRow(1).font = { bold:true, size:11, color:{ argb:'FF1A237E' } };
      wsMau.addRow([]);
      setHeader(wsMau, [
        { header:'Client',       key:'label',   width:40 },
        { header:'DSO (jours)',  key:'ratio',   width:14 },
        { header:'Facturé TTC',  key:'facture', width:18 },
        { header:'Créances',     key:'encours', width:18 },
      ]);
      mauvaisRows.forEach(r => {
        const dso = parseFloat(r.ratio) || 0;
        const row = wsMau.addRow([r.label, parseFloat(dso.toFixed(1)), parseFloat(r.facture)||0, parseFloat(r.encours)||0]);
        row.eachCell(c => c.border = border);
        row.getCell(2).numFmt = '0.0'; colorDsoCell(row.getCell(2), dso);
        row.getCell(3).numFmt = numFmt;
        row.getCell(4).numFmt = numFmt;
      });

      // ── DSO par commercial ──
      const wsCom = wb.addWorksheet(shName(`${titleRGL} - ${secRGL.commerciaux || 'DSO commercial'}`));
      wsCom.addRow([`${titleRGL} — ${secRGL.commerciaux || 'DSO par commercial'} — ${periodeLabelRgl}`]);
      wsCom.getRow(1).font = { bold:true, size:11, color:{ argb:'FF1A237E' } };
      wsCom.addRow([]);
      setHeader(wsCom, [
        { header:'Commercial',   key:'label',      width:30 },
        { header:'DSO (jours)',  key:'ratio',      width:14 },
        { header:'Clients',      key:'nb_clients', width:10 },
        { header:'Facturé TTC',  key:'facture',    width:18 },
        { header:'Créances',     key:'encours',    width:18 },
      ]);
      commRows.forEach(r => {
        const dso = parseFloat(r.ratio) || 0;
        const row = wsCom.addRow([r.label, parseFloat(dso.toFixed(1)), parseInt(r.nb_clients)||0, parseFloat(r.facture)||0, parseFloat(r.encours)||0]);
        row.eachCell(c => c.border = border);
        row.getCell(2).numFmt = '0.0'; colorDsoCell(row.getCell(2), dso);
        row.getCell(4).numFmt = numFmt;
        row.getCell(5).numFmt = numFmt;
      });
    }
  }

  return await wb.xlsx.writeBuffer();
}

async function renderBarPng(labels, dataN, dataN1, labelN, labelN1) {
  const html = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>body{margin:0;padding:0;background:#fff;font-family:Arial,sans-serif}</style>
</head><body>
<div id="wrap" style="width:900px;height:420px;padding:8px;box-sizing:border-box">
  <canvas id="c"></canvas>
</div>
<script>
  new Chart(document.getElementById('c'), {
    type:'bar',
    data:{ labels: ${JSON.stringify(labels)},
           datasets:[
             { label: ${JSON.stringify(String(labelN))},   data: ${JSON.stringify(dataN)},  backgroundColor: '#2196F3', borderRadius: 4 },
             { label: ${JSON.stringify(String(labelN1))},  data: ${JSON.stringify(dataN1)}, backgroundColor: '#4CAF5080', borderRadius: 4 },
           ] },
    options:{ responsive:true, maintainAspectRatio:false, animation:false,
              plugins:{ legend:{ labels:{ color:'#1a1d2e', font:{size:12} } } },
              scales:{ x:{ ticks:{ color:'#334155' } }, y:{ ticks:{ color:'#334155' } } } }
  });
</script></body></html>`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 420, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));
    const el = await page.$('#wrap');
    return await el.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

async function renderDoughnutPng(labels, values) {
  const PIE_COLORS = ['#2196F3','#4CAF50','#FF9800','#9C27B0','#F44336','#00BCD4','#FF5722','#8BC34A','#E91E63','#03A9F4','#CDDC39','#795548'];
  const colors = labels.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]);
  const html = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>body{margin:0;padding:0;background:#fff;font-family:Arial,sans-serif}</style>
</head><body>
<div id="wrap" style="width:720px;height:480px;padding:8px;box-sizing:border-box">
  <canvas id="c"></canvas>
</div>
<script>
  new Chart(document.getElementById('c'), {
    type:'doughnut',
    data:{ labels: ${JSON.stringify(labels)},
           datasets:[{ data: ${JSON.stringify(values)},
                       backgroundColor: ${JSON.stringify(colors)},
                       borderColor:'#ffffff', borderWidth:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, animation:false,
              plugins:{ legend:{ position:'right', labels:{ color:'#1a1d2e', font:{size:12}, boxWidth:14, padding:6 } } } }
  });
</script></body></html>`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 480, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));
    const el = await page.$('#wrap');
    return await el.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

async function resolveCurrentExeAnnee(pool, asof = null) {
  if (!pool) return null;
  try {
    const today = asof || new Date().toISOString().slice(0, 10);
    const r = await pool.request()
      .input('today', sql.VarChar(10), today)
      .query(`
        SELECT TOP 1
          CONVERT(varchar(10), EXEDATEDEB, 120) AS d0,
          CONVERT(varchar(10), EXEDATEFIN, 120) AS d1
        FROM EXERCICES WITH (NOLOCK)
        WHERE @today >= CONVERT(varchar(10), EXEDATEDEB, 120)
          AND @today <= CONVERT(varchar(10), EXEDATEFIN, 120)
        ORDER BY EXEDATEDEB DESC
      `);
    const row = r.recordset[0];
    return row ? `ytd_exe:${row.d0}:${row.d1}` : null;
  } catch (e) {
    console.warn('[resolveCurrentExeAnnee]', e.message);
    return null;
  }
}

// Rapport "Règlement clients" pour email/PDF
// Calculs : factures TTC sur 12 mois glissants ; DSO par client basé sur la période
// d'activité réelle (DATEDIFF 1ère facture → caFin, plancher 30 j) ; DSO global =
// SUM(encours) / SUM(CA quotidien par client) — cohérent avec /reglement-summary.
// Découpage : Top 20 payeurs moyens (DSO ≤ DSO global) + Top 20 mauvais payeurs
// (DSO > DSO global), classés par créances DESC dans les deux cas.
async function buildEmailReglement(pool, dateDebut, dateFin, sec = {}, periodeLabel = '') {
  const escH = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // DSO en jours : bas = bon (vert), haut = mauvais (rouge)
  const colorRatio = r => r <= 30 ? '#2e7d32' : r <= 60 ? '#ef6c00' : '#c62828';
  const ratioBar = r => `<div style="display:inline-block;width:60px;height:8px;background:#e8ecf4;border-radius:3px;vertical-align:middle;margin-right:6px"><div style="height:100%;background:${colorRatio(r)};border-radius:3px;width:${Math.min(100, Math.max(0, r/90*100))}%"></div></div>`;
  const ratioCell = r => `${ratioBar(r)}<span style="color:${colorRatio(r)};font-weight:600">${r.toFixed(1)} j</span>`;

  const exeStart = await getExeStart(pool, dateFin);
  const DSO_PER_TIR = DSO_PER_CLIENT_EXPR;
  const DSO_PER_REP = DSO_AGG_EXPR;
  // Envoi mail : on ne propose pas de filtre commerciaux dans les options de planification
  // (volonté utilisateur), mais on cale par défaut sur "actifs uniquement" — comme la page
  // par défaut. Cohérence : un client sans commercial assigné (REPID NULL/orphelin) est
  // conservé, et un commercial inactif est exclu de la liste DSO par commercial.
  const ACTIF_TIER = `AND (ter.REPID IS NULL
                          OR NOT EXISTS (SELECT 1 FROM TIERS rep WITH (NOLOCK) WHERE rep.TIRID=ter.REPID AND rep.TIRTYPE='R')
                          OR EXISTS (SELECT 1 FROM TIERS rep WITH (NOLOCK) WHERE rep.TIRID=ter.REPID AND rep.TIRTYPE='R' AND rep.TIRISACTIF='O'))`;
  const ACTIF_REP = `AND rep.TIRISACTIF='O'`;
  const mkRequest = () => pool.request()
    .input('caDebut',  sql.VarChar(10), dateDebut)
    .input('caFin',    sql.VarChar(10), dateFin)
    .input('dateFin',  sql.VarChar(10), dateFin)
    .input('exeStart', sql.VarChar(10), exeStart);

  // Étape 1 : synthèse globale (incluant dailySales pour calculer le DSO global)
  const summaryR = await mkRequest().query(`
    SELECT
      ISNULL(SUM(ca.ca), 0)            AS facture,
      ISNULL(SUM(en.encours), 0)       AS encours,
      ISNULL(SUM(${DAILY_SALES_EXPR}), 0) AS dailySales,
      COUNT(DISTINCT ter.TIRID)        AS nb_clients,
      COUNT(DISTINCT ter.REPID)        AS nb_commerciaux
    FROM TIERS ter WITH (NOLOCK)
    LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
    LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
    WHERE ter.TIRTYPE = 'C' AND ISNULL(ca.ca, 0) > 0
      ${ACTIF_TIER}
  `);
  const sm = summaryR.recordset[0] || {};
  const facture    = parseFloat(sm.facture) || 0;
  const encours    = parseFloat(sm.encours) || 0;
  const dailySales = parseFloat(sm.dailySales) || 0;
  const dso        = dailySales > 0 ? (encours / dailySales) : 0;

  // Étape 2 : moyens (DSO ≤ DSO global) + mauvais (DSO > DSO global) classés par créances DESC,
  // et DSO par commercial classé du meilleur au pire (DSO ASC).
  const [moyensR, mauvaisR, commR] = await Promise.all([
    mkRequest().input('seuil', sql.Decimal(10,1), Number.isFinite(dso) ? dso : 0).query(`
      SELECT TOP 20 label, facture, regle, encours, ratio FROM (
        SELECT
          RTRIM(ter.TIRSOCIETE) AS label,
          ISNULL(ca.ca, 0)      AS facture,
          0                     AS regle,
          ISNULL(en.encours, 0) AS encours,
          ${DSO_PER_TIR} AS ratio
        FROM TIERS ter WITH (NOLOCK)
        LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
        LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
        WHERE ter.TIRTYPE = 'C' AND ISNULL(ca.ca, 0) > 0
          ${ACTIF_TIER}
      ) x
      WHERE ratio <= @seuil
      ORDER BY encours DESC
    `),
    mkRequest().input('seuil', sql.Decimal(10,1), Number.isFinite(dso) ? dso : 0).query(`
      SELECT TOP 20 label, facture, regle, encours, ratio FROM (
        SELECT
          RTRIM(ter.TIRSOCIETE) AS label,
          ISNULL(ca.ca, 0)      AS facture,
          0                     AS regle,
          ISNULL(en.encours, 0) AS encours,
          ${DSO_PER_TIR} AS ratio
        FROM TIERS ter WITH (NOLOCK)
        LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
        LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
        WHERE ter.TIRTYPE = 'C' AND ISNULL(ca.ca, 0) > 0
          ${ACTIF_TIER}
      ) x
      WHERE ratio > @seuil
      ORDER BY encours DESC
    `),
    mkRequest().query(`
      SELECT TOP 20
        RTRIM(rep.TIRSOCIETE) AS label,
        COUNT(DISTINCT ter.TIRID) AS nb_clients,
        ISNULL(SUM(ca.ca), 0)      AS facture,
        0                          AS regle,
        ISNULL(SUM(en.encours), 0) AS encours,
        ${DSO_PER_REP} AS ratio
      FROM TIERS rep WITH (NOLOCK)
      JOIN TIERS ter WITH (NOLOCK) ON ter.REPID = rep.TIRID AND ter.TIRTYPE = 'C'
      LEFT JOIN (${CA_BY_TIRID_SUBQUERY}) ca ON ca.TIRID = ter.TIRID
      LEFT JOIN (${ENCOURS_BY_CPTID_SUBQUERY}) en ON en.CPTID = ter.CPTID
      WHERE rep.TIRTYPE = 'R'
        ${ACTIF_REP}
      GROUP BY rep.TIRID, rep.TIRSOCIETE
      HAVING ISNULL(SUM(ca.ca), 0) > 0
      ORDER BY ratio ASC
    `),
  ]);

  const rowClient = r => `<tr><td>${escH(r.label)}</td><td style="text-align:left">${ratioCell(parseFloat(r.ratio)||0)}</td><td>${fmtE(r.facture)}</td><td>${fmtE(r.encours)}</td></tr>`;
  const rowComm   = r => `<tr><td>${escH(r.label)}</td><td style="text-align:left">${ratioCell(parseFloat(r.ratio)||0)}</td><td>${r.nb_clients}</td><td>${fmtE(r.facture)}</td><td>${fmtE(r.encours)}</td></tr>`;

  return `
    <div class="section">
      <h2>💶 ${sec.summary || 'Synthèse — DSO global'}</h2>
      <div class="sub">${periodeLabel} — encours sur l'exercice en cours (depuis ${exeStart})</div>
      <table>
        <thead><tr><th>Indicateur</th><th>Valeur</th></tr></thead>
        <tbody>
          <tr><td>DSO global (Créances ÷ CA quotidien par client)</td><td><strong style="color:${colorRatio(dso)}">${dso.toFixed(1)} jours</strong></td></tr>
          <tr><td>CA TTC (12 derniers mois — PIECEVENTES)</td><td>${fmtE(facture)}</td></tr>
          <tr class="row-total"><td>Créances clients (solde 411 à ${dateFin})</td><td><strong style="color:#ef6c00">${fmtE(encours)}</strong></td></tr>
          <tr><td>Clients facturés / Commerciaux</td><td>${sm.nb_clients||0} / ${sm.nb_commerciaux||0}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="section">
      <h2>🟡 ${sec.moyens || 'Top 20 payeurs moyens'} <span style="font-size:.78rem;color:#888;font-weight:400">(DSO ≤ ${dso.toFixed(1)} j)</span></h2>
      <div class="sub">${periodeLabel} — classés par créances décroissantes</div>
      <table>
        <thead><tr><th>Client</th><th>DSO</th><th>Facturé TTC</th><th>Créances</th></tr></thead>
        <tbody>${moyensR.recordset.map(rowClient).join('')}</tbody>
      </table>
    </div>
    <div class="section">
      <h2>🔴 ${sec.mauvais || 'Top 20 mauvais payeurs'} <span style="font-size:.78rem;color:#888;font-weight:400">(DSO &gt; ${dso.toFixed(1)} j)</span></h2>
      <div class="sub">${periodeLabel} — classés par créances décroissantes</div>
      <table>
        <thead><tr><th>Client</th><th>DSO</th><th>Facturé TTC</th><th>Créances</th></tr></thead>
        <tbody>${mauvaisR.recordset.map(rowClient).join('')}</tbody>
      </table>
    </div>
    <div class="section">
      <h2>👥 ${sec.commerciaux || 'DSO par commercial'}</h2>
      <div class="sub">${periodeLabel}</div>
      <table>
        <thead><tr><th>Commercial</th><th>DSO</th><th>Clients</th><th>Facturé TTC</th><th>Créances</th></tr></thead>
        <tbody>${commR.recordset.map(rowComm).join('')}</tbody>
      </table>
    </div>`;
}

async function buildBuiltinEmailHtml(config) {
  const { pages=['rapport_ca','rapport_commerciaux'], periode='ytd', pr='PLVCRUMP', mg='sf', dbs, asof=null, _userDatabase=null, _userConnId=null, _societe=null } = config;
  let annee = config.annee || null;
  const isFull = periode === 'full';
  const prCol  = resolvePrCol(pr);
  const pools  = await getConnPools(dbs, { database: _userDatabase, connId: _userConnId });
  if (!annee) annee = await resolveCurrentExeAnnee(pools[0]?.pool, asof);
  // Multi-base : concatène les sociétés de chaque pool. _societe (req.user.societe) ne s'applique que mono-base.
  const societes = pools.length === 1 && _societe
    ? [_societe]
    : (await Promise.all(pools.map(p => fetchSocieteFromPool(p.pool)))).filter(Boolean);
  const societe = societes.join(' / ') || null;

  const now = asofToDate(asof);
  const dateStr = now.toLocaleDateString('fr-FR',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  let periodeLabel;
  if (annee && String(annee).startsWith('ytd_exe:')) {
    const [, d0] = String(annee).split(':');
    periodeLabel = `Exercice YTD (${d0} → ${now.toISOString().slice(0,10)})`;
  } else if (annee && String(annee).startsWith('exe:')) {
    const [, d0, d1] = String(annee).split(':');
    periodeLabel = `Exercice (${d0} → ${d1})`;
  } else {
    periodeLabel = isFull
      ? 'Année complète (01/01 → 31/12)'
      : `YTD (01/01 → ${pad(now.getDate())}/${pad(now.getMonth()+1)})`;
  }

  const titles = readBuiltinTitles();
  const societePrefix = societe ? `${societe} — ` : '';
  const rapTitle = (key) => `<div class="rapport-header"><h1>${societePrefix}${titles[key] || key}</h1></div>`;

  const parts = [];
  if (pages.includes('rapport_ca'))          parts.push(rapTitle('rapport_ca')          + await buildEmailCaGlobal(pools, isFull, prCol,     titles.sections?.rapport_ca,         annee, asof));
  if (pages.includes('rapport_commerciaux')) parts.push(rapTitle('rapport_commerciaux') + await buildEmailCaCommerciaux(pools, isFull, prCol, mg, titles.sections?.rapport_commerciaux, annee, asof));
  if (pages.includes('rapport_reglement')) {
    // Le rapport règlement utilise par défaut 12 mois glissants pour un DSO cohérent
    const nowD = asofToDate(asof);
    const dFin = nowD.toISOString().slice(0, 10);
    const startD = new Date(nowD); startD.setMonth(startD.getMonth() - 12);
    const dDeb = startD.toISOString().slice(0, 10);
    const reglPeriodeLabel = `12 derniers mois (${dDeb} → ${dFin})`;
    parts.push(rapTitle('rapport_reglement') + await buildEmailReglement(pools[0]?.pool, dDeb, dFin, titles.sections?.rapport_reglement, reglPeriodeLabel));
  }

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
${emailCss()}</head>
<body><div class="wrap">
  <div class="hdr">
    <p>Généré le ${dateStr} · Période&nbsp;: ${periodeLabel}</p>
  </div>
  ${parts.join('')}
  <div class="ftr">TB Reporting · Envoi automatique</div>
</div></body></html>`;
}

async function buildBuiltinPdf(config) {
  const html = await buildBuiltinEmailHtml(config);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4', landscape: false,
      printBackground: true,
      margin: { top:'15mm', bottom:'15mm', left:'10mm', right:'10mm' },
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

async function sendBuiltinReport(recipients, subject, config) {
  const smtp = readSmtpCfg();
  if (!smtp.host || !smtp.user) throw new Error('SMTP non configuré — Paramètres > Email');
  const t = nodemailer.createTransport({
    host: smtp.host, port: parseInt(smtp.port)||587,
    secure: smtp.secure===true||smtp.secure==='true',
    auth: { user: smtp.user, pass: smtp.password },
    family: 4,
  });

  const fmt = config.format || 'html';
  const mailOpts = {
    from: smtp.from || smtp.user,
    to: Array.isArray(recipients) ? recipients.join(', ') : recipients,
    subject,
  };

  const dateStr = new Date().toISOString().slice(0,10);
  const periodeStr = config.periode==='full'?'Année complète':'YTD';
  if (fmt === 'excel') {
    const buf = await buildBuiltinExcel(config);
    mailOpts.html = `<p>Bonjour,</p><p>Veuillez trouver ci-joint le rapport TB Reporting au format Excel.</p><p>Période&nbsp;: <strong>${periodeStr}</strong></p>`;
    mailOpts.attachments = [{ filename: `rapport-tb-${dateStr}.xlsx`, content: buf, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }];
  } else if (fmt === 'pdf') {
    const buf = await buildBuiltinPdf(config);
    mailOpts.html = `<p>Bonjour,</p><p>Veuillez trouver ci-joint le rapport TB Reporting au format PDF.</p><p>Période&nbsp;: <strong>${periodeStr}</strong></p>`;
    mailOpts.attachments = [{ filename: `rapport-tb-${dateStr}.pdf`, content: buf, contentType: 'application/pdf' }];
  } else {
    mailOpts.html = await buildBuiltinEmailHtml(config);
  }

  await t.sendMail(mailOpts);
}

// ── Routes planification builtins ──────────────────────────────────────────────

router.get('/builtin-schedules', (req, res) => {
  res.json(readBuiltinSched());
});

router.get('/builtin-titles', (req, res) => {
  res.json(readBuiltinTitles());
});

router.put('/builtin-titles', (req, res) => {
  try {
    const body = req.body || {};
    const current = readBuiltinTitles();
    const clean = {};
    ['rapport_ca','rapport_commerciaux','segmentation'].forEach(k => {
      if (typeof body[k] === 'string') clean[k] = body[k].trim().slice(0, 100);
    });
    const cleanSections = {
      rapport_ca:          { ...current.sections.rapport_ca },
      rapport_commerciaux: { ...current.sections.rapport_commerciaux },
      segmentation:        { ...current.sections.segmentation },
    };
    if (body.sections && typeof body.sections === 'object') {
      ['rapport_ca','rapport_commerciaux','segmentation'].forEach(page => {
        const incoming = body.sections[page];
        if (!incoming || typeof incoming !== 'object') return;
        BUILTIN_SECTIONS[page].forEach(({ key }) => {
          if (typeof incoming[key] === 'string') cleanSections[page][key] = incoming[key].trim().slice(0, 200);
        });
      });
    }
    const updated = { ...current, ...clean, sections: cleanSections };
    writeBuiltinTitles(updated);
    res.json({ ok: true, titles: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/builtin-schedules', (req, res) => {
  try {
    const updated = { ...readBuiltinSched(), ...req.body };
    writeBuiltinSched(updated);
    setupBuiltinCron(updated);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/builtin-send', async (req, res) => {
  try {
    const base = readBuiltinSched();
    const config = { ...base, ...req.body, _userDatabase: req.user?.database, _userConnId: req.user?.connId, _societe: req.user?.societe };
    const recipients = (req.body.recipients||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (!recipients.length) return res.status(400).json({ error: 'Aucun destinataire' });
    const now = new Date();
    const baseSubject = config.title || `TB Reporting — ${config.periode==='full'?'Année complète':'YTD'}`;
    const subject = `${baseSubject} — ${now.toLocaleDateString('fr-FR')}`;
    await sendBuiltinReport(recipients, subject, config);
    res.json({ ok: true, sent: recipients });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cron builtins ──────────────────────────────────────────────────────────────

const builtinCronJobs = new Map();

function getBuiltinSchedules(config) {
  if (Array.isArray(config.schedules)) return config.schedules;
  if (config.schedule?.cron) return [{ id: 's0', ...config.schedule }];
  return [];
}

// Construit la config effective d'une planification : défauts globaux écrasés par les overrides par-planif
function mergeBuiltinSchedConfig(base, sched) {
  const merged = { ...base };
  delete merged.schedules;
  delete merged.schedule;
  const OVERRIDABLE = ['title','pages','periode','annee','mg','pr','format','dbs'];
  OVERRIDABLE.forEach(k => {
    if (sched[k] !== undefined && sched[k] !== null && sched[k] !== '') merged[k] = sched[k];
  });
  return merged;
}

function setupBuiltinCron(config) {
  for (const job of builtinCronJobs.values()) job.stop();
  builtinCronJobs.clear();
  getBuiltinSchedules(config).forEach(sched => {
    if (!sched.enabled || !sched.cron) return;
    if (!cron.validate(sched.cron)) { console.warn(`[CRON] Expression invalide (builtin/${sched.id}):`, sched.cron); return; }
    const job = cron.schedule(sched.cron, async () => {
      const cur = readBuiltinSched();
      const curSched = getBuiltinSchedules(cur).find(s => s.id === sched.id);
      if (!curSched?.enabled) return;
      try {
        const merged = mergeBuiltinSchedConfig(cur, curSched);
        const now = new Date();
        // Hiérarchie sujet : 1) titre par-planif (Options) 2) libellé de la planif 3) titre global 4) défaut
        const schedTitle = (curSched.title || '').trim();
        const schedLabel = (curSched.label || '').trim();
        const globalTitle = (cur.title || '').trim();
        const baseSubject = schedTitle || schedLabel || globalTitle || `TB Reporting — ${merged.periode==='full'?'Année complète':'YTD'}`;
        const subject = `${baseSubject} — ${now.toLocaleDateString('fr-FR')}`;
        const dest = (curSched.recipients||[]).filter(Boolean);
        if (dest.length) await sendBuiltinReport(dest, subject, merged);
        console.log(`[CRON] Builtin (${sched.id}) envoyé à :`, dest.join(', '), '| sujet:', subject, '| pages:', merged.pages, '| format:', merged.format);
      } catch (e) { console.error(`[CRON] Builtin (${sched.id}) erreur :`, e.message); }
    });
    builtinCronJobs.set(sched.id, job);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'serveur';
    console.log(`[CRON] Planification builtin (${sched.id}) :`, sched.cron, `(timezone: ${tz})`);
  });
}

try { setupBuiltinCron(readBuiltinSched()); } catch (e) { /* DB pas encore prête */ }

// ── Export direct des pages intégrées ─────────────────────────────────────────

function builtinConfigFromQuery(q) {
  const pages   = Array.isArray(q.pages) ? q.pages.filter(Boolean)
                : q.pages               ? q.pages.split(',').map(s=>s.trim()).filter(Boolean)
                : ['rapport_ca','rapport_commerciaux'];
  const periode = q.periode || 'ytd';
  const annee   = q.annee || null;   // "ytd_exe:d0:d1" | "exe:d0:d1" | "2024" | null
  const pr      = q.pr || 'PLVCRUMP';
  const mg      = q.mg || 'sf';
  const dbs     = q.dbs || undefined;
  const asof    = q.asof || null;
  // [DIAG] Logger la query brute reçue par l'export pour repérer un param manquant
  console.log('[DIAG builtinConfigFromQuery] raw query:', JSON.stringify(q), '→ pr:', pr, '| asof:', asof);
  return { pages, periode, annee, pr, mg, dbs, asof };
}

router.post('/builtin-export/excel', async (req, res) => {
  try {
    const config = builtinConfigFromQuery(req.body || {});
    config._userDatabase = req.user?.database;
    config._userConnId   = req.user?.connId;
    config._societe      = req.user?.societe;
    const buf    = await buildBuiltinExcel(config);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-tb-${dateStr}.xlsx"`);
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/builtin-export/html', async (req, res) => {
  try {
    const config = builtinConfigFromQuery(req.query);
    config._userDatabase = req.user?.database;
    config._userConnId   = req.user?.connId;
    config._societe      = req.user?.societe;
    const html   = await buildBuiltinEmailHtml(config);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-tb-${dateStr}.html"`);
    res.send(html);
  } catch(e) { res.status(500).send(`Erreur : ${e.message}`); }
});

router.get('/builtin-export/pdf', async (req, res) => {
  try {
    const config = builtinConfigFromQuery(req.query);
    config._userDatabase = req.user?.database;
    config._userConnId   = req.user?.connId;
    config._societe      = req.user?.societe;
    const buf    = await buildBuiltinPdf(config);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="rapport-tb-${dateStr}.pdf"`);
    res.send(buf);
  } catch(e) { res.status(500).send(`Erreur : ${e.message}`); }
});

// [DIAG] Endpoint temporaire pour comparer viewer vs export sur la même période
// Usage : /api/commercial/diag-ca?asof=2026-04-25&annee=ytd_exe:2025-10-01:2026-09-30
router.get('/diag-ca', async (req, res) => {
  try {
    const pools = await getConnPools(req.query.dbs, req.user?.database);
    const now = parseToday(req.query);
    const yn = now.getFullYear(), mn = now.getMonth()+1, dn = now.getDate();
    const md = `${yn}-${pad(mn)}-01`;
    const mf = `${yn}-${pad(mn)}-${pad(dn)}`;

    // Requête simple sur la période "Mois en cours" — formule unifiée
    const SQL = `
      SELECT
        SUM(${exprCA()}) AS ca,
        COUNT(*) AS nb_lignes,
        COUNT(DISTINCT pl.PCVID) AS nb_pieces
      ${LINE_FROM}
      WHERE ${LINE_WHERE_FACT}
        AND pv.PCVDATEEFFET >= @md AND pv.PCVDATEEFFET <= @mf`;

    // Variante avec filtre actif=O (comme le viewer)
    const SQL_ACTIF = SQL + `
        AND pv.TIRID_REP IN (SELECT TIRID FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='O')`;

    const out = [];
    for (const { pool, id } of pools) {
      const [rNoFilter, rActif] = await Promise.all([
        pool.request().input('md', sql.VarChar(10), md).input('mf', sql.VarChar(10), mf).query(SQL),
        pool.request().input('md', sql.VarChar(10), md).input('mf', sql.VarChar(10), mf).query(SQL_ACTIF),
      ]);
      out.push({
        db: id,
        periode: { md, mf },
        sans_filtre_actif: rNoFilter.recordset[0],   // = ce que renvoie l'export
        avec_filtre_actif: rActif.recordset[0],       // = ce que renvoie le viewer
        diff_ca: parseFloat(rActif.recordset[0].ca) - parseFloat(rNoFilter.recordset[0].ca),
      });
    }
    res.json({ now: `${yn}-${pad(mn)}-${pad(dn)}`, results: out, sql_no_filter: SQL, sql_actif: SQL_ACTIF });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Objectifs commerciaux : CRUD + réalisation
// ───────────────────────────────────────────────────────────────────────────
// Stockage : data/objectifs.json — tableau de configurations.
// Chaque config : { id, label, type:'calendaire'|'exercice', dateDebut, dateFin,
//                   scope:'global'|'commercial'|'both',  // portée de l'objectif (sections affichées dans rapport et éditeur)
//                   indicator:'CAHT'|'QTE'|'CARTONS'|'MGSF'|'MGAF',  // indicateur sur lequel porte l'objectif
//                   refYears:[1,2,...]                 // années de référence (offsets : 1=N-1, 2=N-2…) pour la base de calcul (moyenne)
//                   dimClient, dimArticle,             // dimensions de la section "Objectif global"
//                   dimClientComm, dimArticleComm,     // dimensions de la section "Par commercial" (indépendantes)
//                   global:[12],
//                   clientDim:{value:[12]}, articleDim:{value:[12]},        // niveau global (utilisent dimClient/dimArticle)
//                   commerciaux:{ TIRID: { total:[12],
//                                          clientDim:{value:[12]},          // niveau commercial (utilisent dimClientComm/dimArticleComm)
//                                          articleDim:{value:[12]} } } }
// Les 12 valeurs sont des montants CA HT en €, en ordre chronologique depuis dateDebut.
// Les rep listés sont les actifs uniquement (TIRISACTIF='O').
// Rétro-compat : si commerciaux[TIRID] est un tableau (ancien format), il est lu comme { total: <array> }.

const OBJECTIFS_FILE = path.join(__dirname, '../../data/objectifs.json');
const OBJ_CLIENT_DIMS  = ['TIRCATEGORIE','TIRACTIVITE','TIRGEO','TIRBRANCHE','TIRENSEIGNE','TIRORIGINE','TIRCIBLE1','TIRCIBLE2'];
const OBJ_ARTICLE_DIMS = ['ARTFAMILLE','ARTSOUSFAMILLE','ARTCATEGORIE','ARTNATURE','ARTCOLLECTION','ARTMARQUE','ARTCLASSE'];
const OBJ_INDICATORS   = ['CAHT','QTE','CARTONS','MGSF','MGAF'];

// Retourne l'expression SQL agrégeable pour l'indicateur d'objectif.
// Doit être placée à l'intérieur de SUM(CASE WHEN cond THEN <expr> ELSE 0 END).
// Pour les marges, on utilise PLVLASTPR (dernier prix de revient) en colonne de référence.
function exprForObjIndicator(ind) {
  switch (ind) {
    case 'QTE':     return exprQte();
    case 'CARTONS': return `CASE WHEN pn.PINNATURESTOCK='R' AND ISNULL(a.ARTPCB,0)>0 THEN ${SIGNED_QTE}*1.0/a.ARTPCB ELSE 0 END`;
    case 'MGSF':    return exprMgSf('PLVLASTPR');
    case 'MGAF':    return exprMgAf('PLVLASTPR');
    case 'CAHT':
    default:        return exprCA();
  }
}

function objGenId() { return 'obj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function readObjectifs() {
  try { return JSON.parse(fs.readFileSync(OBJECTIFS_FILE, 'utf8')); } catch { return []; }
}
function writeObjectifs(arr) {
  fs.mkdirSync(path.dirname(OBJECTIFS_FILE), { recursive: true });
  fs.writeFileSync(OBJECTIFS_FILE, JSON.stringify(arr, null, 2));
}

// Normalise / sécurise la config reçue par l'API
function sanitizeObjectif(input, existingId) {
  const o = input || {};
  const arr12 = (a) => {
    const out = Array(12).fill(0);
    if (Array.isArray(a)) for (let i = 0; i < 12 && i < a.length; i++) out[i] = parseFloat(a[i]) || 0;
    return out;
  };
  const dimMap = (m) => {
    const out = {};
    if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) out[String(k)] = arr12(v);
    return out;
  };
  // Commerciaux : { TIRID: { total:[12], clientDim:{}, articleDim:{} } }
  // Rétro-compat : si la valeur est un tableau, on la wrap dans { total: arr }.
  const commMap = (m) => {
    const out = {};
    if (m && typeof m === 'object') {
      for (const [k, v] of Object.entries(m)) {
        if (Array.isArray(v)) {
          out[String(k)] = { total: arr12(v), clientDim: {}, articleDim: {} };
        } else if (v && typeof v === 'object') {
          out[String(k)] = {
            total:      arr12(v.total),
            clientDim:  dimMap(v.clientDim),
            articleDim: dimMap(v.articleDim),
          };
        }
      }
    }
    return out;
  };
  const dimClient      = OBJ_CLIENT_DIMS.includes(o.dimClient)      ? o.dimClient      : null;
  const dimArticle     = OBJ_ARTICLE_DIMS.includes(o.dimArticle)    ? o.dimArticle     : null;
  // dimClientComm / dimArticleComm : si absents en entrée (legacy), recopier depuis dimClient/dimArticle.
  // S'ils sont explicitement présents (même null), on respecte ce choix.
  const dimClientComm  = ('dimClientComm'  in (o || {}))
    ? (OBJ_CLIENT_DIMS.includes(o.dimClientComm)   ? o.dimClientComm   : null)
    : dimClient;
  const dimArticleComm = ('dimArticleComm' in (o || {}))
    ? (OBJ_ARTICLE_DIMS.includes(o.dimArticleComm) ? o.dimArticleComm  : null)
    : dimArticle;
  const scope = ['global','commercial','both'].includes(o.scope) ? o.scope : 'both';
  const indicator = OBJ_INDICATORS.includes(o.indicator) ? o.indicator : 'CAHT';
  // refYears : tableau d'offsets entiers entre 1 et 5, dédupliqués, triés. Si vide → [1] (N-1).
  let refYears = Array.isArray(o.refYears)
    ? o.refYears.map(n => parseInt(n)).filter(n => Number.isInteger(n) && n >= 1 && n <= 5)
    : [];
  refYears = Array.from(new Set(refYears)).sort((a, b) => a - b);
  if (!refYears.length) refYears = [1];
  // pctMap : % de répartition automatique mémorisés par ligne ; persisté pour qu'un
  // retour à l'éditeur restaure les saisies. Structure :
  //   { global:n, comm:{TIRID:n}, cd:{val:n}, ad:{val:n}, commCd:{TIRID:{val:n}}, commAd:{...} }
  const numPct = (v, def = 100) => {
    const n = parseFloat(v);
    return isFinite(n) ? Math.max(0, Math.min(500, n)) : def;
  };
  const flatPct = (m) => {
    const out = {};
    if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) out[String(k)] = numPct(v);
    return out;
  };
  const nestedPct = (m) => {
    const out = {};
    if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) out[String(k)] = flatPct(v);
    return out;
  };
  const sanitizePctMap = (m) => {
    if (!m || typeof m !== 'object') return null;
    return {
      global: numPct(m.global, 100),
      comm:   flatPct(m.comm),
      cd:     flatPct(m.cd),
      ad:     flatPct(m.ad),
      commCd: nestedPct(m.commCd),
      commAd: nestedPct(m.commAd),
    };
  };
  // saisonnalite : vecteur 12 nombres (% par mois) — null si non personnalisée
  // (auquel cas la saisonnalité naturelle des données de référence est utilisée).
  const sanitizeSaison = (a) => {
    if (!Array.isArray(a) || a.length !== 12) return null;
    const out = a.map(v => { const n = parseFloat(v); return isFinite(n) ? Math.max(0, n) : 0; });
    if (out.every(v => v === 0)) return null;
    return out;
  };
  // groups : tableau d'IDs de groupes autorisés à voir cet objectif. ['*'] = tout le monde.
  // Si vide ou invalide → fallback ['*'] (visible par tous).
  const sanitizeGroups = (g) => {
    if (!Array.isArray(g)) return ['*'];
    const out = g.map(x => String(x || '').trim()).filter(Boolean);
    if (!out.length) return ['*'];
    if (out.includes('*')) return ['*'];
    return Array.from(new Set(out));
  };
  return {
    id: existingId || o.id || objGenId(),
    label: String(o.label || '').slice(0, 200) || 'Objectifs',
    type: o.type === 'exercice' ? 'exercice' : 'calendaire',
    scope,
    indicator,
    refYears,
    dateDebut: typeof o.dateDebut === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.dateDebut) ? o.dateDebut : null,
    dateFin:   typeof o.dateFin   === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.dateFin)   ? o.dateFin   : null,
    dimClient,
    dimArticle,
    dimClientComm,
    dimArticleComm,
    groups:      sanitizeGroups(o.groups),
    global:      arr12(o.global),
    commerciaux: commMap(o.commerciaux),
    clientDim:   dimMap(o.clientDim),
    articleDim:  dimMap(o.articleDim),
    pctMap:      sanitizePctMap(o.pctMap),
    saisonnalite: sanitizeSaison(o.saisonnalite),
  };
}

// Lecture d'un objectif depuis le fichier — applique la rétro-compat sur les commerciaux et les comm dims.
function readObjectifsMigrated() {
  const list = readObjectifs();
  for (const o of list) {
    if (!o) continue;
    // Rétro-compat scope : avant l'introduction du champ, tous les objectifs étaient "both".
    if (!['global','commercial','both'].includes(o.scope)) o.scope = 'both';
    // Rétro-compat indicator : avant l'introduction du champ, les objectifs étaient en CA HT.
    if (!OBJ_INDICATORS.includes(o.indicator)) o.indicator = 'CAHT';
    // Rétro-compat refYears : avant l'introduction du champ, la base était N-1 uniquement.
    if (!Array.isArray(o.refYears) || !o.refYears.length) o.refYears = [1];
    // Rétro-compat : avant la séparation global/commercial des dimensions, dimClient/dimArticle servait aux deux.
    if (!('dimClientComm'  in o)) o.dimClientComm  = OBJ_CLIENT_DIMS.includes(o.dimClient)   ? o.dimClient   : null;
    if (!('dimArticleComm' in o)) o.dimArticleComm = OBJ_ARTICLE_DIMS.includes(o.dimArticle) ? o.dimArticle  : null;
    // Rétro-compat groups : avant l'introduction du champ, tous les objectifs étaient visibles par tous.
    if (!Array.isArray(o.groups) || !o.groups.length) o.groups = ['*'];
    if (o.commerciaux && typeof o.commerciaux === 'object') {
      for (const [k, v] of Object.entries(o.commerciaux)) {
        if (Array.isArray(v)) {
          o.commerciaux[k] = { total: v.slice(0, 12).concat(Array(12).fill(0)).slice(0, 12), clientDim: {}, articleDim: {} };
        } else if (v && typeof v === 'object') {
          if (!Array.isArray(v.total)) v.total = Array(12).fill(0);
          if (!v.clientDim  || typeof v.clientDim  !== 'object') v.clientDim  = {};
          if (!v.articleDim || typeof v.articleDim !== 'object') v.articleDim = {};
        }
      }
    }
  }
  return list;
}

// CRUD ----------------------------------------------------------------------

router.get('/objectifs', (req, res) => res.json(readObjectifsMigrated()));

router.get('/objectifs/dims', (req, res) => {
  res.json({ clientDims: OBJ_CLIENT_DIMS, articleDims: OBJ_ARTICLE_DIMS });
});

router.get('/objectifs/:id', (req, res) => {
  const o = readObjectifsMigrated().find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Introuvable' });
  res.json(o);
});

router.post('/objectifs', (req, res) => {
  const list = readObjectifs();
  const o = sanitizeObjectif(req.body);
  o.createdAt = new Date().toISOString();
  list.push(o); writeObjectifs(list);
  res.status(201).json(o);
});

router.put('/objectifs/:id', (req, res) => {
  const list = readObjectifs();
  const idx = list.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  const sanitized = sanitizeObjectif(req.body, req.params.id);
  sanitized.createdAt = list[idx].createdAt;
  sanitized.updatedAt = new Date().toISOString();
  list[idx] = sanitized;
  writeObjectifs(list);
  res.json(sanitized);
});

router.delete('/objectifs/:id', (req, res) => {
  const list = readObjectifs();
  const idx = list.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  list.splice(idx, 1);
  writeObjectifs(list);
  res.json({ ok: true });
});

// Liste des valeurs distinctes d'une dim client/article — pour seeder l'éditeur backoffice
router.get('/objectifs-dim-values', async (req, res) => {
  const dim = String(req.query.dim || '');
  const isClient  = OBJ_CLIENT_DIMS.includes(dim);
  const isArticle = OBJ_ARTICLE_DIMS.includes(dim);
  if (!isClient && !isArticle) return res.status(400).json({ error: 'Dimension invalide' });
  try {
    const pool = await resolveCommercialPool(req);
    let result;
    if (isClient) {
      result = await pool.request().query(`
        SELECT DISTINCT TOP 500 RTRIM([${dim}]) AS val
        FROM TIERS WITH (NOLOCK)
        WHERE TIRTYPE='C' AND [${dim}] IS NOT NULL AND LEN(RTRIM([${dim}])) > 0
        ORDER BY val
      `);
    } else if (dim === 'ARTFAMILLE') {
      result = await pool.request().query(`
        SELECT DISTINCT TOP 500 RTRIM(af.AFMINTITULE) AS val
        FROM ARTFAMILLES af WITH (NOLOCK)
        WHERE af.AFMINTITULE IS NOT NULL AND LEN(RTRIM(af.AFMINTITULE)) > 0
        ORDER BY val
      `);
    } else {
      result = await pool.request().query(`
        SELECT DISTINCT TOP 500 RTRIM([${dim}]) AS val
        FROM ARTICLES WITH (NOLOCK)
        WHERE [${dim}] IS NOT NULL AND LEN(RTRIM([${dim}])) > 0
        ORDER BY val
      `);
    }
    res.json(result.recordset.map(r => r.val));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liste des commerciaux actifs (raccourci pour l'éditeur d'objectifs)
router.get('/objectifs-commerciaux', async (req, res) => {
  try {
    const pool = await resolveCommercialPool(req);
    const result = await pool.request().query(`
      SELECT TIRID, RTRIM(TIRSOCIETE) AS nom
      FROM TIERS WITH (NOLOCK)
      WHERE TIRTYPE='R' AND TIRISACTIF='O'
      ORDER BY TIRSOCIETE
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Base de calcul (CA des années de référence, moyenne) groupée par mois × niveau (global/commercial/dimClient/dimArticle).
// Utilisé par le backoffice pour pré-remplir les objectifs en mode "% × base".
// Query : dateDebut, dateFin,
//         dimClient/dimArticle (dims du niveau global, optionnels),
//         dimClientComm/dimArticleComm (dims du niveau par-commercial, optionnels),
//         indicator (CAHT|QTE|CARTONS|MGSF|MGAF, défaut CAHT),
//         refYears (entiers 1..5 séparés par virgule, défaut "1"),
//         dbs (optionnel)
router.get('/objectifs-n1-ca', async (req, res) => {
  const dateDebut = String(req.query.dateDebut || '');
  const dateFin   = String(req.query.dateFin   || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDebut) || !/^\d{4}-\d{2}-\d{2}$/.test(dateFin)) {
    return res.status(400).json({ error: 'Période invalide (dateDebut/dateFin requis au format YYYY-MM-DD)' });
  }
  const shiftYear = (s, delta) => {
    const p = s.split('-');
    return `${parseInt(p[0]) + delta}-${p[1]}-${p[2]}`;
  };

  const dimC  = OBJ_CLIENT_DIMS.includes(req.query.dimClient)      ? req.query.dimClient      : null;
  const dimA  = OBJ_ARTICLE_DIMS.includes(req.query.dimArticle)    ? req.query.dimArticle    : null;
  const dimCc = OBJ_CLIENT_DIMS.includes(req.query.dimClientComm)  ? req.query.dimClientComm  : null;
  const dimAc = OBJ_ARTICLE_DIMS.includes(req.query.dimArticleComm)? req.query.dimArticleComm : null;
  const indicator = OBJ_INDICATORS.includes(req.query.indicator) ? req.query.indicator : 'CAHT';
  const measureExpr = exprForObjIndicator(indicator);

  // refYears : tableau d'offsets (1..5). Défaut [1] (= N-1).
  let refYears = String(req.query.refYears || '1').split(',')
    .map(s => parseInt(s.trim()))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 5);
  refYears = Array.from(new Set(refYears)).sort((a, b) => a - b);
  if (!refYears.length) refYears = [1];

  try {
    const pools = await getConnPools(req.query.dbs, req.user);
    const moisIdxExpr = `(DATEDIFF(month, @dateDebut, pv.PCVDATEEFFET) + 1)`;
    const dateF       = `pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin`;
    // Inclut TOUTES les ventes (rep actif, rep inactif, rep null). Les ventes orphelines
    // (rep non actif ou null) sont bucketisées sous repid='__none__' (« Non assigné »)
    // pour aligner les totaux avec /rapport-ca et /rapport-ca-commerciaux.
    const repidExpr   = `ISNULL(CAST(tr.TIRID AS VARCHAR(20)), '__none__')`;
    const repJoin     = `LEFT JOIN TIERS tr WITH (NOLOCK) ON tr.TIRID=pv.TIRID_REP AND tr.TIRTYPE='R' AND tr.TIRISACTIF='O'`;

    // Pour chaque pool × chaque année de référence, lance les 6 queries de breakdown.
    const queriesPerPoolPerYear = [];
    for (const { pool } of pools) {
      for (const offset of refYears) {
        const debut = shiftYear(dateDebut, -offset);
        const fin   = shiftYear(dateFin,   -offset);
        const mkR = () => pool.request()
          .input('dateDebut', sql.VarChar(10), debut)
          .input('dateFin',   sql.VarChar(10), fin);
        queriesPerPoolPerYear.push(Promise.all([
          mkR().query(`
            SELECT ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
            ${LINE_FROM}
            WHERE ${LINE_WHERE_FACT} AND ${dateF}
            GROUP BY ${moisIdxExpr}
          `),
          mkR().query(`
            SELECT ${repidExpr} AS repid, ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
            ${LINE_FROM}
            ${repJoin}
            WHERE ${LINE_WHERE_FACT} AND ${dateF}
            GROUP BY ${repidExpr}, ${moisIdxExpr}
          `),
          dimC ? mkR().query(`
            SELECT ISNULL(RTRIM(t.[${dimC}]), 'Non défini') AS val,
                   ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
            ${LINE_FROM}
            JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID
            WHERE ${LINE_WHERE_FACT} AND t.TIRTYPE='C' AND ${dateF}
            GROUP BY t.[${dimC}], ${moisIdxExpr}
          `) : Promise.resolve({ recordset: [] }),
          dimA ? mkR().query(`
            SELECT ${dimA === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.[${dimA}]), 'Non défini')`} AS val,
                   ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
            ${LINE_FROM}
            ${dimA === 'ARTFAMILLE' ? 'LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID' : ''}
            WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL AND ${dateF}
            GROUP BY ${dimA === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.[${dimA}]`}, ${moisIdxExpr}
          `) : Promise.resolve({ recordset: [] }),
          dimCc ? mkR().query(`
            SELECT ${repidExpr} AS repid, ISNULL(RTRIM(t.[${dimCc}]), 'Non défini') AS val,
                   ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
            ${LINE_FROM}
            JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID
            ${repJoin}
            WHERE ${LINE_WHERE_FACT} AND t.TIRTYPE='C' AND ${dateF}
            GROUP BY ${repidExpr}, t.[${dimCc}], ${moisIdxExpr}
          `) : Promise.resolve({ recordset: [] }),
          dimAc ? mkR().query(`
            SELECT ${repidExpr} AS repid,
                   ${dimAc === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.[${dimAc}]), 'Non défini')`} AS val,
                   ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
            ${LINE_FROM}
            ${repJoin}
            ${dimAc === 'ARTFAMILLE' ? 'LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID' : ''}
            WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL AND ${dateF}
            GROUP BY ${repidExpr}, ${dimAc === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.[${dimAc}]`}, ${moisIdxExpr}
          `) : Promise.resolve({ recordset: [] }),
        ]));
      }
    }
    const allResults = await Promise.all(queriesPerPoolPerYear);

    // Cumul total des années sélectionnées (puis division par refYears.length pour obtenir la moyenne)
    const globalArr = Array(12).fill(0);
    const commMap     = {};
    const cdMap       = {};
    const adMap       = {};
    const commCdMap   = {}; // { repid: { val: [12] } }
    const commAdMap   = {};
    const accumulate = (map, key, idx, ca) => {
      if (idx < 1 || idx > 12) return;
      if (!map[key]) map[key] = Array(12).fill(0);
      map[key][idx - 1] += parseFloat(ca) || 0;
    };
    const accumulate2 = (outerMap, repid, val, idx, ca) => {
      if (idx < 1 || idx > 12) return;
      if (!outerMap[repid]) outerMap[repid] = {};
      if (!outerMap[repid][val]) outerMap[repid][val] = Array(12).fill(0);
      outerMap[repid][val][idx - 1] += parseFloat(ca) || 0;
    };
    for (const [rGlobal, rComm, rCD, rAD, rCommCD, rCommAD] of allResults) {
      for (const row of rGlobal.recordset) {
        const i = parseInt(row.moisIdx);
        if (i >= 1 && i <= 12) globalArr[i - 1] += parseFloat(row.ca) || 0;
      }
      for (const row of rComm.recordset) {
        if (row.repid == null) continue;
        accumulate(commMap, String(row.repid), parseInt(row.moisIdx), row.ca);
      }
      for (const row of rCD.recordset) accumulate(cdMap, String(row.val), parseInt(row.moisIdx), row.ca);
      for (const row of rAD.recordset) accumulate(adMap, String(row.val), parseInt(row.moisIdx), row.ca);
      for (const row of rCommCD.recordset) {
        if (row.repid == null) continue;
        accumulate2(commCdMap, String(row.repid), String(row.val), parseInt(row.moisIdx), row.ca);
      }
      for (const row of rCommAD.recordset) {
        if (row.repid == null) continue;
        accumulate2(commAdMap, String(row.repid), String(row.val), parseInt(row.moisIdx), row.ca);
      }
    }

    // Moyenne sur les années sélectionnées
    const n = refYears.length;
    const avgArr = arr => arr.map(v => v / n);
    const avgMap = (map) => {
      const out = {};
      for (const [k, arr] of Object.entries(map)) out[k] = avgArr(arr);
      return out;
    };
    const avgMap2 = (outer) => {
      const out = {};
      for (const [k, inner] of Object.entries(outer)) out[k] = avgMap(inner);
      return out;
    };

    res.json({
      indicator,
      refYears,
      periodes: refYears.map(o => ({
        offset: o,
        dateDebut: shiftYear(dateDebut, -o),
        dateFin:   shiftYear(dateFin,   -o),
      })),
      // Rétro-compat : on garde periodeN1 pointant sur la première année cochée
      periodeN1: { dateDebut: shiftYear(dateDebut, -refYears[0]), dateFin: shiftYear(dateFin, -refYears[0]) },
      global:      avgArr(globalArr),
      commerciaux: avgMap(commMap),
      clientDim:   avgMap(cdMap),
      articleDim:  avgMap(adMap),
      commerciauxClientDim:  avgMap2(commCdMap),
      commerciauxArticleDim: avgMap2(commAdMap),
    });
  } catch (err) {
    console.error('[objectifs-n1-ca]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Réalisation : retourne CA réalisé par mois pour chaque niveau (global + commercial + dim client + dim article)
router.get('/objectifs/:id/realisation', async (req, res) => {
  const obj = readObjectifsMigrated().find(x => x.id === req.params.id);
  if (!obj) return res.status(404).json({ error: 'Introuvable' });
  if (!obj.dateDebut || !obj.dateFin) return res.status(400).json({ error: 'Période invalide' });
  try {
    const pools = await getConnPools(req.query.dbs, req.user);
    const dimC  = OBJ_CLIENT_DIMS.includes(obj.dimClient)       ? obj.dimClient       : null;
    const dimA  = OBJ_ARTICLE_DIMS.includes(obj.dimArticle)     ? obj.dimArticle      : null;
    const dimCc = OBJ_CLIENT_DIMS.includes(obj.dimClientComm)   ? obj.dimClientComm   : null;
    const dimAc = OBJ_ARTICLE_DIMS.includes(obj.dimArticleComm) ? obj.dimArticleComm  : null;
    const indicator = OBJ_INDICATORS.includes(obj.indicator) ? obj.indicator : 'CAHT';
    const measureExpr = exprForObjIndicator(indicator);

    // Index mois 1..12 depuis dateDebut. dateDebut doit toujours être le 1er d'un mois.
    const moisIdxExpr = `(DATEDIFF(month, @dateDebut, pv.PCVDATEEFFET) + 1)`;
    const dateF       = `pv.PCVDATEEFFET >= @dateDebut AND pv.PCVDATEEFFET <= @dateFin`;
    // Inclut TOUTES les ventes (rep actif, rep inactif, rep null). Les ventes orphelines
    // sont bucketisées sous repid='__none__' (« Non assigné »), aligné avec /objectifs-n1-ca.
    const repidExpr   = `ISNULL(CAST(tr.TIRID AS VARCHAR(20)), '__none__')`;
    const repJoin     = `LEFT JOIN TIERS tr WITH (NOLOCK) ON tr.TIRID=pv.TIRID_REP AND tr.TIRTYPE='R' AND tr.TIRISACTIF='O'`;

    const queriesPerPool = pools.map(({ pool }) => {
      const mkR = () => pool.request()
        .input('dateDebut', sql.VarChar(10), obj.dateDebut)
        .input('dateFin',   sql.VarChar(10), obj.dateFin);
      return Promise.all([
        mkR().query(`
          SELECT ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
          ${LINE_FROM}
          WHERE ${LINE_WHERE_FACT} AND ${dateF}
          GROUP BY ${moisIdxExpr}
        `),
        mkR().query(`
          SELECT ${repidExpr} AS repid, ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
          ${LINE_FROM}
          ${repJoin}
          WHERE ${LINE_WHERE_FACT} AND ${dateF}
          GROUP BY ${repidExpr}, ${moisIdxExpr}
        `),
        dimC ? mkR().query(`
          SELECT ISNULL(RTRIM(t.[${dimC}]), 'Non défini') AS val,
                 ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
          ${LINE_FROM}
          JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID
          WHERE ${LINE_WHERE_FACT} AND t.TIRTYPE='C' AND ${dateF}
          GROUP BY t.[${dimC}], ${moisIdxExpr}
        `) : Promise.resolve({ recordset: [] }),
        dimA ? mkR().query(`
          SELECT ${dimA === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.[${dimA}]), 'Non défini')`} AS val,
                 ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
          ${LINE_FROM}
          ${dimA === 'ARTFAMILLE' ? 'LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID' : ''}
          WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL AND ${dateF}
          GROUP BY ${dimA === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.[${dimA}]`}, ${moisIdxExpr}
        `) : Promise.resolve({ recordset: [] }),
        dimCc ? mkR().query(`
          SELECT ${repidExpr} AS repid, ISNULL(RTRIM(t.[${dimCc}]), 'Non défini') AS val,
                 ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
          ${LINE_FROM}
          JOIN TIERS t WITH (NOLOCK) ON t.TIRID=pv.TIRID
          ${repJoin}
          WHERE ${LINE_WHERE_FACT} AND t.TIRTYPE='C' AND ${dateF}
          GROUP BY ${repidExpr}, t.[${dimCc}], ${moisIdxExpr}
        `) : Promise.resolve({ recordset: [] }),
        dimAc ? mkR().query(`
          SELECT ${repidExpr} AS repid,
                 ${dimAc === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.[${dimAc}]), 'Non défini')`} AS val,
                 ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
          ${LINE_FROM}
          ${repJoin}
          ${dimAc === 'ARTFAMILLE' ? 'LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID' : ''}
          WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL AND ${dateF}
          GROUP BY ${repidExpr}, ${dimAc === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.[${dimAc}]`}, ${moisIdxExpr}
        `) : Promise.resolve({ recordset: [] }),
        // Détail article par valeur de la dim article (option B : objectif au prorata calculé client/serveur)
        // ARTISACTIF inclus pour regrouper les articles inactifs sur une ligne agrégée côté JS
        dimA ? mkR().query(`
          SELECT ${dimA === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.[${dimA}]), 'Non défini')`} AS dimVal,
                 a.ARTID AS artid, RTRIM(a.ARTCODE) AS code, RTRIM(a.ARTDESIGNATION) AS designation,
                 a.ARTISACTIF AS isactif,
                 ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
          ${LINE_FROM}
          ${dimA === 'ARTFAMILLE' ? 'LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID' : ''}
          WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL AND ${dateF}
          GROUP BY ${dimA === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.[${dimA}]`}, a.ARTID, a.ARTCODE, a.ARTDESIGNATION, a.ARTISACTIF, ${moisIdxExpr}
        `) : Promise.resolve({ recordset: [] }),
        // Détail article par commercial × dim article du commercial — permet le drill-down article sous chaque commercial
        dimAc ? mkR().query(`
          SELECT ${repidExpr} AS repid,
                 ${dimAc === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.[${dimAc}]), 'Non défini')`} AS dimVal,
                 a.ARTID AS artid, RTRIM(a.ARTCODE) AS code, RTRIM(a.ARTDESIGNATION) AS designation,
                 a.ARTISACTIF AS isactif,
                 ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
          ${LINE_FROM}
          ${repJoin}
          ${dimAc === 'ARTFAMILLE' ? 'LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID' : ''}
          WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL AND ${dateF}
          GROUP BY ${repidExpr}, ${dimAc === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.[${dimAc}]`}, a.ARTID, a.ARTCODE, a.ARTDESIGNATION, a.ARTISACTIF, ${moisIdxExpr}
        `) : Promise.resolve({ recordset: [] }),
      ]);
    });
    const allResults = await Promise.all(queriesPerPool);

    // Détail article N-1 (prorata) — interrogé séparément avec dates décalées par refYears
    const refYearsForObj = Array.isArray(obj.refYears) && obj.refYears.length ? obj.refYears : [1];
    const shiftYear = (s, delta) => { const p = s.split('-'); return `${parseInt(p[0]) + delta}-${p[1]}-${p[2]}`; };
    const articleN1Results = dimA ? await Promise.all(pools.flatMap(({ pool }) =>
      refYearsForObj.map(offset => {
        const debut = shiftYear(obj.dateDebut, -offset);
        const fin   = shiftYear(obj.dateFin,   -offset);
        return pool.request()
          .input('dateDebut', sql.VarChar(10), debut)
          .input('dateFin',   sql.VarChar(10), fin)
          .query(`
            SELECT ${dimA === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.[${dimA}]), 'Non défini')`} AS dimVal,
                   a.ARTID AS artid, a.ARTISACTIF AS isactif,
                   ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
            ${LINE_FROM}
            ${dimA === 'ARTFAMILLE' ? 'LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID' : ''}
            WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL AND ${dateF}
            GROUP BY ${dimA === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.[${dimA}]`}, a.ARTID, a.ARTISACTIF, ${moisIdxExpr}
          `);
      })
    )) : [];

    // Détail article N-1 par commercial × dim article du commercial — pour prorata d'objectif au niveau article par commercial
    const commArticleN1Results = dimAc ? await Promise.all(pools.flatMap(({ pool }) =>
      refYearsForObj.map(offset => {
        const debut = shiftYear(obj.dateDebut, -offset);
        const fin   = shiftYear(obj.dateFin,   -offset);
        return pool.request()
          .input('dateDebut', sql.VarChar(10), debut)
          .input('dateFin',   sql.VarChar(10), fin)
          .query(`
            SELECT ${repidExpr} AS repid,
                   ${dimAc === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE), 'Sans famille')` : `ISNULL(RTRIM(a.[${dimAc}]), 'Non défini')`} AS dimVal,
                   a.ARTID AS artid, a.ARTISACTIF AS isactif,
                   ${moisIdxExpr} AS moisIdx, SUM(${measureExpr}) AS ca
            ${LINE_FROM}
            ${repJoin}
            ${dimAc === 'ARTFAMILLE' ? 'LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID' : ''}
            WHERE ${LINE_WHERE_FACT} AND pl.ARTID IS NOT NULL AND ${dateF}
            GROUP BY ${repidExpr}, ${dimAc === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.[${dimAc}]`}, a.ARTID, a.ARTISACTIF, ${moisIdxExpr}
          `);
      })
    )) : [];

    // Agrégation à travers les pools
    const globalReal = Array(12).fill(0);
    const commRealMap   = new Map();
    const cdRealMap     = new Map();
    const adRealMap     = new Map();
    const commCdRealMap = new Map(); // repid → Map(val → [12])
    const commAdRealMap = new Map();
    const accumulate = (map, key, idx, ca) => {
      if (idx < 1 || idx > 12) return;
      if (!map.has(key)) map.set(key, Array(12).fill(0));
      map.get(key)[idx - 1] += parseFloat(ca) || 0;
    };
    const accumulate2 = (outerMap, repid, val, idx, ca) => {
      if (idx < 1 || idx > 12) return;
      if (!outerMap.has(repid)) outerMap.set(repid, new Map());
      const inner = outerMap.get(repid);
      if (!inner.has(val)) inner.set(val, Array(12).fill(0));
      inner.get(val)[idx - 1] += parseFloat(ca) || 0;
    };
    // Détail article courant : Map(dimVal → Map(artid → { code, designation, monthly[12], inactif?, _ids? }))
    const articleCurMap = new Map();
    // Détail article N-1 (cumul × refYears) : Map(dimVal → Map(artid → monthly[12]))
    const articleN1Map  = new Map();
    // Détail article courant par commercial : Map(repid → Map(dimVal → Map(artid → { code, designation, monthly[12], inactif?, _ids? })))
    const commArticleCurMap = new Map();
    const commArticleN1Map  = new Map();
    // Pseudo-id agrégé pour les articles inactifs (ARTISACTIF='N') — ils partagent une ligne unique par dimVal
    const INACTIFS_KEY = '__INACTIFS__';
    const accArticle = (outer, dimVal, artid, code, designation, isactif, idx, ca) => {
      if (idx < 1 || idx > 12) return;
      const k = String(dimVal);
      if (!outer.has(k)) outer.set(k, new Map());
      const inner = outer.get(k);
      const isActive = isactif === 'O';
      const a = isActive ? String(artid) : INACTIFS_KEY;
      if (!inner.has(a)) {
        inner.set(a, isActive
          ? { code, designation, monthly: Array(12).fill(0), inactif: false }
          : { code: '—', designation: 'Articles inactifs', monthly: Array(12).fill(0), inactif: true, _ids: new Set() });
      }
      inner.get(a).monthly[idx - 1] += parseFloat(ca) || 0;
      if (!isActive) inner.get(a)._ids.add(String(artid));
    };
    const accArticleN1 = (dimVal, artid, isactif, idx, ca) => {
      if (idx < 1 || idx > 12) return;
      const k = String(dimVal);
      if (!articleN1Map.has(k)) articleN1Map.set(k, new Map());
      const inner = articleN1Map.get(k);
      const a = isactif === 'O' ? String(artid) : INACTIFS_KEY;
      if (!inner.has(a)) inner.set(a, Array(12).fill(0));
      inner.get(a)[idx - 1] += parseFloat(ca) || 0;
    };
    // Variantes scopées par commercial
    const accCommArticle = (repid, dimVal, artid, code, designation, isactif, idx, ca) => {
      if (idx < 1 || idx > 12) return;
      const r = String(repid);
      if (!commArticleCurMap.has(r)) commArticleCurMap.set(r, new Map());
      accArticle(commArticleCurMap.get(r), dimVal, artid, code, designation, isactif, idx, ca);
    };
    const accCommArticleN1 = (repid, dimVal, artid, isactif, idx, ca) => {
      if (idx < 1 || idx > 12) return;
      const r = String(repid);
      if (!commArticleN1Map.has(r)) commArticleN1Map.set(r, new Map());
      const byDim = commArticleN1Map.get(r);
      const k = String(dimVal);
      if (!byDim.has(k)) byDim.set(k, new Map());
      const inner = byDim.get(k);
      const a = isactif === 'O' ? String(artid) : INACTIFS_KEY;
      if (!inner.has(a)) inner.set(a, Array(12).fill(0));
      inner.get(a)[idx - 1] += parseFloat(ca) || 0;
    };
    for (const [rGlobal, rComm, rCD, rAD, rCommCD, rCommAD, rArtCur, rCommArtCur] of allResults) {
      for (const row of rGlobal.recordset) {
        const i = parseInt(row.moisIdx);
        if (i >= 1 && i <= 12) globalReal[i - 1] += parseFloat(row.ca) || 0;
      }
      for (const row of rComm.recordset) {
        if (row.repid == null) continue;
        accumulate(commRealMap, String(row.repid), parseInt(row.moisIdx), row.ca);
      }
      for (const row of rCD.recordset) accumulate(cdRealMap, String(row.val), parseInt(row.moisIdx), row.ca);
      for (const row of rAD.recordset) accumulate(adRealMap, String(row.val), parseInt(row.moisIdx), row.ca);
      for (const row of rCommCD.recordset) {
        if (row.repid == null) continue;
        accumulate2(commCdRealMap, String(row.repid), String(row.val), parseInt(row.moisIdx), row.ca);
      }
      for (const row of rCommAD.recordset) {
        if (row.repid == null) continue;
        accumulate2(commAdRealMap, String(row.repid), String(row.val), parseInt(row.moisIdx), row.ca);
      }
      if (rArtCur) {
        for (const row of rArtCur.recordset) {
          accArticle(articleCurMap, row.dimVal, row.artid, row.code, row.designation, row.isactif, parseInt(row.moisIdx), row.ca);
        }
      }
      if (rCommArtCur) {
        for (const row of rCommArtCur.recordset) {
          if (row.repid == null) continue;
          accCommArticle(row.repid, row.dimVal, row.artid, row.code, row.designation, row.isactif, parseInt(row.moisIdx), row.ca);
        }
      }
    }
    // N-1 article : cumul brut sur toutes les années de référence (on divisera par refYears.length à la fin)
    for (const r of articleN1Results) {
      for (const row of r.recordset) {
        accArticleN1(row.dimVal, row.artid, row.isactif, parseInt(row.moisIdx), row.ca);
      }
    }
    for (const r of commArticleN1Results) {
      for (const row of r.recordset) {
        if (row.repid == null) continue;
        accCommArticleN1(row.repid, row.dimVal, row.artid, row.isactif, parseInt(row.moisIdx), row.ca);
      }
    }
    if (refYearsForObj.length > 1) {
      const n = refYearsForObj.length;
      for (const inner of articleN1Map.values()) {
        for (const arr of inner.values()) for (let i = 0; i < 12; i++) arr[i] /= n;
      }
      for (const byDim of commArticleN1Map.values()) {
        for (const inner of byDim.values()) {
          for (const arr of inner.values()) for (let i = 0; i < 12; i++) arr[i] /= n;
        }
      }
    }

    // Libellés commerciaux (depuis le 1er pool)
    const commLabels = {};
    if (pools.length) {
      try {
        const labQ = await pools[0].pool.request().query(`
          SELECT TIRID, RTRIM(TIRSOCIETE) AS nom, TIRISACTIF
          FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R'
        `);
        for (const row of labQ.recordset) commLabels[String(row.TIRID)] = { nom: row.nom, actif: row.TIRISACTIF === 'O' };
      } catch {}
    }
    // Bucket synthétique pour les ventes orphelines (rep null/inactif). actif:true pour passer
    // le filtre commerciaux ci-dessous, comme les reps actifs.
    commLabels['__none__'] = { nom: 'Non assigné', actif: true };

    // Construction des breakdowns (union clés objectif + clés réalisé), triées par CA réalisé DESC
    const sumArr = a => a.reduce((s, v) => s + (parseFloat(v) || 0), 0);
    const buildBreakdown = (objMap, realMap, labelFn) => {
      const keys = new Set([...Object.keys(objMap || {}), ...realMap.keys()]);
      return [...keys].map(k => ({
        key: k,
        label: labelFn(k),
        objectif: (objMap || {})[k] || Array(12).fill(0),
        realise:  realMap.get(k)   || Array(12).fill(0),
      })).sort((a, b) => sumArr(b.realise) - sumArr(a.realise));
    };
    // Pour chaque commercial : breakdown par valeur dim. objMap2 = { val:[12] } extrait du commercial.
    const buildSubBreakdown = (objMap2, realInner, labelFn) => {
      const keys = new Set([...Object.keys(objMap2 || {}), ...((realInner && realInner.keys()) || [])]);
      return [...keys].map(k => ({
        key: k,
        label: labelFn(k),
        objectif: (objMap2 || {})[k] || Array(12).fill(0),
        realise:  (realInner && realInner.get(k)) || Array(12).fill(0),
      })).sort((a, b) => sumArr(b.realise) - sumArr(a.realise));
    };

    // Pour chaque commercial × dim article, on enrichit la sous-table par son détail article
    // (prorata d'objectif au niveau article, calculé sur le N-1 propre au commercial × dim).
    const buildCommArticleBreakdown = (objCommArticleDim, repId) => {
      if (!dimAc) return [];
      const baseRows = buildSubBreakdown(objCommArticleDim, commAdRealMap.get(repId), v => v);
      const cur = commArticleCurMap.get(String(repId)) || new Map();
      const n1  = commArticleN1Map.get(String(repId))  || new Map();
      return baseRows.map(row => {
        const k = String(row.key);
        const curInner = cur.get(k) || new Map();
        const n1Inner  = n1.get(k)  || new Map();
        const dimN1Monthly = Array(12).fill(0);
        for (const arr of n1Inner.values()) arr.forEach((v, i) => dimN1Monthly[i] += v);
        const allArtIds = new Set([...curInner.keys(), ...n1Inner.keys()]);
        const articles = [...allArtIds].map(artid => {
          const c = curInner.get(artid) || { code: '', designation: '', monthly: Array(12).fill(0) };
          const n1Arr = n1Inner.get(artid) || Array(12).fill(0);
          const objArt = row.objectif.map((mObj, m) => {
            const tot = dimN1Monthly[m];
            if (!tot || !n1Arr[m]) return 0;
            return mObj * (n1Arr[m] / tot);
          });
          const isInactifGroup = artid === INACTIFS_KEY;
          return {
            artid,
            code: c.code || '',
            designation: isInactifGroup ? `Articles inactifs (${c._ids?.size || 0})` : (c.designation || ''),
            objectif: objArt,
            realise: c.monthly,
            n1: n1Arr,
            inactif: !!c.inactif,
          };
        }).sort((a, b) => sumArr(b.realise) - sumArr(a.realise));
        return { ...row, articles };
      });
    };

    // commerciaux : on ajoute clientDim et articleDim quand les dims comm sont configurées.
    // Filtre : on ne garde que les commerciaux actifs (TIRISACTIF='O') ayant au moins un CA
    // sur la période, soit en objectif soit en réalisé.
    // Sous-dimensions par commercial : on filtre les valeurs sans réalisé sur la période —
    // évite de remonter les valeurs orphelines (config sur une ancienne dim toujours dans pctMap).
    const onlyWithRealise = arr => arr.filter(r => sumArr(r.realise) > 0);
    const commObj = obj.commerciaux || {};
    const commKeys = new Set([...Object.keys(commObj), ...commRealMap.keys()]);
    const commerciaux = [...commKeys]
      .map(k => {
        const objCom = commObj[k] || {};
        const objectif = objCom.total || Array(12).fill(0);
        const realise  = commRealMap.get(k) || Array(12).fill(0);
        return {
          key: k,
          label: commLabels[k]?.nom || `Rep ${k}`,
          actif: commLabels[k]?.actif === true,
          objectif,
          realise,
          clientDim:  dimCc ? onlyWithRealise(buildSubBreakdown(objCom.clientDim, commCdRealMap.get(k), v => v)) : [],
          articleDim: onlyWithRealise(buildCommArticleBreakdown(objCom.articleDim, k)),
        };
      })
      .filter(c => c.actif && (sumArr(c.objectif) > 0 || sumArr(c.realise) > 0))
      .sort((a, b) => sumArr(b.realise) - sumArr(a.realise));

    // Construction articleDim enrichi : pour chaque valeur de dim article, on attache la liste des
    // articles avec leur réalisé courant + leur objectif calculé par prorata mensuel sur N-1.
    // obj_art[m] = obj_marque[m] × art_n1[m] / sum(tous_articles_n1[m]) — préserve la saisonnalité
    // de chaque article tout en respectant la totale mensuelle de la marque.
    const articleDimEnriched = dimA ? buildBreakdown(obj.articleDim, adRealMap, k => k).map(row => {
      const k = String(row.key);
      const cur = articleCurMap.get(k) || new Map();
      const n1  = articleN1Map.get(k)  || new Map();
      // Total N-1 par mois pour cette dim value (dénominateur du prorata)
      const dimN1Monthly = Array(12).fill(0);
      for (const arr of n1.values()) arr.forEach((v, i) => dimN1Monthly[i] += v);
      // Union des artids (réalisé courant + N-1) — un article peut être nouveau sans N-1
      const allArtIds = new Set([...cur.keys(), ...n1.keys()]);
      const articles = [...allArtIds].map(artid => {
        const c = cur.get(artid) || { code: '', designation: '', monthly: Array(12).fill(0) };
        const n1Arr = n1.get(artid) || Array(12).fill(0);
        // Code/designation depuis le réalisé courant en priorité ; sinon depuis N-1 (rare, code/des absents)
        const objArt = row.objectif.map((mObj, m) => {
          const tot = dimN1Monthly[m];
          if (!tot || !n1Arr[m]) return 0;
          return mObj * (n1Arr[m] / tot);
        });
        const isInactifGroup = artid === INACTIFS_KEY;
        return {
          artid,
          code: c.code || '',
          designation: isInactifGroup ? `Articles inactifs (${c._ids?.size || 0})` : (c.designation || ''),
          objectif: objArt,
          realise: c.monthly,
          n1: n1Arr,
          inactif: !!c.inactif,
        };
      }).sort((a, b) => sumArr(b.realise) - sumArr(a.realise));
      return { ...row, articles };
    }) : [];

    res.json({
      config: obj,
      global: { objectif: obj.global || Array(12).fill(0), realise: globalReal },
      commerciaux,
      clientDim:   dimC ? buildBreakdown(obj.clientDim,  cdRealMap, k => k) : [],
      articleDim:  articleDimEnriched,
    });
  } catch (err) {
    console.error('[objectifs realisation]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

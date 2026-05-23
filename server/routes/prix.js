// Rapport prix : croisement EXT_RELEVE_PRIX × ARTICLES × EXT_Produits × EXT_ART_CONCURRENTS
// Compare le prix relevé chez les clients (par les commerciaux mobiles)
// au PV moyen HT calculé sur PIECEVENTELIGNES.
//
// Jointures logiques (pas de FK déclarées) :
//   - EXT_RELEVE_PRIX.REFERENCE_ARTICLE → ARTICLES.ARTCODE  (relevé sur un de NOS articles)
//   - EXT_RELEVE_PRIX.REFERENCE_ARTICLE → EXT_Produits.Code_Produit (relevé sur un produit concurrent)
//   - EXT_Produits.IDProduit → EXT_ART_CONCURRENTS.IDProduit → ARTICLES.ARTID (notre équivalent)
//   - EXT_RELEVE_PRIX.TIRID  → TIERS.TIRID (client où le relevé a eu lieu)

const express = require('express');
const router  = express.Router();
const { getUserPool, getConnPool, sql } = require('../../config/database');

const resolvePrixPool = (req) => {
  const connId = req.query?.connId;
  if (connId && connId !== 'default') return getConnPool(connId);
  return getUserPool(req.user);
};

// Format YYYY-MM-DD validé, sinon null
function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// PRIX_RELEVE est stocké TTC ; pour comparer à mon PV HT (PIECEVENTELIGNES.PLVMNTNETHT)
// on convertit côté SQL via le taux TVA passé en query (défaut 8.5 % — taux normal Guadeloupe).
// Borné [0, 100] pour éviter une division par zéro pathologique.
function parseTva(q) {
  const v = parseFloat(q.tva);
  if (!isFinite(v) || v < 0 || v > 100) return 8.5;
  return v;
}

// Période par défaut : 90 derniers jours
function resolvePeriod(q) {
  const d1 = isoDate(q.date_fin) || new Date().toISOString().slice(0, 10);
  const d0Default = (() => {
    const d = new Date(d1 + 'T00:00:00');
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  })();
  const d0 = isoDate(q.date_debut) || d0Default;
  return { date_debut: d0, date_fin: d1 };
}

// CTE qui résout pour chaque relevé : l'ARTID propre cible (direct ou via concurrent), l'IDProduit, et les libellés
const RELEVE_RESOLVED_CTE = `
  WITH releve_base AS (
    SELECT r.ID,
           r.TIRID, r.TIRCODE, r.CLIENT_NOM,
           r.REFERENCE_ARTICLE, r.DESIGNATION_ARTICLE,
           r.PRIX_RELEVE, r.PRIX_PROMO, r.MARQUE,
           r.DATE_RELEVE, r.REPCODE, r.STATUT,
           a_direct.ARTID AS artid_direct,
           a_direct.ARTCODE AS artcode_direct,
           p.IDProduit, p.[Libellé] AS prod_libelle, p.Marque AS prod_marque, p.Code_Produit AS prod_code,
           ac.ARTID AS artid_via_concurrent
    FROM EXT_RELEVE_PRIX r WITH (NOLOCK)
    LEFT JOIN ARTICLES a_direct WITH (NOLOCK)
           ON a_direct.ARTCODE = r.REFERENCE_ARTICLE
          AND a_direct.ARTISSTATISTIQUE = 'O'
    LEFT JOIN EXT_Produits p WITH (NOLOCK)
           ON p.Code_Produit = r.REFERENCE_ARTICLE
    LEFT JOIN EXT_ART_CONCURRENTS ac WITH (NOLOCK)
           ON ac.IDProduit = p.IDProduit
    WHERE r.STATUT = 'envoyee'
      AND r.PRIX_RELEVE IS NOT NULL
      AND r.DATE_RELEVE >= @date_debut
      AND r.DATE_RELEVE <  DATEADD(day, 1, @date_fin)
  ),
  releve_resolved AS (
    SELECT *,
           COALESCE(artid_direct, artid_via_concurrent) AS resolved_ARTID,
           CASE
             WHEN artid_direct IS NOT NULL THEN 'direct'
             WHEN IDProduit    IS NOT NULL AND artid_via_concurrent IS NOT NULL THEN 'via_concurrent'
             WHEN IDProduit    IS NOT NULL THEN 'concurrent_seul'
             ELSE 'orphelin'
           END AS match_type
    FROM releve_base
  )`;

// Construit la clause WHERE additionnelle + binding de paramètres pour les filtres optionnels
function buildExtraFilters(q, request) {
  const wh = [];
  if (q.tirid) {
    const id = parseInt(q.tirid);
    if (!isNaN(id) && id > 0) {
      wh.push('r.TIRID = @tirid');
      request.input('tirid', sql.Int, id);
    }
  }
  if (q.repcode) {
    wh.push('r.REPCODE = @repcode');
    request.input('repcode', sql.VarChar(20), String(q.repcode).slice(0, 20));
  }
  if (q.marque) {
    wh.push('(r.MARQUE = @marque OR r.prod_marque = @marque)');
    request.input('marque', sql.VarChar(200), String(q.marque).slice(0, 200));
  }
  if (q.match_type) {
    const allowed = ['direct', 'via_concurrent', 'concurrent_seul', 'orphelin'];
    const mt = String(q.match_type);
    if (allowed.includes(mt)) {
      wh.push('r.match_type = @match_type');
      request.input('match_type', sql.VarChar(20), mt);
    }
  }
  return wh.length ? 'WHERE ' + wh.join(' AND ') : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/filters — listes pour les selects (clients, marques, représentants, dates)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/filters', async (req, res) => {
  try {
    const pool = await resolvePrixPool(req);
    const [clients, marques, reps, bornes] = await Promise.all([
      pool.request().query(`
        SELECT DISTINCT r.TIRID, RTRIM(ISNULL(t.TIRSOCIETE, r.CLIENT_NOM)) AS nom
        FROM EXT_RELEVE_PRIX r WITH (NOLOCK)
        LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID = r.TIRID
        WHERE r.STATUT = 'envoyee'
        ORDER BY nom
      `),
      pool.request().query(`
        SELECT DISTINCT marque FROM (
          SELECT RTRIM(MARQUE) AS marque FROM EXT_RELEVE_PRIX  WITH (NOLOCK) WHERE MARQUE IS NOT NULL AND LTRIM(RTRIM(MARQUE)) <> ''
          UNION
          SELECT RTRIM(Marque)  AS marque FROM EXT_Produits     WITH (NOLOCK) WHERE Marque IS NOT NULL AND LTRIM(RTRIM(Marque)) <> ''
        ) m
        ORDER BY marque
      `),
      pool.request().query(`
        SELECT DISTINCT RTRIM(REPCODE) AS repcode
        FROM EXT_RELEVE_PRIX WITH (NOLOCK)
        WHERE STATUT = 'envoyee' AND REPCODE IS NOT NULL AND LTRIM(RTRIM(REPCODE)) <> ''
        ORDER BY repcode
      `),
      pool.request().query(`
        SELECT
          CONVERT(varchar(10), MIN(DATE_RELEVE), 120) AS date_min,
          CONVERT(varchar(10), MAX(DATE_RELEVE), 120) AS date_max,
          COUNT(*) AS nb_releves
        FROM EXT_RELEVE_PRIX WITH (NOLOCK)
        WHERE STATUT = 'envoyee'
      `),
    ]);
    res.json({
      clients: clients.recordset,
      marques: marques.recordset.map(r => r.marque),
      representants: reps.recordset.map(r => r.repcode),
      bornes: bornes.recordset[0],
    });
  } catch (err) {
    console.error('[PRIX:filters]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/kpis — KPIs synthétiques (nb relevés, couverture, alignement)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/kpis', async (req, res) => {
  const p = resolvePeriod(req.query);
  try {
    const pool = await resolvePrixPool(req);
    const r = pool.request();
    r.input('date_debut', sql.VarChar(10), p.date_debut);
    r.input('date_fin',   sql.VarChar(10), p.date_fin);
    const where = buildExtraFilters(req.query, r);

    const result = await r.query(`
      ${RELEVE_RESOLVED_CTE}
      SELECT
        COUNT(*) AS nb_releves,
        COUNT(DISTINCT r.REFERENCE_ARTICLE) AS nb_references,
        COUNT(DISTINCT r.TIRID) AS nb_clients,
        COUNT(DISTINCT r.resolved_ARTID) AS nb_articles_propres,
        SUM(CASE WHEN r.match_type = 'direct'          THEN 1 ELSE 0 END) AS nb_match_direct,
        SUM(CASE WHEN r.match_type = 'via_concurrent'  THEN 1 ELSE 0 END) AS nb_match_via_conc,
        SUM(CASE WHEN r.match_type = 'concurrent_seul' THEN 1 ELSE 0 END) AS nb_match_conc_seul,
        SUM(CASE WHEN r.match_type = 'orphelin'        THEN 1 ELSE 0 END) AS nb_orphelins,
        AVG(CAST(r.PRIX_RELEVE AS float)) AS prix_releve_moyen,
        CONVERT(varchar(10), MIN(r.DATE_RELEVE), 120) AS date_min,
        CONVERT(varchar(10), MAX(r.DATE_RELEVE), 120) AS date_max
      FROM releve_resolved r
      ${where}
    `);
    res.json({ periode: p, ...result.recordset[0] });
  } catch (err) {
    console.error('[PRIX:kpis]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/ecarts — comparatif PV moyen propre vs prix relevé, par article
// Agrégation par resolved_ARTID (mon article cible) + IDProduit (produit concurrent)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/ecarts', async (req, res) => {
  const p = resolvePeriod(req.query);
  const tva = parseTva(req.query);
  const tvaCoef = 1 + tva / 100;
  try {
    const pool = await resolvePrixPool(req);
    const r = pool.request();
    r.input('date_debut', sql.VarChar(10), p.date_debut);
    r.input('date_fin',   sql.VarChar(10), p.date_fin);
    r.input('tva_coef',   sql.Float,       tvaCoef);
    const where = buildExtraFilters(req.query, r);

    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);

    const result = await r.query(`
      ${RELEVE_RESOLVED_CTE},
      agg_releve AS (
        SELECT
          r.resolved_ARTID,
          r.IDProduit,
          r.match_type,
          MAX(r.REFERENCE_ARTICLE) AS reference_article,
          MAX(r.DESIGNATION_ARTICLE) AS designation_releve,
          MAX(r.prod_libelle) AS prod_libelle,
          MAX(COALESCE(r.MARQUE, r.prod_marque)) AS marque,
          COUNT(*) AS nb_releves,
          COUNT(DISTINCT r.TIRID) AS nb_clients,
          MIN(CAST(r.PRIX_RELEVE AS float)) AS prix_min,
          MAX(CAST(r.PRIX_RELEVE AS float)) AS prix_max,
          AVG(CAST(r.PRIX_RELEVE AS float)) AS prix_moyen,
          AVG(CAST(r.PRIX_PROMO  AS float)) AS prix_promo_moyen,
          MAX(r.DATE_RELEVE) AS date_dernier_releve
        FROM releve_resolved r
        ${where}
        GROUP BY r.resolved_ARTID, r.IDProduit, r.match_type
      ),
      mon_pv AS (
        SELECT pl.ARTID,
               SUM(pl.PLVMNTNETHT) / NULLIF(SUM(pl.PLVQTE), 0) AS pv_moyen_ht,
               SUM(pl.PLVMNTNETHT) AS ca_net_ht,
               SUM(pl.PLVQTE)      AS qte_vendue,
               COUNT(DISTINCT pv.TIRID) AS nb_clients_vendus
        FROM PIECEVENTELIGNES pl WITH (NOLOCK)
        JOIN PIECEVENTES pv WITH (NOLOCK) ON pv.PCVID = pl.PCVID
        JOIN PIECE_NATURE pn WITH (NOLOCK) ON pn.PINID = pv.PINID
        WHERE pn.PITCODE = 'F'
          AND pn.PINSENSSTATISTIQUE = 1
          AND pv.PCVDATEEFFET >= @date_debut
          AND pv.PCVDATEEFFET <  DATEADD(day, 1, @date_fin)
          AND pl.PLVQTE > 0
        GROUP BY pl.ARTID
      )
      SELECT TOP (${limit})
        ag.resolved_ARTID,
        ag.IDProduit,
        ag.match_type,
        ag.reference_article,
        ag.designation_releve,
        ag.prod_libelle,
        ag.marque,
        a.ARTCODE        AS artcode,
        RTRIM(a.ARTDESIGNATION) AS artdesignation,
        ag.nb_releves,
        ag.nb_clients,
        ag.prix_min,
        ag.prix_max,
        ag.prix_moyen,
        ag.prix_promo_moyen,
        CONVERT(varchar(10), ag.date_dernier_releve, 120) AS date_dernier_releve,
        mp.pv_moyen_ht,
        mp.ca_net_ht,
        mp.qte_vendue,
        mp.nb_clients_vendus,
        CASE WHEN mp.pv_moyen_ht > 0
             THEN (mp.pv_moyen_ht - ag.prix_moyen / @tva_coef) / mp.pv_moyen_ht * 100.0
             ELSE NULL END AS ecart_pct
      FROM agg_releve ag
      LEFT JOIN ARTICLES a WITH (NOLOCK)  ON a.ARTID  = ag.resolved_ARTID
      LEFT JOIN mon_pv   mp                ON mp.ARTID = ag.resolved_ARTID
      ORDER BY ag.nb_releves DESC, ag.prix_moyen DESC
    `);
    res.json({ periode: p, tva, count: result.recordset.length, rows: result.recordset });
  } catch (err) {
    console.error('[PRIX:ecarts]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/risques — Top articles à risque (où on est sensiblement plus cher)
// Filtre : seuil minimum d'écart (% — défaut 5) ; classés par CA descendant
// ─────────────────────────────────────────────────────────────────────────────
router.get('/risques', async (req, res) => {
  const p = resolvePeriod(req.query);
  const tva = parseTva(req.query);
  const tvaCoef = 1 + tva / 100;
  const seuil = parseFloat(req.query.seuil_pct) || 5;
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  try {
    const pool = await resolvePrixPool(req);
    const r = pool.request();
    r.input('date_debut', sql.VarChar(10), p.date_debut);
    r.input('date_fin',   sql.VarChar(10), p.date_fin);
    r.input('tva_coef',   sql.Float,       tvaCoef);
    r.input('seuil',      sql.Float,       seuil);
    const where = buildExtraFilters(req.query, r);

    // Seuls les relevés rattachables à un article propre (pour avoir un PV de référence)
    const matchFilter = where
      ? `${where} AND r.resolved_ARTID IS NOT NULL`
      : `WHERE r.resolved_ARTID IS NOT NULL`;

    const result = await r.query(`
      ${RELEVE_RESOLVED_CTE},
      agg_releve AS (
        SELECT r.resolved_ARTID,
               MAX(COALESCE(r.MARQUE, r.prod_marque)) AS marque,
               COUNT(*) AS nb_releves,
               COUNT(DISTINCT r.TIRID) AS nb_clients,
               AVG(CAST(r.PRIX_RELEVE AS float)) AS prix_moyen,
               MIN(CAST(r.PRIX_RELEVE AS float)) AS prix_min,
               MAX(r.DATE_RELEVE) AS date_dernier_releve
        FROM releve_resolved r
        ${matchFilter}
        GROUP BY r.resolved_ARTID
      ),
      mon_pv AS (
        SELECT pl.ARTID,
               SUM(pl.PLVMNTNETHT) / NULLIF(SUM(pl.PLVQTE), 0) AS pv_moyen_ht,
               SUM(pl.PLVMNTNETHT) AS ca_net_ht,
               SUM(pl.PLVQTE)      AS qte_vendue
        FROM PIECEVENTELIGNES pl WITH (NOLOCK)
        JOIN PIECEVENTES pv WITH (NOLOCK) ON pv.PCVID = pl.PCVID
        JOIN PIECE_NATURE pn WITH (NOLOCK) ON pn.PINID = pv.PINID
        WHERE pn.PITCODE = 'F'
          AND pn.PINSENSSTATISTIQUE = 1
          AND pv.PCVDATEEFFET >= @date_debut
          AND pv.PCVDATEEFFET <  DATEADD(day, 1, @date_fin)
          AND pl.PLVQTE > 0
        GROUP BY pl.ARTID
      )
      SELECT TOP (${limit})
        ag.resolved_ARTID AS ARTID,
        a.ARTCODE,
        RTRIM(a.ARTDESIGNATION) AS designation,
        ag.marque,
        ag.nb_releves,
        ag.nb_clients,
        ag.prix_min,
        ag.prix_moyen AS prix_concurrent_moyen,
        mp.pv_moyen_ht,
        mp.ca_net_ht,
        mp.qte_vendue,
        (mp.pv_moyen_ht - ag.prix_moyen / @tva_coef) / NULLIF(mp.pv_moyen_ht, 0) * 100.0 AS ecart_pct,
        CONVERT(varchar(10), ag.date_dernier_releve, 120) AS date_dernier_releve
      FROM agg_releve ag
      JOIN ARTICLES a WITH (NOLOCK) ON a.ARTID = ag.resolved_ARTID
      JOIN mon_pv   mp               ON mp.ARTID = ag.resolved_ARTID
      WHERE mp.pv_moyen_ht > 0
        AND (mp.pv_moyen_ht - ag.prix_moyen / @tva_coef) / mp.pv_moyen_ht * 100.0 >= @seuil
      ORDER BY mp.ca_net_ht DESC, ecart_pct DESC
    `);
    res.json({ periode: p, tva, seuil_pct: seuil, count: result.recordset.length, rows: result.recordset });
  } catch (err) {
    console.error('[PRIX:risques]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/detail — Tous les relevés bruts pour un ARTID propre OU une REFERENCE_ARTICLE
// (drill-down depuis le tableau écarts)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/detail', async (req, res) => {
  const p = resolvePeriod(req.query);
  const artid = parseInt(req.query.artid);
  const ref   = (req.query.reference || '').trim();
  if (!artid && !ref) return res.status(400).json({ error: 'artid ou reference requis' });
  try {
    const pool = await resolvePrixPool(req);
    const r = pool.request();
    r.input('date_debut', sql.VarChar(10), p.date_debut);
    r.input('date_fin',   sql.VarChar(10), p.date_fin);
    if (artid) r.input('artid', sql.Int, artid);
    if (ref)   r.input('ref',   sql.VarChar(100), ref.slice(0, 100));

    const cond = artid
      ? 'WHERE rr.resolved_ARTID = @artid'
      : 'WHERE rr.REFERENCE_ARTICLE = @ref';

    const result = await r.query(`
      ${RELEVE_RESOLVED_CTE}
      SELECT
        rr.ID,
        CONVERT(varchar(19), rr.DATE_RELEVE, 120) AS date_releve,
        rr.TIRID, RTRIM(ISNULL(t.TIRSOCIETE, rr.CLIENT_NOM)) AS client,
        rr.REPCODE,
        rr.REFERENCE_ARTICLE, rr.DESIGNATION_ARTICLE,
        rr.PRIX_RELEVE, rr.PRIX_PROMO,
        COALESCE(rr.MARQUE, rr.prod_marque) AS marque,
        rr.match_type,
        rr.resolved_ARTID, rr.IDProduit,
        rr.prod_libelle
      FROM releve_resolved rr
      LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID = rr.TIRID
      ${cond}
      ORDER BY rr.DATE_RELEVE DESC
    `);
    res.json({ periode: p, count: result.recordset.length, rows: result.recordset });
  } catch (err) {
    console.error('[PRIX:detail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

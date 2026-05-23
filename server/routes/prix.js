// Rapport prix concurrents — refonte centrée pénétration secteur × marque × article.
//
// Croisement EXT_RELEVE_PRIX × ARTICLES × EXT_Produits × EXT_ART_CONCURRENTS × PIECEVENTELIGNES.
//
// Jointures logiques (pas de FK déclarées) :
//   - EXT_RELEVE_PRIX.REFERENCE_ARTICLE → ARTICLES.ARTCODE  (relevé sur un de NOS articles)
//   - EXT_RELEVE_PRIX.REFERENCE_ARTICLE → EXT_Produits.Code_Produit (relevé sur un produit concurrent)
//   - EXT_Produits.IDProduit → EXT_ART_CONCURRENTS.IDProduit → ARTICLES.ARTID (notre équivalent)
//   - EXT_RELEVE_PRIX.TIRID  → TIERS.TIRID (client où le relevé a eu lieu)

const express  = require('express');
const router   = express.Router();
const ExcelJS  = require('exceljs');
const { getUserPool, getConnPool, sql } = require('../../config/database');

const resolvePrixPool = (req) => {
  let connId = req.query?.connId;
  if (!connId) {
    const dbs = String(req.query?.dbs || '').split(',').map(s => s.trim()).filter(Boolean);
    connId = dbs[0];
  }
  if (connId && connId !== 'default') return getConnPool(connId);
  return getUserPool(req.user);
};

function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// PRIX_RELEVE est stocké TTC ; on le ramène en HT côté SQL via la TVA passée en query
// (défaut 8.5 % — taux normal Guadeloupe). Borné [0, 100].
function parseTva(q) {
  const v = parseFloat(q.tva);
  if (!isFinite(v) || v < 0 || v > 100) return 8.5;
  return v;
}

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

// CSV → array (lower-bounded, capped)
function parseCsv(raw, cap = 100) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean).slice(0, cap);
}

// Société du pool — pour le badge d'en-tête (cohérent avec commercial.js)
async function fetchSocieteFromPool(pool) {
  try {
    const r = await pool.request().query(
      `SELECT TOP 1 RTRIM(TIRSOCIETE) AS societe FROM TIERS WHERE TIRTYPE='S' AND TIRSOCIETE IS NOT NULL`
    );
    return r.recordset[0]?.societe || null;
  } catch { return null; }
}

// CTE qui résout pour chaque relevé envoyé : l'ARTID propre cible (direct ou via concurrent)
// + IDProduit + libellés + type de rapprochement.
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/filters — listes pour les selects (secteurs, marques, familles,
// commerciaux, bornes de dates). Pas de prerequisites (sert au boot de la page).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/filters', async (req, res) => {
  try {
    const pool = await resolvePrixPool(req);
    const [secteurs, marques, familles, reps, bornes] = await Promise.all([
      pool.request().query(`
        SELECT DISTINCT ISNULL(RTRIM(TIRACTIVITE),'Non défini') AS secteur
        FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='C' AND TIRISACTIF='O'
        ORDER BY secteur
      `).then(r => r.recordset.map(x => x.secteur)),
      pool.request().query(`
        SELECT DISTINCT RTRIM(ARTMARQUE) AS marque
        FROM ARTICLES WITH (NOLOCK)
        WHERE ARTMARQUE IS NOT NULL AND LEN(RTRIM(ARTMARQUE))>0 AND ARTISSTATISTIQUE='O'
        ORDER BY marque
      `).then(r => r.recordset.map(x => x.marque)),
      pool.request().query(`
        SELECT DISTINCT RTRIM(af.AFMINTITULE) AS famille
        FROM ARTFAMILLES af WITH (NOLOCK)
        JOIN ARTICLES a WITH (NOLOCK) ON a.AFMID=af.AFMID
        WHERE af.AFMINTITULE IS NOT NULL AND LEN(RTRIM(af.AFMINTITULE))>0 AND a.ARTISSTATISTIQUE='O'
        ORDER BY famille
      `).then(r => r.recordset.map(x => x.famille)),
      pool.request().query(`
        SELECT TIRID, RTRIM(TIRSOCIETE) AS nom
        FROM TIERS WITH (NOLOCK) WHERE TIRTYPE='R' AND TIRISACTIF='O'
        ORDER BY nom
      `).then(r => r.recordset),
      pool.request().query(`
        SELECT CONVERT(varchar(10), MIN(DATE_RELEVE), 120) AS min_date,
               CONVERT(varchar(10), MAX(DATE_RELEVE), 120) AS max_date
        FROM EXT_RELEVE_PRIX WITH (NOLOCK)
        WHERE STATUT='envoyee'
      `).then(r => r.recordset[0] || {}),
    ]);
    res.json({ secteurs, marques, familles, commerciaux: reps, bornes });
  } catch (err) {
    console.error('[PRIX:filters]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/penetration — vue principale : hiérarchie secteur×marque×article
// + gaps article + gaps client + pricing détaillé par client.
// ─────────────────────────────────────────────────────────────────────────────
// Fonction extraite — réutilisée par la route JSON, Excel et PDF.
async function fetchPenetrationData(pool, query) {
    const p = resolvePeriod(query);
    const tva = parseTva(query);
    const tvaCoef = 1 + tva / 100;
    const secteurs = parseCsv(query.secteurs, 100);
    const marques  = parseCsv(query.marques,  50);
    const familles = parseCsv(query.familles, 50);
    const repids   = parseCsv(query.repid,    50).map(x => parseInt(x)).filter(x => !isNaN(x));
    const cliactifRaw = String(query.cliactif || '').trim();
    const cliactif = cliactifRaw === 'N' ? 'N'
                   : (cliactifRaw === 'all' || cliactifRaw === '' ? 'O' : 'O');

    // Métadonnées DB (pour badge d'en-tête)
    const [dbNameRow, societe] = await Promise.all([
      pool.request().query(`SELECT DB_NAME() AS db`).then(r => r.recordset[0]?.db || null).catch(() => null),
      fetchSocieteFromPool(pool),
    ]);

    // Helpers SQL : binding params communs + génération clauses dynamiques
    const cliActifCond = cliactif ? ` AND tc.TIRISACTIF='${cliactif}'` : '';
    const cliActifBareCond = cliactif ? ` AND TIRISACTIF='${cliactif}'` : '';
    const secteurInList = secteurs.map((_, i) => `@sec${i}`).join(',');
    const secteurFTc    = secteurs.length ? `AND ISNULL(RTRIM(tc.TIRACTIVITE),'Non défini') IN (${secteurInList})` : '';
    const secteurFBare  = secteurs.length ? `AND ISNULL(RTRIM(TIRACTIVITE),'Non défini') IN (${secteurInList})` : '';
    const marqueInList  = marques.map((_, i) => `@marque${i}`).join(',');
    const marqueF       = marques.length ? `AND a.ARTMARQUE IN (${marqueInList})` : '';
    const familleInList = familles.map((_, i) => `@fam${i}`).join(',');
    const familleF      = familles.length
      ? `AND a.AFMID IN (SELECT AFMID FROM ARTFAMILLES WITH (NOLOCK) WHERE AFMINTITULE IN (${familleInList}))`
      : '';
    const repInList     = repids.map((_, i) => `@repid${i}`).join(',');
    const repCliF       = repids.length ? `AND tc.REPID IN (${repInList})` : '';
    const repPvF        = repids.length ? `AND pv.TIRID_REP IN (${repInList})` : '';

    const bindCommon = (r) => {
      r.input('date_debut', sql.VarChar(10), p.date_debut);
      r.input('date_fin',   sql.VarChar(10), p.date_fin);
      r.input('tva_coef',   sql.Float,       tvaCoef);
      secteurs.forEach((s, i) => r.input(`sec${i}`,    sql.NVarChar(255), s));
      marques.forEach((m, i)  => r.input(`marque${i}`, sql.NVarChar(255), m));
      familles.forEach((f, i) => r.input(`fam${i}`,    sql.NVarChar(255), f));
      repids.forEach((id, i)  => r.input(`repid${i}`,  sql.Int, id));
    };

    // ───── Q1 : clients du périmètre (avec secteur + commercial) ─────────────
    const r1 = pool.request();
    bindCommon(r1);
    const q1 = await r1.query(`
      SELECT tc.TIRID,
             ISNULL(RTRIM(tc.TIRACTIVITE),'Non défini') AS secteur,
             RTRIM(tc.TIRCODE)    AS code,
             RTRIM(tc.TIRSOCIETE) AS nom,
             ISNULL(tc.REPID, 0)  AS rep_id,
             ISNULL(RTRIM(tr.TIRSOCIETE),'') AS commercial
      FROM TIERS tc WITH (NOLOCK)
      LEFT JOIN TIERS tr WITH (NOLOCK) ON tr.TIRID=tc.REPID AND tr.TIRTYPE='R'
      WHERE tc.TIRTYPE='C'${cliActifCond}
        ${repids.length ? `AND tc.REPID IN (${repInList})` : ''}
        ${secteurFTc}
    `);
    const tirInfoMap = new Map();           // tirid → info client
    const clientsBySecteur = new Map();     // secteur → Set<tirid>
    q1.recordset.forEach(row => {
      tirInfoMap.set(row.TIRID, {
        tir_id: row.TIRID, secteur: row.secteur, code: row.code, nom: row.nom,
        rep_id: row.rep_id, commercial: row.commercial,
      });
      if (!clientsBySecteur.has(row.secteur)) clientsBySecteur.set(row.secteur, new Set());
      clientsBySecteur.get(row.secteur).add(row.TIRID);
    });

    // ───── Q2 : ventes du périmètre par (secteur, marque, article, tirid) ───
    const r2 = pool.request();
    bindCommon(r2);
    const q2 = await r2.query(`
      SELECT
        ISNULL(RTRIM(tc.TIRACTIVITE),'Non défini') AS secteur,
        ISNULL(RTRIM(a.ARTMARQUE),'Non défini')    AS marque,
        a.ARTID                                    AS art_id,
        RTRIM(a.ARTCODE)                           AS art_code,
        RTRIM(a.ARTDESIGNATION)                    AS art_designation,
        pv.TIRID                                   AS tir_id,
        SUM(pl.PLVMNTNETHT*pn.PINSENSSTATISTIQUE)  AS ca_net_ht,
        SUM(pl.PLVQTE*pn.PINSENSSTATISTIQUE)       AS qte,
        SUM(pl.PLVMNTNETHT*pn.PINSENSSTATISTIQUE) / NULLIF(SUM(pl.PLVQTE*pn.PINSENSSTATISTIQUE), 0) AS pv_moyen_ht
      FROM PIECEVENTELIGNES pl WITH (NOLOCK)
      JOIN PIECEVENTES pv WITH (NOLOCK)    ON pv.PCVID=pl.PCVID
      JOIN PIECE_NATURE pn WITH (NOLOCK)   ON pn.PINID=pv.PINID
      JOIN ARTICLES a WITH (NOLOCK)        ON a.ARTID=pl.ARTID
      JOIN TIERS tc WITH (NOLOCK)          ON tc.TIRID=pv.TIRID
      WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND a.ARTISSTATISTIQUE='O'
        AND tc.TIRTYPE='C'${cliActifCond}
        AND pv.PCVDATEEFFET >= @date_debut
        AND pv.PCVDATEEFFET <  DATEADD(day, 1, @date_fin)
        ${marqueF} ${familleF} ${secteurFTc} ${repCliF}
      GROUP BY tc.TIRACTIVITE, a.ARTMARQUE, a.ARTID, a.ARTCODE, a.ARTDESIGNATION, pv.TIRID
    `);

    // ───── Q3 : relevés résolus agrégés par article (prix concurrent) ───────
    const r3 = pool.request();
    bindCommon(r3);
    // Filtre marque/famille appliqué via l'article résolu (a.ARTID = resolved_ARTID)
    const q3 = await r3.query(`
      ${RELEVE_RESOLVED_CTE}
      SELECT
        r.resolved_ARTID                                AS art_id,
        MAX(RTRIM(a.ARTCODE))                           AS art_code,
        MAX(RTRIM(a.ARTDESIGNATION))                    AS art_designation,
        MAX(ISNULL(RTRIM(a.ARTMARQUE),'Non défini'))    AS art_marque,
        COUNT(*)                                        AS nb_releves,
        COUNT(DISTINCT r.TIRID)                         AS nb_clients_releves,
        MIN(CAST(r.PRIX_RELEVE AS float) / @tva_coef)   AS prix_concurrent_min_ht,
        MAX(CAST(r.PRIX_RELEVE AS float) / @tva_coef)   AS prix_concurrent_max_ht,
        AVG(CAST(r.PRIX_RELEVE AS float) / @tva_coef)   AS prix_concurrent_moy_ht,
        AVG(CAST(r.PRIX_PROMO  AS float) / @tva_coef)   AS prix_promo_moy_ht,
        CONVERT(varchar(10), MAX(r.DATE_RELEVE), 120)   AS dernier_releve
      FROM releve_resolved r
      JOIN ARTICLES a WITH (NOLOCK) ON a.ARTID = r.resolved_ARTID
      WHERE r.resolved_ARTID IS NOT NULL
        ${marqueF} ${familleF}
      GROUP BY r.resolved_ARTID
    `);
    const releveByArt = new Map();
    q3.recordset.forEach(row => releveByArt.set(row.art_id, row));

    // ───── Q4 : relevés bruts par (article, client) — pour la section pricing
    const r4 = pool.request();
    bindCommon(r4);
    const q4 = await r4.query(`
      ${RELEVE_RESOLVED_CTE}
      SELECT
        r.resolved_ARTID                                  AS art_id,
        r.TIRID                                           AS tir_id,
        RTRIM(ISNULL(t.TIRSOCIETE, r.CLIENT_NOM))         AS client_nom,
        ISNULL(RTRIM(t.TIRACTIVITE),'Non défini')         AS secteur,
        CAST(r.PRIX_RELEVE AS float) / @tva_coef          AS prix_releve_ht,
        CAST(r.PRIX_PROMO  AS float) / @tva_coef          AS prix_promo_ht,
        COALESCE(r.MARQUE, r.prod_marque)                 AS marque_releve,
        CONVERT(varchar(10), r.DATE_RELEVE, 120)          AS date_releve,
        r.match_type,
        r.prod_libelle
      FROM releve_resolved r
      JOIN ARTICLES a WITH (NOLOCK) ON a.ARTID = r.resolved_ARTID
      LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID = r.TIRID
      WHERE r.resolved_ARTID IS NOT NULL
        ${marqueF} ${familleF}
      ORDER BY r.resolved_ARTID, r.DATE_RELEVE DESC
    `);
    const pricingByArt = new Map();
    q4.recordset.forEach(row => {
      if (!pricingByArt.has(row.art_id)) pricingByArt.set(row.art_id, []);
      pricingByArt.get(row.art_id).push(row);
    });

    // ───── Agrégation JS : tree secteur → marque → article ───────────────────
    // Chaque article retient : Set buyers, CA, qté, PV moyen pondéré, + relevé prix
    const root = new Map(); // secteur → Map<marque, Map<art_id, node>>
    const artMeta = new Map(); // art_id → { code, designation, marque }
    q2.recordset.forEach(row => {
      const sec = row.secteur, marque = row.marque, aid = row.art_id;
      if (!root.has(sec)) root.set(sec, new Map());
      const marqMap = root.get(sec);
      if (!marqMap.has(marque)) marqMap.set(marque, new Map());
      const artMap = marqMap.get(marque);
      if (!artMap.has(aid)) {
        artMap.set(aid, {
          art_id: aid, code: row.art_code, designation: row.art_designation,
          buyers: new Set(), ca: 0, qte: 0,
        });
      }
      const node = artMap.get(aid);
      node.buyers.add(row.tir_id);
      node.ca  += parseFloat(row.ca_net_ht) || 0;
      node.qte += parseFloat(row.qte) || 0;
      artMeta.set(aid, { code: row.art_code, designation: row.art_designation, marque });
    });
    // Inclusion des articles qui ont un relevé mais aucune vente (gap total) :
    // on récupère le secteur via marque + on ne crée que si la marque est dans le tree
    // existant — sinon on ne sait pas où le ranger.

    // Sérialisation du tree
    const treeBySecteur = [];
    root.forEach((marqMap, sec) => {
      const totalClientsSec = clientsBySecteur.get(sec)?.size || 0;
      const marquesArr = [];
      const secBuyers = new Set();
      let secCa = 0, secNbReleves = 0;
      marqMap.forEach((artMap, marque) => {
        const articlesArr = [];
        const marqueBuyers = new Set();
        let marqueCa = 0, marqueNbReleves = 0;
        artMap.forEach(node => {
          const releve = releveByArt.get(node.art_id);
          const pv_moyen_ht = node.qte > 0 ? node.ca / node.qte : null;
          const prix_conc_moy = releve ? releve.prix_concurrent_moy_ht : null;
          const ecart_pct = (pv_moyen_ht && prix_conc_moy)
            ? (pv_moyen_ht - prix_conc_moy) / pv_moyen_ht * 100 : null;
          articlesArr.push({
            type: 'article',
            art_id: node.art_id, code: node.code, designation: node.designation,
            nbBuyers: node.buyers.size,
            ca: node.ca, qte: node.qte, pv_moyen_ht,
            nb_releves: releve?.nb_releves || 0,
            nb_clients_releves: releve?.nb_clients_releves || 0,
            prix_concurrent_min_ht: releve?.prix_concurrent_min_ht ?? null,
            prix_concurrent_moy_ht: prix_conc_moy,
            prix_concurrent_max_ht: releve?.prix_concurrent_max_ht ?? null,
            prix_promo_moy_ht: releve?.prix_promo_moy_ht ?? null,
            dernier_releve: releve?.dernier_releve || null,
            ecart_pct,
          });
          node.buyers.forEach(t => { marqueBuyers.add(t); secBuyers.add(t); });
          marqueCa += node.ca;
          if (releve) marqueNbReleves += releve.nb_releves;
        });
        // Tri article : ARTCODE asc (cohérent avec rapport-secteur-marque)
        articlesArr.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fr', { numeric: true }));
        marquesArr.push({
          type: 'marque', label: marque,
          nbBuyers: marqueBuyers.size, ca: marqueCa,
          nbArticles: articlesArr.length, nb_releves: marqueNbReleves,
          children: articlesArr,
        });
        secCa += marqueCa;
        secNbReleves += marqueNbReleves;
      });
      // Tri marques : CA desc
      marquesArr.sort((a, b) => (b.ca - a.ca) || (b.nbBuyers - a.nbBuyers));
      treeBySecteur.push({
        type: 'secteur', label: sec,
        totalClients: totalClientsSec,
        nbBuyers: secBuyers.size,
        ca: secCa, nbMarques: marquesArr.length, nb_releves: secNbReleves,
        children: marquesArr,
      });
    });
    treeBySecteur.sort((a, b) => (b.ca - a.ca) || (b.nbBuyers - a.nbBuyers));

    // ───── Gaps article : pour chaque (secteur, marque, article) → clients du
    // secteur n'ayant PAS acheté l'article sur la période.
    // Une marque sans achat dans un secteur n'a pas d'article ici (cohérent avec la
    // vue qui dit "voici les marques avec ventes — qui n'achète pas QUEL article").
    const gapsByArticle = [];
    const gapsByClient = [];
    root.forEach((marqMap, sec) => {
      const secClients = clientsBySecteur.get(sec) || new Set();
      marqMap.forEach((artMap, marque) => {
        const articleGaps = [];
        const clientMissing = new Map(); // tirid → [{art_id, code, designation}]
        artMap.forEach(node => {
          const absents = [];
          secClients.forEach(t => { if (!node.buyers.has(t)) absents.push(t); });
          if (absents.length) {
            const clients = absents.map(t => tirInfoMap.get(t)).filter(Boolean)
              .sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr'));
            articleGaps.push({
              art_id: node.art_id, code: node.code, designation: node.designation,
              nbAbsents: clients.length, nbBuyers: node.buyers.size, clients,
            });
            // Vue inversée par client
            absents.forEach(t => {
              if (!clientMissing.has(t)) clientMissing.set(t, []);
              clientMissing.get(t).push({ art_id: node.art_id, code: node.code, designation: node.designation });
            });
          }
        });
        if (articleGaps.length) {
          articleGaps.sort((a, b) => b.nbAbsents - a.nbAbsents);
          gapsByArticle.push({ secteur: sec, marque, articles: articleGaps });
        }
        if (clientMissing.size) {
          const clientsArr = [];
          clientMissing.forEach((missing, t) => {
            const info = tirInfoMap.get(t); if (!info) return;
            missing.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fr', { numeric: true }));
            clientsArr.push({
              ...info, nbMissing: missing.length, nbArticlesMarque: artMap.size, missingArticles: missing,
            });
          });
          clientsArr.sort((a, b) => b.nbMissing - a.nbMissing);
          gapsByClient.push({ secteur: sec, marque, nbArticlesMarque: artMap.size, clients: clientsArr });
        }
      });
    });
    gapsByArticle.sort((a, b) => a.secteur.localeCompare(b.secteur, 'fr') || a.marque.localeCompare(b.marque, 'fr'));
    gapsByClient.sort((a, b) => a.secteur.localeCompare(b.secteur, 'fr') || a.marque.localeCompare(b.marque, 'fr'));

    // ───── Pricing par client : pour chaque article ayant ≥1 relevé,
    // liste des couples (client, prix relevé HT, mon PV HT chez ce client, écart).
    // PV "chez ce client" = utilise q2.recordset (PV par tirid × article).
    const pvByClientArt = new Map(); // `${tirid}|${artid}` → pv_moyen_ht
    q2.recordset.forEach(row => {
      const key = `${row.tir_id}|${row.art_id}`;
      const pv = parseFloat(row.pv_moyen_ht);
      if (isFinite(pv) && pv > 0) pvByClientArt.set(key, pv);
    });
    const pricingByClient = [];
    pricingByArt.forEach((rows, aid) => {
      const meta = artMeta.get(aid);
      // Si l'article n'est pas dans artMeta (aucune vente), prendre depuis q3 via ARTICLES
      // → on tag les méta basiques depuis row.prod_libelle si dispo
      const clients = rows.map(row => {
        const pvClient = pvByClientArt.get(`${row.tir_id}|${aid}`) || null;
        const ecart_pct = (pvClient && row.prix_releve_ht > 0)
          ? (pvClient - row.prix_releve_ht) / pvClient * 100 : null;
        return {
          tir_id: row.tir_id, client_nom: row.client_nom, secteur: row.secteur,
          prix_releve_ht: row.prix_releve_ht, prix_promo_ht: row.prix_promo_ht,
          mon_pv_ht: pvClient, ecart_pct,
          marque_releve: row.marque_releve, prod_libelle: row.prod_libelle,
          match_type: row.match_type, date_releve: row.date_releve,
        };
      });
      const fallback = releveByArt.get(aid);
      pricingByClient.push({
        art_id: aid,
        code: meta?.code || fallback?.art_code || null,
        designation: meta?.designation || fallback?.art_designation || rows[0]?.prod_libelle || null,
        marque: meta?.marque || fallback?.art_marque || rows[0]?.marque_releve || null,
        nb_releves: rows.length,
        nb_clients: new Set(rows.map(r => r.tir_id)).size,
        clients,
      });
    });
    pricingByClient.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fr', { numeric: true }));

    // ───── KPIs globaux ─────────────────────────────────────────────────────
    const globalBuyers = new Set();
    let globalCa = 0;
    q2.recordset.forEach(r => { globalBuyers.add(r.tir_id); globalCa += parseFloat(r.ca_net_ht) || 0; });
    const nb_articles_releves = releveByArt.size;
    const nb_articles_a_risque = Array.from(releveByArt.entries()).filter(([aid, rl]) => {
      // À risque = prix concurrent moy < mon PV moy de plus de 5%
      const meta = artMeta.get(aid); if (!meta) return false;
      // Calcul du PV global de cet article
      let ca = 0, qte = 0;
      q2.recordset.forEach(r => { if (r.art_id === aid) { ca += parseFloat(r.ca_net_ht)||0; qte += parseFloat(r.qte)||0; } });
      const pv = qte > 0 ? ca / qte : null;
      if (!pv || !rl.prix_concurrent_moy_ht) return false;
      return (pv - rl.prix_concurrent_moy_ht) / pv * 100 > 5;
    }).length;

    return {
      generatedAt: new Date().toISOString(),
      periode: p,
      tva,
      db: { database: dbNameRow, societe },
      filtres: { secteurs, marques, familles, repids, cliactif },
      kpis: {
        totalClientsPortefeuille: tirInfoMap.size,
        nbAcheteurs: globalBuyers.size,
        ca: globalCa,
        nbArticlesAvecRelevePrix: nb_articles_releves,
        nbArticlesARisque: nb_articles_a_risque,
        nbRelevés: q4.recordset.length,
      },
      treeBySecteur,
      gapsByArticle,
      gapsByClient,
      pricingByClient,
    };
}

router.get('/penetration', async (req, res) => {
  try {
    const pool = await resolvePrixPool(req);
    const data = await fetchPenetrationData(pool, req.query);
    res.json(data);
  } catch (err) {
    console.error('[PRIX:penetration]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/penetration/excel — export multi-onglets (Synthèse, Hiérarchie,
// Gaps articles, Gaps clients, Pricing par client).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/penetration/excel', async (req, res) => {
  try {
    const pool = await resolvePrixPool(req);
    const data = await fetchPenetrationData(pool, req.query);
    const buf  = await buildPenetrationExcel(data);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="penetration-prix-${dateStr}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('[PRIX:penetration/excel]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/penetration/pdf — export PDF print-friendly via Puppeteer.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/penetration/pdf', async (req, res) => {
  try {
    const pool = await resolvePrixPool(req);
    const data = await fetchPenetrationData(pool, req.query);
    const html = buildPenetrationHTML(data);
    const buf  = await htmlToPdfBuffer(html);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="penetration-prix-${dateStr}.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('[PRIX:penetration/pdf]', err.message, err.stack);
    res.status(500).send(`Erreur : ${err.message}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/detail — drill-down : tous les relevés bruts pour un ARTID
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers PDF + builders Excel/HTML
// ─────────────────────────────────────────────────────────────────────────────

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
      margin: { top:'10mm', right:'8mm', bottom:'10mm', left:'8mm' },
    });
  } finally {
    await page.close();
  }
}

async function buildPenetrationExcel(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TB Reporting';
  wb.created = new Date();

  const headerFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1B5E20' } };
  const headerFont = { bold:true, color:{ argb:'FFFFFFFF' }, size:10 };
  const lvl1Fill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD7E3F4' } };
  const lvl2Fill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEBF1F9' } };
  const numFmt     = '#,##0';
  const eurFmt     = '#,##0.00 "€"';
  const pctFmt     = '0.0"%"';
  const borderThin = { style:'thin', color:{ argb:'FFC8D0DF' } };
  const border     = { top:borderThin, left:borderThin, bottom:borderThin, right:borderThin };

  const k = data.kpis || {};
  const filtres = data.filtres || {};

  // ── Sheet 1 : Synthèse ───────────────────────────────────────────────────
  const wsSyn = wb.addWorksheet('Synthèse');
  wsSyn.columns = [
    { header:'Indicateur', key:'k', width:42 },
    { header:'Valeur',     key:'v', width:38 },
  ];
  wsSyn.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center'}; });
  wsSyn.addRow({ k:'Période',                  v:`${data.periode.date_debut} → ${data.periode.date_fin}` });
  wsSyn.addRow({ k:'TVA',                      v:`${data.tva} %` });
  wsSyn.addRow({ k:'Base',                     v:`${data.db?.database || ''}${data.db?.societe ? ' · '+data.db.societe : ''}` });
  wsSyn.addRow({ k:'Secteurs filtrés',         v:(filtres.secteurs||[]).join(', ') || '(tous)' });
  wsSyn.addRow({ k:'Marques filtrées',         v:(filtres.marques||[]).join(', ') || '(toutes)' });
  wsSyn.addRow({ k:'Familles filtrées',        v:(filtres.familles||[]).join(', ') || '(toutes)' });
  wsSyn.addRow({ k:'Clients portefeuille',     v:k.totalClientsPortefeuille||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:'Acheteurs (période)',      v:k.nbAcheteurs||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:'CA réalisé HT',            v:k.ca||0 }).getCell('v').numFmt = eurFmt;
  wsSyn.addRow({ k:'Articles avec relevé prix', v:k.nbArticlesAvecRelevePrix||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:'Relevés résolus',          v:k.nbRelevés||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:'Articles à risque (≥5%)',  v:k.nbArticlesARisque||0 }).getCell('v').numFmt = numFmt;

  // ── Sheet 2 : Hiérarchie ────────────────────────────────────────────────
  const wsTree = wb.addWorksheet('Hiérarchie');
  wsTree.columns = [
    { header:'Niveau', key:'lvl', width:10 },
    { header:'Libellé', key:'lbl', width:55 },
    { header:'Clients', key:'cli', width:10 },
    { header:'Acheteurs', key:'ach', width:11 },
    { header:'CA HT', key:'ca', width:14 },
    { header:'Mon PV HT', key:'pv', width:13 },
    { header:'Concurrent moy HT', key:'cmoy', width:18 },
    { header:'Concurrent min HT', key:'cmin', width:18 },
    { header:'Concurrent max HT', key:'cmax', width:18 },
    { header:'Écart %', key:'ecart', width:10 },
    { header:'Relevés', key:'rel', width:9 },
    { header:'Dernier relevé', key:'der', width:13 },
  ];
  wsTree.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center',wrapText:true}; });
  wsTree.getRow(1).height = 28;
  wsTree.views = [{ state:'frozen', xSplit:2, ySplit:1 }];
  (data.treeBySecteur || []).forEach(s => {
    const rS = wsTree.addRow({ lvl:'SECTEUR', lbl:s.label, cli:s.totalClients, ach:s.nbBuyers, ca:s.ca, rel:s.nb_releves });
    rS.eachCell(c => { c.fill=lvl1Fill; c.font={ bold:true, size:10 }; });
    rS.getCell('ca').numFmt = eurFmt;
    (s.children || []).forEach(m => {
      const rM = wsTree.addRow({ lvl:'  MARQUE', lbl:'  '+m.label, ach:m.nbBuyers, ca:m.ca, rel:m.nb_releves });
      rM.eachCell(c => { c.fill=lvl2Fill; c.font={ bold:true, size:10 }; });
      rM.getCell('ca').numFmt = eurFmt;
      (m.children || []).forEach(a => {
        const rA = wsTree.addRow({
          lvl:'    ART', lbl:'    '+(a.code||'')+' — '+(a.designation||''),
          ach:a.nbBuyers, ca:a.ca,
          pv:a.pv_moyen_ht, cmoy:a.prix_concurrent_moy_ht,
          cmin:a.prix_concurrent_min_ht, cmax:a.prix_concurrent_max_ht,
          ecart:a.ecart_pct, rel:a.nb_releves, der:a.dernier_releve,
        });
        rA.getCell('ca').numFmt   = eurFmt;
        rA.getCell('pv').numFmt   = eurFmt;
        rA.getCell('cmoy').numFmt = eurFmt;
        rA.getCell('cmin').numFmt = eurFmt;
        rA.getCell('cmax').numFmt = eurFmt;
        rA.getCell('ecart').numFmt = pctFmt;
      });
    });
  });

  // ── Sheet 3 : Gaps articles (par secteur×marque×article → clients absents) ──
  const wsGapsArt = wb.addWorksheet('Gaps articles');
  wsGapsArt.columns = [
    { header:'Secteur', key:'sec', width:25 },
    { header:'Marque', key:'mar', width:22 },
    { header:'Code article', key:'cod', width:14 },
    { header:'Désignation', key:'des', width:45 },
    { header:'Nb absents', key:'nba', width:11 },
    { header:'Total clients', key:'tot', width:13 },
    { header:'Client absent', key:'cli', width:35 },
    { header:'Code client', key:'cco', width:14 },
    { header:'Commercial', key:'com', width:22 },
  ];
  wsGapsArt.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center',wrapText:true}; });
  wsGapsArt.views = [{ state:'frozen', ySplit:1 }];
  (data.gapsByArticle || []).forEach(entry => {
    (entry.articles || []).forEach(art => {
      (art.clients || []).forEach(c => {
        wsGapsArt.addRow({
          sec:entry.secteur, mar:entry.marque,
          cod:art.code, des:art.designation,
          nba:art.nbAbsents, tot:art.nbBuyers + art.nbAbsents,
          cli:c.nom, cco:c.code, com:c.commercial || '',
        });
      });
    });
  });

  // ── Sheet 4 : Gaps clients (par client → articles manquants par marque) ─
  const wsGapsCli = wb.addWorksheet('Gaps clients');
  wsGapsCli.columns = [
    { header:'Secteur', key:'sec', width:25 },
    { header:'Marque', key:'mar', width:22 },
    { header:'Client', key:'cli', width:35 },
    { header:'Code client', key:'cco', width:14 },
    { header:'Commercial', key:'com', width:22 },
    { header:'Nb manquants', key:'nbm', width:13 },
    { header:'Total marque', key:'tot', width:13 },
    { header:'Code article manquant', key:'cod', width:18 },
    { header:'Désignation', key:'des', width:50 },
  ];
  wsGapsCli.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center',wrapText:true}; });
  wsGapsCli.views = [{ state:'frozen', ySplit:1 }];
  (data.gapsByClient || []).forEach(entry => {
    (entry.clients || []).forEach(c => {
      (c.missingArticles || []).forEach(a => {
        wsGapsCli.addRow({
          sec:entry.secteur, mar:entry.marque,
          cli:c.nom, cco:c.code, com:c.commercial || '',
          nbm:c.nbMissing, tot:c.nbArticlesMarque,
          cod:a.code, des:a.designation,
        });
      });
    });
  });

  // ── Sheet 5 : Pricing par client (drill prix article × client) ──────────
  const wsPri = wb.addWorksheet('Prix par client');
  wsPri.columns = [
    { header:'Code article', key:'cod', width:14 },
    { header:'Désignation', key:'des', width:40 },
    { header:'Marque', key:'mar', width:22 },
    { header:'Client', key:'cli', width:35 },
    { header:'Secteur', key:'sec', width:25 },
    { header:'Date relevé', key:'dat', width:12 },
    { header:'Prix relevé HT', key:'pr', width:14 },
    { header:'Promo HT', key:'pp', width:13 },
    { header:'Mon PV HT chez client', key:'pv', width:19 },
    { header:'Écart %', key:'ec', width:10 },
    { header:'Marque relevée', key:'mre', width:20 },
    { header:'Match', key:'mat', width:16 },
  ];
  wsPri.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center',wrapText:true}; });
  wsPri.views = [{ state:'frozen', ySplit:1 }];
  (data.pricingByClient || []).forEach(art => {
    (art.clients || []).forEach(c => {
      const r = wsPri.addRow({
        cod:art.code, des:art.designation, mar:art.marque,
        cli:c.client_nom, sec:c.secteur, dat:c.date_releve,
        pr:c.prix_releve_ht, pp:c.prix_promo_ht, pv:c.mon_pv_ht, ec:c.ecart_pct,
        mre:c.marque_releve, mat:c.match_type,
      });
      r.getCell('pr').numFmt = eurFmt;
      r.getCell('pp').numFmt = eurFmt;
      r.getCell('pv').numFmt = eurFmt;
      r.getCell('ec').numFmt = pctFmt;
    });
  });

  return await wb.xlsx.writeBuffer();
}

// Génère un HTML print-friendly destiné à Puppeteer pour produire le PDF.
function buildPenetrationHTML(data) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmt = (n, d=0) => n==null||isNaN(n) ? '—'
    : new Intl.NumberFormat('fr-FR', { minimumFractionDigits:d, maximumFractionDigits:d }).format(n);
  const fmtEur = (n, d=0) => n==null||isNaN(n) ? '—' : fmt(n, d) + ' €';
  const fmtPct = n => n==null||isNaN(n) ? '—' : (n>=0?'+':'') + fmt(n, 1) + ' %';
  const k = data.kpis || {};
  const f = data.filtres || {};

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Pénétration prix</title>
  <style>
    body{font-family:-apple-system,Segoe UI,sans-serif;font-size:9pt;color:#1a1a1a;margin:0;padding:0}
    h1{font-size:16pt;color:#1B5E20;margin:0 0 4px}
    .meta{font-size:8pt;color:#555;margin-bottom:10px}
    .kpis{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
    .kpi{flex:1;min-width:140px;border:1px solid #d0d7e2;border-radius:6px;padding:6px 10px;background:#f7faff}
    .kpi .l{font-size:7pt;color:#555;text-transform:uppercase}
    .kpi .v{font-size:13pt;font-weight:700;margin-top:2px}
    h2{font-size:11pt;color:#1B5E20;margin:12px 0 4px;border-bottom:2px solid #1B5E20;padding-bottom:2px}
    table{width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:8px}
    th,td{padding:3px 5px;border:1px solid #d8dee9;text-align:right}
    th{background:#e8ecf4;font-weight:700;text-transform:uppercase;font-size:7pt}
    th:first-child,td:first-child{text-align:left}
    .lvl-sec{background:#d7e3f4;font-weight:700}
    .lvl-mar{background:#ebf1f9;padding-left:14px}
    .lvl-art{padding-left:28px;color:#444}
    .gap-row{margin:3px 0;padding:4px 8px;background:#f7faff;border-left:3px solid #FF9800;font-size:8pt}
    .gap-row .count{color:#FF9800;font-weight:700;margin-left:6px}
    .ecart-bad{color:#c62828;font-weight:700}
    .ecart-good{color:#2e7d32;font-weight:700}
    .ecart-avg{color:#ef6c00}
    @page{size:A4 landscape;margin:10mm 8mm}
    .pagebreak{page-break-before:always}
  </style></head><body>
  <h1>💰 Pénétration prix concurrents</h1>
  <div class="meta">
    Période : ${esc(data.periode.date_debut)} → ${esc(data.periode.date_fin)}
    · TVA ${esc(data.tva)} %
    · Base : ${esc(data.db?.database || '')}${data.db?.societe ? ' · '+esc(data.db.societe) : ''}
    · Secteurs : ${(f.secteurs||[]).map(esc).join(', ') || '(tous)'}
    · Marques : ${(f.marques||[]).map(esc).join(', ') || '(toutes)'}
    · Familles : ${(f.familles||[]).map(esc).join(', ') || '(toutes)'}
    · Généré le ${new Date(data.generatedAt).toLocaleString('fr-FR')}
  </div>
  <div class="kpis">
    <div class="kpi"><div class="l">Clients portefeuille</div><div class="v">${fmt(k.totalClientsPortefeuille)}</div></div>
    <div class="kpi"><div class="l">Acheteurs</div><div class="v">${fmt(k.nbAcheteurs)}</div></div>
    <div class="kpi"><div class="l">CA HT</div><div class="v">${fmtEur(k.ca)}</div></div>
    <div class="kpi"><div class="l">Articles avec relevé</div><div class="v">${fmt(k.nbArticlesAvecRelevePrix)}</div></div>
    <div class="kpi"><div class="l">Articles à risque</div><div class="v">${fmt(k.nbArticlesARisque)}</div></div>
  </div>

  <h2>📂 Hiérarchie secteur → marque → article</h2>
  <table>
    <thead><tr>
      <th>Niveau</th><th>Clients</th><th>Acheteurs</th><th>CA HT</th>
      <th>Mon PV</th><th>Conc. moy</th><th>Min / Max</th><th>Écart</th><th>Relevés</th>
    </tr></thead><tbody>`;
  (data.treeBySecteur || []).forEach(s => {
    html += `<tr class="lvl-sec"><td>${esc(s.label)}</td><td>${fmt(s.totalClients)}</td><td>${fmt(s.nbBuyers)}</td><td>${fmtEur(s.ca)}</td><td colspan="4">${s.children.length} marque(s)</td><td>${fmt(s.nb_releves)}</td></tr>`;
    s.children.forEach(m => {
      html += `<tr class="lvl-mar"><td>↳ ${esc(m.label)}</td><td></td><td>${fmt(m.nbBuyers)}</td><td>${fmtEur(m.ca)}</td><td colspan="4">${m.children.length} art</td><td>${fmt(m.nb_releves)}</td></tr>`;
      m.children.forEach(a => {
        const ec = a.ecart_pct;
        const ecCls = ec==null ? '' : (ec >= 5 ? 'ecart-bad' : (ec <= -2 ? 'ecart-good' : 'ecart-avg'));
        const minMax = (a.prix_concurrent_min_ht != null && a.prix_concurrent_max_ht != null)
          ? `${fmtEur(a.prix_concurrent_min_ht, 2)} / ${fmtEur(a.prix_concurrent_max_ht, 2)}` : '—';
        html += `<tr class="lvl-art"><td>${esc(a.code)} — ${esc(a.designation || '')}</td><td></td><td>${fmt(a.nbBuyers)}</td><td>${fmtEur(a.ca)}</td><td>${fmtEur(a.pv_moyen_ht, 2)}</td><td>${fmtEur(a.prix_concurrent_moy_ht, 2)}</td><td>${minMax}</td><td class="${ecCls}">${fmtPct(ec)}</td><td>${fmt(a.nb_releves)}</td></tr>`;
      });
    });
  });
  html += `</tbody></table>`;

  // Gaps articles condensés
  if ((data.gapsByArticle || []).length) {
    html += `<div class="pagebreak"></div><h2>🚫 Gaps articles (clients absents par article)</h2>`;
    data.gapsByArticle.forEach(entry => {
      entry.articles.forEach(art => {
        const tot = art.nbBuyers + art.nbAbsents;
        const pct = tot > 0 ? art.nbAbsents / tot * 100 : 0;
        const cliList = (art.clients || []).slice(0, 30).map(c => esc(c.nom)).join(' · ');
        const extra = art.clients.length > 30 ? ` <i>(+${art.clients.length - 30} autres)</i>` : '';
        html += `<div class="gap-row"><b>${esc(entry.secteur)} · ${esc(entry.marque)} · ${esc(art.code)}</b> ${esc(art.designation || '')}<span class="count">${art.nbAbsents}/${tot} (${fmt(pct, 1)}%)</span><br><small>${cliList}${extra}</small></div>`;
      });
    });
  }

  // Pricing par client
  if ((data.pricingByClient || []).length) {
    html += `<div class="pagebreak"></div><h2>💶 Comparatif prix par article × client</h2>`;
    data.pricingByClient.forEach(art => {
      html += `<h3 style="font-size:9pt;margin:6px 0 2px;color:#1B5E20">${esc(art.code || '')} — ${esc(art.designation || '')} <small style="color:#666;font-weight:400">· ${esc(art.marque || '')}</small></h3>`;
      html += `<table><thead><tr>
        <th>Client</th><th>Secteur</th><th>Date</th>
        <th>Prix relevé</th><th>Promo</th><th>Mon PV</th><th>Écart</th>
      </tr></thead><tbody>`;
      art.clients.forEach(c => {
        const ec = c.ecart_pct;
        const ecCls = ec==null ? '' : (ec >= 5 ? 'ecart-bad' : (ec <= -2 ? 'ecart-good' : 'ecart-avg'));
        html += `<tr>
          <td>${esc(c.client_nom || '')}</td>
          <td>${esc(c.secteur || '')}</td>
          <td>${esc(c.date_releve || '')}</td>
          <td>${fmtEur(c.prix_releve_ht, 2)}</td>
          <td>${fmtEur(c.prix_promo_ht, 2)}</td>
          <td>${fmtEur(c.mon_pv_ht, 2)}</td>
          <td class="${ecCls}">${fmtPct(ec)}</td>
        </tr>`;
      });
      html += `</tbody></table>`;
    });
  }

  html += `</body></html>`;
  return html;
}

module.exports = router;

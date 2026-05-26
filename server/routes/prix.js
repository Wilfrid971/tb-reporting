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
           p.ID_SOUS_FAMILLE AS prod_id_sousfam, p.ID_CATEGORIE AS prod_id_categorie,
           p.ID_CLASSE AS prod_id_classe, p.ID_NATURE AS prod_id_nature, p.ID_COLLECTION AS prod_id_collection,
           ac.ARTID AS artid_via_concurrent
    FROM EXT_RELEVE_PRIX r WITH (NOLOCK)
    LEFT JOIN ARTICLES a_direct WITH (NOLOCK)
           ON a_direct.ARTCODE = r.REFERENCE_ARTICLE
          AND a_direct.ARTISSTATISTIQUE = 'O'
    LEFT JOIN EXT_Produits p WITH (NOLOCK)
           ON p.Code_Produit = r.REFERENCE_ARTICLE
    LEFT JOIN EXT_ART_CONCURRENTS ac WITH (NOLOCK)
           ON ac.IDProduit = p.IDProduit
    WHERE r.STATUT IN ('envoyee','validee')
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
      // Marques (dimension ARTMARQUE par défaut au boot) : nos articles UNION les
      // marques des produits concurrents, pour que la vue initiale soit complète.
      pool.request().query(`
        SELECT val AS marque FROM (
          SELECT RTRIM(ARTMARQUE) AS val FROM ARTICLES WITH (NOLOCK)
           WHERE ARTMARQUE IS NOT NULL AND LEN(RTRIM(ARTMARQUE))>0 AND ARTISSTATISTIQUE='O'
          UNION
          SELECT RTRIM(Marque) AS val FROM EXT_Produits WITH (NOLOCK)
           WHERE Marque IS NOT NULL AND LEN(RTRIM(Marque))>0
        ) u ORDER BY marque
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
        WHERE STATUT IN ('envoyee','validee')
      `).then(r => r.recordset[0] || {}),
    ]);
    res.json({ secteurs, marques, familles, commerciaux: reps, bornes });
  } catch (err) {
    console.error('[PRIX:filters]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prix/dim-values?dim=ARTCLASSE — valeurs distinctes de la classification
// choisie, pour alimenter la dropdown multi-select qui s'adapte à la dimension.
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_DIMS = new Set(['ARTMARQUE','ARTFAMILLE','ARTSOUSFAMILLE','ARTCATEGORIE','ARTNATURE','ARTCOLLECTION','ARTCLASSE']);
// Mapping dimension → colonne FK de classification dans EXT_Produits (produits
// concurrents). Sert à enrichir les dropdowns avec les valeurs portées par les
// concurrents. ARTMARQUE → EXT_Produits.Marque (cas à part) ; ARTFAMILLE → pas
// d'équivalent concurrent (donc ARTICLES seul).
const PROD_CLASSIF_FK = {
  ARTSOUSFAMILLE: 'ID_SOUS_FAMILLE', ARTCATEGORIE: 'ID_CATEGORIE',
  ARTCLASSE: 'ID_CLASSE', ARTNATURE: 'ID_NATURE', ARTCOLLECTION: 'ID_COLLECTION',
};
// Sous-requête des valeurs de classification portées par les produits concurrents
// pour la dimension donnée (NULL si la dimension n'a pas d'équivalent concurrent).
// On se limite aux classifications réellement assignées à un EXT_Produits : une
// valeur jamais assignée ne pourrait de toute façon jamais matcher le filtre.
function concDimValuesSubquery(dim) {
  if (dim === 'ARTMARQUE') {
    return `SELECT RTRIM(p.Marque) AS val FROM EXT_Produits p WITH (NOLOCK)
            WHERE p.Marque IS NOT NULL AND LEN(RTRIM(p.Marque))>0`;
  }
  const fk = PROD_CLASSIF_FK[dim];
  if (!fk) return null; // ARTFAMILLE et autres : pas de source concurrent
  return `SELECT RTRIM(c.LIBELLE) AS val FROM EXT_Classification c WITH (NOLOCK)
          WHERE c.IDCLASSIFICATION IN (SELECT ${fk} FROM EXT_Produits WITH (NOLOCK) WHERE ${fk} IS NOT NULL)
            AND c.LIBELLE IS NOT NULL AND LEN(RTRIM(c.LIBELLE))>0`;
}
router.get('/dim-values', async (req, res) => {
  try {
    const pool = await resolvePrixPool(req);
    const dimRaw = String(req.query.dim || 'ARTMARQUE').trim();
    const dim = ALLOWED_DIMS.has(dimRaw) ? dimRaw : 'ARTMARQUE';
    // Filtre famille : restreint les valeurs proposées aux articles des familles
    // choisies (sinon la dropdown listerait les classifications de TOUS les articles).
    const familles = parseCsv(req.query.familles, 50);
    const famInList = familles.map((_, i) => `@fam${i}`).join(',');
    const famFilter = familles.length
      ? `AND a.AFMID IN (SELECT AFMID FROM ARTFAMILLES WITH (NOLOCK) WHERE AFMINTITULE IN (${famInList}))`
      : '';
    let q;
    if (dim === 'ARTFAMILLE') {
      // Famille : ARTICLES uniquement (pas d'équivalent côté produits concurrents).
      q = `SELECT DISTINCT RTRIM(af.AFMINTITULE) AS val
           FROM ARTFAMILLES af WITH (NOLOCK)
           JOIN ARTICLES a WITH (NOLOCK) ON a.AFMID=af.AFMID
           WHERE af.AFMINTITULE IS NOT NULL AND LEN(RTRIM(af.AFMINTITULE))>0 AND a.ARTISSTATISTIQUE='O'
           ${famFilter}
           ORDER BY val`;
    } else {
      // Valeurs sur NOS articles (filtrées par famille si demandé)…
      // DISTINCT requis : sans concPart, ce SELECT alimente directement la liste
      // (l'UNION dédupliquait sinon).
      const artPart = `SELECT DISTINCT RTRIM(a.${dim}) AS val FROM ARTICLES a WITH (NOLOCK)
                       WHERE a.${dim} IS NOT NULL AND LEN(RTRIM(a.${dim}))>0 AND a.ARTISSTATISTIQUE='O' ${famFilter}`;
      // …unies aux valeurs des produits concurrents UNIQUEMENT si aucun filtre famille
      // n'est actif : les concurrents (EXT_Produits) n'ont pas de rattachement famille,
      // donc hors périmètre dès qu'on restreint à une famille.
      const concPart = familles.length ? null : concDimValuesSubquery(dim);
      q = concPart
        ? `SELECT val FROM (${artPart} UNION ${concPart}) u ORDER BY val`
        : `${artPart} ORDER BY val`;
    }
    const r = pool.request();
    familles.forEach((f, i) => r.input(`fam${i}`, sql.NVarChar(255), f));
    const rows = await r.query(q);
    res.json({ dim, values: rows.recordset.map(x => x.val) });
  } catch (err) {
    console.error('[PRIX:dim-values]', err.message);
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
    // dim : dimension de classification d'article utilisée comme niveau 2 du tree
    // (entre secteur et article). Défaut = ARTMARQUE pour rétro-compat. ARTFAMILLE
    // passe par la table ARTFAMILLES (libellé AFMINTITULE), les autres sont des
    // colonnes directes de ARTICLES.
    const dimRaw = String(query.dim || 'ARTMARQUE').trim();
    const dim    = ALLOWED_DIMS.has(dimRaw) ? dimRaw : 'ARTMARQUE';
    const dimSelectFam = `ISNULL(RTRIM(af.AFMINTITULE),'Sans famille')`;
    const dimSelectCol = `ISNULL(RTRIM(a.${dim}),'Non défini')`;
    const dimSelect    = dim === 'ARTFAMILLE' ? dimSelectFam : dimSelectCol;
    const dimGroupBy   = dim === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.${dim}`;
    const dimJoin      = dim === 'ARTFAMILLE' ? 'LEFT JOIN ARTFAMILLES af WITH (NOLOCK) ON af.AFMID=a.AFMID' : '';

    // cliactif :
    //  O    → clients actifs (défaut)
    //  N    → clients inactifs
    //  all  → tous
    //  period → clients avec CA sur N OU N-1 (même filtre que le rapport
    //           secteur×marque : ≥1 vente statistique sur la période ou N-1,
    //           indépendant de TIRISACTIF)
    const cliactifRaw  = String(query.cliactif || '').trim();
    const isPeriodMode = cliactifRaw === 'period';
    const cliactif     = isPeriodMode ? ''
                       : (cliactifRaw === 'N' ? 'N'
                       : (cliactifRaw === 'all' ? '' : 'O'));
    // Période N-1 : même plage de dates décalée d'un an en arrière
    const shiftYears = (dateStr, n) => {
      const [y, m, d] = dateStr.split('-').map(Number);
      const year = y + n;
      // Clamp au dernier jour du mois si le jour n'existe pas (29/02 → 28/02 en
      // année non bissextile) — sinon SQL Server rejette la date (erreur de conversion).
      const lastDay = new Date(year, m, 0).getDate();
      const day = Math.min(d, lastDay);
      const pad = (x) => String(x).padStart(2, '0');
      return `${year}-${pad(m)}-${pad(day)}`;
    };
    const dN1  = shiftYears(p.date_debut, -1);
    const fN1  = shiftYears(p.date_fin,   -1);

    // Métadonnées DB (pour badge d'en-tête)
    const [dbNameRow, societe] = await Promise.all([
      pool.request().query(`SELECT DB_NAME() AS db`).then(r => r.recordset[0]?.db || null).catch(() => null),
      fetchSocieteFromPool(pool),
    ]);

    // Helpers SQL : binding params communs + génération clauses dynamiques
    const cliActifCond = cliactif ? ` AND tc.TIRISACTIF='${cliactif}'` : '';
    const cliActifBareCond = cliactif ? ` AND TIRISACTIF='${cliactif}'` : '';
    // Filtre period : client doit avoir au moins une vente statistique sur N OU sur N-1
    // (aligné sur le rapport secteur×marque). Appliqué à Q1 et Q2 pour rester cohérent
    // (univers clients + agrégation ventes).
    const periodCond = isPeriodMode ? `
      AND EXISTS (
        SELECT 1 FROM PIECEVENTELIGNES pl2
        JOIN PIECEVENTES pv2 ON pv2.PCVID=pl2.PCVID
        JOIN PIECE_NATURE pn2 WITH (NOLOCK) ON pn2.PINID=pv2.PINID
        JOIN ARTICLES a2 WITH (NOLOCK) ON a2.ARTID=pl2.ARTID
        WHERE pn2.PITCODE='F' AND pn2.PINSENSSTATISTIQUE<>0 AND a2.ARTISSTATISTIQUE='O'
          AND pv2.TIRID=tc.TIRID
          AND ((pv2.PCVDATEEFFET>=@date_debut AND pv2.PCVDATEEFFET<DATEADD(day,1,@date_fin))
            OR (pv2.PCVDATEEFFET>=@dN1 AND pv2.PCVDATEEFFET<DATEADD(day,1,@fN1)))
      )` : '';
    const secteurInList = secteurs.map((_, i) => `@sec${i}`).join(',');
    const secteurFTc    = secteurs.length ? `AND ISNULL(RTRIM(tc.TIRACTIVITE),'Non défini') IN (${secteurInList})` : '';
    const secteurFBare  = secteurs.length ? `AND ISNULL(RTRIM(TIRACTIVITE),'Non défini') IN (${secteurInList})` : '';
    const marqueInList  = marques.map((_, i) => `@marque${i}`).join(',');
    // Le filtre "marques" porte sur la DIMENSION choisie (dim), pas uniquement ARTMARQUE :
    // ex. dim=ARTCLASSE → filtre a.ARTCLASSE ; dim=ARTFAMILLE → via AFMID/AFMINTITULE.
    const dimFilterClause = dim === 'ARTFAMILLE'
      ? `a.AFMID IN (SELECT AFMID FROM ARTFAMILLES WITH (NOLOCK) WHERE AFMINTITULE IN (${marqueInList}))`
      : `a.${dim} IN (${marqueInList})`;
    const marqueF       = marques.length ? `AND ${dimFilterClause}` : '';
    const familleInList = familles.map((_, i) => `@fam${i}`).join(',');
    const familleF      = familles.length
      ? `AND a.AFMID IN (SELECT AFMID FROM ARTFAMILLES WITH (NOLOCK) WHERE AFMINTITULE IN (${familleInList}))`
      : '';
    const repInList     = repids.map((_, i) => `@repid${i}`).join(',');
    const repCliF       = repids.length ? `AND tc.REPID IN (${repInList})` : '';
    const repPvF        = repids.length ? `AND pv.TIRID_REP IN (${repInList})` : '';
    // Filtres CLIENT pour les requêtes de relevés (alias TIERS = t) : un relevé est
    // rattaché au client où il a eu lieu (r.TIRID → t.TIRID). Garantit que le tableau
    // prix, le graphe et les agrégats concurrents respectent secteur/cliactif/commercial.
    const secteurFt   = secteurs.length ? `AND ISNULL(RTRIM(t.TIRACTIVITE),'Non défini') IN (${secteurInList})` : '';
    const cliActifT   = cliactif ? ` AND t.TIRISACTIF='${cliactif}'` : '';
    const repFt       = repids.length ? `AND t.REPID IN (${repInList})` : '';
    const releveCliF  = `${secteurFt}${cliActifT} ${repFt}`;

    const bindCommon = (r) => {
      r.input('date_debut', sql.VarChar(10), p.date_debut);
      r.input('date_fin',   sql.VarChar(10), p.date_fin);
      r.input('tva_coef',   sql.Float,       tvaCoef);
      if (isPeriodMode) {
        r.input('dN1', sql.VarChar(10), dN1);
        r.input('fN1', sql.VarChar(10), fN1);
      }
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
      WHERE tc.TIRTYPE='C'${cliActifCond}${periodCond}
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
        ${dimSelect}                               AS dim_value,
        a.ARTID                                    AS art_id,
        RTRIM(a.ARTCODE)                           AS art_code,
        RTRIM(a.ARTDESIGNATION)                    AS art_designation,
        pv.TIRID                                   AS tir_id,
        SUM(pl.PLVMNTNETHT*pn.PINSENSSTATISTIQUE)  AS ca_net_ht,
        SUM(pl.PLVQTE*pn.PINSENSSTATISTIQUE)       AS qte,
        SUM(CAST(pl.PLVQTE AS float) / CASE WHEN ISNULL(pl.PLVD3, 0) = 0 THEN 1 ELSE pl.PLVD3 END
            * pn.PINSENSSTATISTIQUE) AS cartons,
        SUM(pl.PLVMNTNETHT*pn.PINSENSSTATISTIQUE) / NULLIF(SUM(pl.PLVQTE*pn.PINSENSSTATISTIQUE), 0) AS pv_moyen_ht
      FROM PIECEVENTELIGNES pl WITH (NOLOCK)
      JOIN PIECEVENTES pv WITH (NOLOCK)    ON pv.PCVID=pl.PCVID
      JOIN PIECE_NATURE pn WITH (NOLOCK)   ON pn.PINID=pv.PINID
      JOIN ARTICLES a WITH (NOLOCK)        ON a.ARTID=pl.ARTID
      ${dimJoin}
      JOIN TIERS tc WITH (NOLOCK)          ON tc.TIRID=pv.TIRID
      WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND a.ARTISSTATISTIQUE='O'
        AND tc.TIRTYPE='C'${cliActifCond}${periodCond}
        AND pv.PCVDATEEFFET >= @date_debut
        AND pv.PCVDATEEFFET <  DATEADD(day, 1, @date_fin)
        ${marqueF} ${familleF} ${secteurFTc} ${repCliF}
      GROUP BY tc.TIRACTIVITE, ${dimGroupBy}, a.ARTID, a.ARTCODE, a.ARTDESIGNATION, pv.TIRID
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
        MAX(${dimSelect})                               AS dim_value,
        COUNT(*)                                        AS nb_releves,
        COUNT(DISTINCT r.TIRID)                         AS nb_clients_releves,
        MIN(CAST(r.PRIX_RELEVE AS float) / @tva_coef)   AS prix_concurrent_min_ht,
        MAX(CAST(r.PRIX_RELEVE AS float) / @tva_coef)   AS prix_concurrent_max_ht,
        AVG(CAST(r.PRIX_RELEVE AS float) / @tva_coef)   AS prix_concurrent_moy_ht,
        AVG(CAST(r.PRIX_PROMO  AS float) / @tva_coef)   AS prix_promo_moy_ht,
        CONVERT(varchar(10), MAX(r.DATE_RELEVE), 120)   AS dernier_releve
      FROM releve_resolved r
      JOIN ARTICLES a WITH (NOLOCK) ON a.ARTID = r.resolved_ARTID
      ${dimJoin}
      LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID = r.TIRID
      WHERE r.resolved_ARTID IS NOT NULL
        ${marqueF} ${familleF} ${releveCliF}
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
        RTRIM(a.ARTCODE)                                  AS art_code,
        RTRIM(a.ARTDESIGNATION)                           AS art_designation,
        ISNULL(RTRIM(a.ARTMARQUE),'Non défini')           AS art_marque,
        ${dimSelect}                                      AS dim_value,
        r.TIRID                                           AS tir_id,
        RTRIM(ISNULL(t.TIRSOCIETE, r.CLIENT_NOM))         AS client_nom,
        RTRIM(t.TIRCODE)                                  AS client_code,
        ISNULL(RTRIM(t.TIRACTIVITE),'Non défini')         AS secteur,
        ISNULL(t.REPID, 0)                                AS rep_id,
        CAST(r.PRIX_RELEVE AS float) / @tva_coef          AS prix_releve_ht,
        CAST(r.PRIX_PROMO  AS float) / @tva_coef          AS prix_promo_ht,
        COALESCE(r.MARQUE, r.prod_marque)                 AS marque_releve,
        CONVERT(varchar(10), r.DATE_RELEVE, 120)          AS date_releve,
        r.match_type,
        r.prod_libelle
      FROM releve_resolved r
      JOIN ARTICLES a WITH (NOLOCK) ON a.ARTID = r.resolved_ARTID
      ${dimJoin}
      LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID = r.TIRID
      WHERE r.resolved_ARTID IS NOT NULL
        ${marqueF} ${familleF} ${releveCliF}
      ORDER BY t.TIRACTIVITE, t.TIRSOCIETE, r.DATE_RELEVE DESC
    `);
    const pricingByArt = new Map();
    q4.recordset.forEach(row => {
      if (!pricingByArt.has(row.art_id)) pricingByArt.set(row.art_id, []);
      pricingByArt.get(row.art_id).push(row);
    });

    // ───── Q5 : produits concurrents relevés (y compris non résolus), pour enrichir
    // les gaps. classif = dimension de NOTRE article si le relevé est résolu ;
    // sinon on dérive la classification PROPRE du produit concurrent (EXT_Produits a
    // gagné 5 FK ID_* → EXT_Classification.LIBELLE), avec fallback marque (dim=Marque)
    // puis 'Indéfini'. On exclut match_type 'direct' (= relevé sur une de nos propres
    // références, pas un produit concurrent).
    // Dimension → colonne FK de classification côté EXT_Produits (exposée par la CTE).
    // ARTMARQUE → Marque (géré à part) ; ARTFAMILLE → pas d'équivalent concurrent.
    const PROD_CLASSIF_COL = {
      ARTSOUSFAMILLE: 'prod_id_sousfam', ARTCATEGORIE: 'prod_id_categorie',
      ARTCLASSE: 'prod_id_classe', ARTNATURE: 'prod_id_nature', ARTCOLLECTION: 'prod_id_collection',
    };
    const prodClassifCol = PROD_CLASSIF_COL[dim] || null;
    // FK → PK unique : pas besoin de filtrer SECTION, l'ID pointe la bonne ligne.
    const concClassifJoin = prodClassifCol
      ? `LEFT JOIN EXT_Classification pc WITH (NOLOCK) ON pc.IDCLASSIFICATION = r.${prodClassifCol}`
      : '';
    const concClassifSql = `
      CASE
        WHEN r.resolved_ARTID IS NOT NULL THEN ${dimSelect}
        ${dim === 'ARTMARQUE'
          ? `WHEN NULLIF(RTRIM(COALESCE(r.MARQUE, r.prod_marque)),'') IS NOT NULL THEN RTRIM(COALESCE(r.MARQUE, r.prod_marque))`
          : prodClassifCol
            ? `WHEN NULLIF(RTRIM(pc.LIBELLE),'') IS NOT NULL THEN RTRIM(pc.LIBELLE)`
            : ''}
        ELSE N'Indéfini'
      END`;
    // Filtre dimension étendu aux produits concurrents : on filtre sur l'expression
    // classif elle-même (= ce qui est affiché), pas sur a.<dim>. Un relevé reste donc
    // visible si la dimension de NOTRE article résolu OU la classif propre du concurrent
    // matche la sélection — concClassifSql couvre les deux via sa branche resolved.
    // Spécifique à Q5 : marqueF (a.<dim>) reste utilisé tel quel par Q2/Q3/Q4.
    const marqueFConc = marques.length ? `AND ${concClassifSql} IN (${marqueInList})` : '';
    const r5 = pool.request();
    bindCommon(r5);
    const q5 = await r5.query(`
      ${RELEVE_RESOLVED_CTE}
      SELECT
        ISNULL(RTRIM(t.TIRACTIVITE),'Non défini')        AS secteur,
        r.TIRID                                          AS tir_id,
        r.resolved_ARTID                                 AS art_id,
        RTRIM(r.REFERENCE_ARTICLE)                       AS ref,
        COALESCE(NULLIF(RTRIM(r.prod_libelle),''), RTRIM(r.DESIGNATION_ARTICLE)) AS libelle,
        COALESCE(NULLIF(RTRIM(r.MARQUE),''), NULLIF(RTRIM(r.prod_marque),'')) AS marque,
        ${concClassifSql}                                AS classif,
        r.match_type                                     AS match_type,
        CAST(r.PRIX_RELEVE AS float) / @tva_coef         AS prix_releve_ht,
        CAST(r.PRIX_PROMO  AS float) / @tva_coef         AS prix_promo_ht,
        CONVERT(varchar(10), r.DATE_RELEVE, 120)         AS date_releve
      FROM releve_resolved r
      LEFT JOIN ARTICLES a WITH (NOLOCK) ON a.ARTID = r.resolved_ARTID
      ${dimJoin}
      ${concClassifJoin}
      LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID = r.TIRID
      WHERE r.match_type <> 'direct'
        ${marqueFConc} ${familleF} ${releveCliF}
    `);
    // Dédup par produit (réf + libellé) : conserve le relevé le plus récent + compte.
    const dedupeConc = (list) => {
      if (!list || !list.length) return [];
      const m = new Map();
      list.forEach(p => {
        const key = `${p.ref}||${p.libelle}`;
        const ex = m.get(key);
        if (!ex) m.set(key, { ...p, nb_releves: 1 });
        else {
          ex.nb_releves++;
          if ((p.date_releve || '') > (ex.date_releve || '')) {
            ex.prix_releve_ht = p.prix_releve_ht; ex.prix_promo_ht = p.prix_promo_ht; ex.date_releve = p.date_releve;
          }
        }
      });
      return Array.from(m.values()).sort((x, y) =>
        (x.classif || '').localeCompare(y.classif || '', 'fr') || (x.libelle || '').localeCompare(y.libelle || '', 'fr'));
    };
    const concByClient = new Map();     // `${secteur}||${tir_id}` → [produits]
    const concByArticleSec = new Map(); // `${secteur}||${art_id}` → [produits]
    q5.recordset.forEach(row => {
      const prod = {
        ref: row.ref, libelle: row.libelle || row.ref, marque: row.marque || null,
        classif: row.classif || 'Indéfini', match_type: row.match_type,
        prix_releve_ht: row.prix_releve_ht, prix_promo_ht: row.prix_promo_ht, date_releve: row.date_releve,
      };
      if (row.tir_id != null) {
        const ck = `${row.secteur}||${row.tir_id}`;
        if (!concByClient.has(ck)) concByClient.set(ck, []);
        concByClient.get(ck).push(prod);
      }
      if (row.art_id != null) {
        const ak = `${row.secteur}||${row.art_id}`;
        if (!concByArticleSec.has(ak)) concByArticleSec.set(ak, []);
        concByArticleSec.get(ak).push(prod);
      }
    });

    // ───── Q6 : produits concurrents relevés SANS correspondance article
    // (resolved_ARTID NULL = relevé sur EXT_Produits sans lien EXT_ART_CONCURRENTS,
    // ou réf inconnue). Classés secteur d'activité → client → produits, pour la
    // section "Produits concurrents non rattachés".
    const r6 = pool.request();
    bindCommon(r6);
    const q6 = await r6.query(`
      ${RELEVE_RESOLVED_CTE}
      SELECT
        ISNULL(RTRIM(t.TIRACTIVITE),'Non défini')                AS secteur,
        r.TIRID                                                  AS tir_id,
        RTRIM(ISNULL(t.TIRSOCIETE, r.CLIENT_NOM))                AS client_nom,
        RTRIM(t.TIRCODE)                                         AS client_code,
        RTRIM(r.REFERENCE_ARTICLE)                               AS ref,
        COALESCE(NULLIF(RTRIM(r.prod_libelle),''), RTRIM(r.DESIGNATION_ARTICLE)) AS libelle,
        COALESCE(NULLIF(RTRIM(r.MARQUE),''), NULLIF(RTRIM(r.prod_marque),''))    AS marque,
        r.match_type                                             AS match_type,
        CAST(r.PRIX_RELEVE AS float) / @tva_coef                 AS prix_releve_ht,
        CAST(r.PRIX_PROMO  AS float) / @tva_coef                 AS prix_promo_ht,
        CONVERT(varchar(10), r.DATE_RELEVE, 120)                 AS date_releve
      FROM releve_resolved r
      LEFT JOIN TIERS t WITH (NOLOCK) ON t.TIRID = r.TIRID
      WHERE r.resolved_ARTID IS NULL
        ${releveCliF}
    `);
    // Agrégation secteur → client → produits (dédup par réf+libellé, garde le + récent).
    const nrSecMap = new Map(); // secteur → Map<tir_id, { code, nom, prodMap }>
    q6.recordset.forEach(row => {
      const sec = row.secteur || 'Non défini';
      if (!nrSecMap.has(sec)) nrSecMap.set(sec, new Map());
      const cliMap = nrSecMap.get(sec);
      const tid = row.tir_id;
      if (!cliMap.has(tid)) cliMap.set(tid, { tir_id: tid, code: row.client_code, nom: row.client_nom || row.client_code || '—', prodMap: new Map() });
      const cli = cliMap.get(tid);
      const key = `${row.ref}||${row.libelle}`;
      const ex = cli.prodMap.get(key);
      if (!ex) cli.prodMap.set(key, {
        ref: row.ref, libelle: row.libelle || row.ref, marque: row.marque || null, match_type: row.match_type,
        prix_releve_ht: row.prix_releve_ht, prix_promo_ht: row.prix_promo_ht, date_releve: row.date_releve, nb_releves: 1,
      });
      else {
        ex.nb_releves++;
        if ((row.date_releve || '') > (ex.date_releve || '')) {
          ex.prix_releve_ht = row.prix_releve_ht; ex.prix_promo_ht = row.prix_promo_ht; ex.date_releve = row.date_releve;
        }
      }
    });
    const concurrentsNonRattaches = [];
    nrSecMap.forEach((cliMap, sec) => {
      const refsSet = new Set();
      let secReleves = 0;
      const clients = [];
      cliMap.forEach(cli => {
        const produits = Array.from(cli.prodMap.values())
          .sort((a, b) => (a.marque||'').localeCompare(b.marque||'', 'fr') || (a.libelle||'').localeCompare(b.libelle||'', 'fr'));
        const nbRel = produits.reduce((s, p) => s + p.nb_releves, 0);
        secReleves += nbRel;
        produits.forEach(p => refsSet.add(p.ref));
        clients.push({ tir_id: cli.tir_id, code: cli.code, nom: cli.nom, nb_produits: produits.length, nb_releves: nbRel, produits });
      });
      clients.sort((a, b) => (b.nb_releves - a.nb_releves) || (a.nom||'').localeCompare(b.nom||'', 'fr'));
      concurrentsNonRattaches.push({ secteur: sec, nb_clients: clients.length, nb_produits: refsSet.size, nb_releves: secReleves, clients });
    });
    concurrentsNonRattaches.sort((a, b) => (b.nb_releves - a.nb_releves) || a.secteur.localeCompare(b.secteur, 'fr'));

    // ───── Agrégation JS : tree secteur → DIM (marque/sous-fam/classe…) → article ─
    // Mesure principale = CARTONS = PLVD1 (PLVQTE/PLVD3 si PLVD3<>0, sinon PLVQTE).
    // Garde aussi qté et ca pour le calcul PV.
    const root = new Map(); // secteur → Map<dim_value, Map<art_id, node>>
    const artMeta = new Map(); // art_id → { code, designation, dim_value }
    q2.recordset.forEach(row => {
      const sec = row.secteur, dimVal = row.dim_value, aid = row.art_id;
      if (!root.has(sec)) root.set(sec, new Map());
      const dimMap = root.get(sec);
      if (!dimMap.has(dimVal)) dimMap.set(dimVal, new Map());
      const artMap = dimMap.get(dimVal);
      if (!artMap.has(aid)) {
        artMap.set(aid, {
          art_id: aid, code: row.art_code, designation: row.art_designation,
          buyers: new Set(), cartons: 0, ca: 0, qte: 0,
        });
      }
      const node = artMap.get(aid);
      node.buyers.add(row.tir_id);
      node.cartons += parseFloat(row.cartons) || 0;
      node.ca      += parseFloat(row.ca_net_ht) || 0;
      node.qte     += parseFloat(row.qte) || 0;
      artMeta.set(aid, { code: row.art_code, designation: row.art_designation, dim_value: dimVal });
    });

    // Relevés scopés par (secteur du client relevé × article) — dérivés de Q4 (relevés
    // bruts, déjà rattachés au secteur du client où le relevé a eu lieu). Un relevé fait
    // chez un client du secteur A ne compte donc QUE pour le secteur A, pas globalement
    // sur tous les secteurs où l'article est vendu.
    // Split par type : "mon relevé" = relevés de MES références (match_type 'direct'),
    // "concurrent" = relevés de produits concurrents (via_concurrent). La comparaison
    // se fait terrain vs terrain (mon prix relevé vs prix concurrent relevé), pas vs PV.
    const releveBySecteurArt = new Map(); // `${secteur}||${art_id}` → stats relevé
    {
      const acc = new Map();
      const blank = () => ({ n:0, sum:0, min:null, max:null });
      q4.recordset.forEach(row => {
        if (row.art_id == null) return;
        const key = `${row.secteur}||${row.art_id}`;
        let a = acc.get(key);
        if (!a) { a = { mine:blank(), conc:blank(), nb:0, clients:new Set(), promoSum:0, promoN:0, dernier:null }; acc.set(key, a); }
        const pr = parseFloat(row.prix_releve_ht);
        a.nb++; if (row.tir_id != null) a.clients.add(row.tir_id);
        const b = row.match_type === 'direct' ? a.mine : a.conc;
        if (isFinite(pr)) { b.n++; b.sum += pr; b.min = b.min==null?pr:Math.min(b.min,pr); b.max = b.max==null?pr:Math.max(b.max,pr); }
        if (row.match_type !== 'direct') { const pp = parseFloat(row.prix_promo_ht); if (isFinite(pp)) { a.promoSum += pp; a.promoN++; } }
        if ((row.date_releve||'') > (a.dernier||'')) a.dernier = row.date_releve;
      });
      acc.forEach((a, key) => releveBySecteurArt.set(key, {
        nb_releves: a.nb, nb_clients_releves: a.clients.size,
        prix_mon_releve_moy_ht: a.mine.n > 0 ? a.mine.sum / a.mine.n : null, nb_mon_releve: a.mine.n,
        prix_concurrent_moy_ht: a.conc.n > 0 ? a.conc.sum / a.conc.n : null, nb_concurrent: a.conc.n,
        prix_concurrent_min_ht: a.conc.min, prix_concurrent_max_ht: a.conc.max,
        prix_promo_moy_ht: a.promoN > 0 ? a.promoSum / a.promoN : null,
        dernier_releve: a.dernier,
      }));
    }

    // Articles RELEVÉS mais non vendus dans le secteur (cartons=0) : ajoutés au tree
    // pour ne pas perdre le relevé (ex. un Moët relevé en Restaurant mais non vendu là).
    // Source = Q4 (relevés résolus, secteur du client relevé + métadonnées article).
    q4.recordset.forEach(row => {
      if (row.art_id == null) return;
      const sec = row.secteur, dimVal = row.dim_value, aid = row.art_id;
      if (!root.has(sec)) root.set(sec, new Map());
      const dimMap = root.get(sec);
      if (!dimMap.has(dimVal)) dimMap.set(dimVal, new Map());
      const artMap = dimMap.get(dimVal);
      if (!artMap.has(aid)) {
        artMap.set(aid, { art_id: aid, code: row.art_code, designation: row.art_designation,
          buyers: new Set(), cartons: 0, ca: 0, qte: 0, releveOnly: true });
        if (!artMeta.has(aid)) artMeta.set(aid, { code: row.art_code, designation: row.art_designation, dim_value: dimVal });
      }
    });

    // Sérialisation du tree
    const treeBySecteur = [];
    root.forEach((dimMap, sec) => {
      const totalClientsSec = clientsBySecteur.get(sec)?.size || 0;
      const dimsArr = [];
      const secBuyers = new Set();
      let secCartons = 0, secNbReleves = 0;
      dimMap.forEach((artMap, dimVal) => {
        const articlesArr = [];
        const dimBuyers = new Set();
        let dimCartons = 0, dimNbReleves = 0;
        artMap.forEach(node => {
          const releve = releveBySecteurArt.get(`${sec}||${node.art_id}`);
          const pv_moyen_ht = node.qte > 0 ? node.ca / node.qte : null;
          const prix_mon_releve = releve ? releve.prix_mon_releve_moy_ht : null;
          const prix_conc_moy   = releve ? releve.prix_concurrent_moy_ht : null;
          // Écart = mon prix relevé (terrain) vs prix concurrent relevé (terrain).
          // Positif = je suis plus cher que le concurrent.
          const ecart_pct = (prix_mon_releve && prix_conc_moy)
            ? (prix_mon_releve - prix_conc_moy) / prix_mon_releve * 100 : null;
          articlesArr.push({
            type: 'article',
            art_id: node.art_id, code: node.code, designation: node.designation,
            nbBuyers: node.buyers.size,
            cartons: node.cartons, qte: node.qte, pv_moyen_ht,
            prix_mon_releve_moy_ht: prix_mon_releve,
            nb_mon_releve: releve?.nb_mon_releve || 0,
            nb_releves: releve?.nb_releves || 0,
            nb_clients_releves: releve?.nb_clients_releves || 0,
            prix_concurrent_min_ht: releve?.prix_concurrent_min_ht ?? null,
            prix_concurrent_moy_ht: prix_conc_moy,
            prix_concurrent_max_ht: releve?.prix_concurrent_max_ht ?? null,
            nb_concurrent: releve?.nb_concurrent || 0,
            prix_promo_moy_ht: releve?.prix_promo_moy_ht ?? null,
            dernier_releve: releve?.dernier_releve || null,
            ecart_pct,
          });
          node.buyers.forEach(t => { dimBuyers.add(t); secBuyers.add(t); });
          dimCartons += node.cartons;
          if (releve) dimNbReleves += releve.nb_releves;
        });
        articlesArr.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fr', { numeric: true }));
        dimsArr.push({
          type: 'dim', label: dimVal,
          nbBuyers: dimBuyers.size, cartons: dimCartons,
          nbArticles: articlesArr.length, nb_releves: dimNbReleves,
          children: articlesArr,
        });
        secCartons += dimCartons;
        secNbReleves += dimNbReleves;
      });
      // Tri par cartons desc (mesure principale)
      dimsArr.sort((a, b) => (b.cartons - a.cartons) || (b.nbBuyers - a.nbBuyers));
      treeBySecteur.push({
        type: 'secteur', label: sec,
        totalClients: totalClientsSec,
        nbBuyers: secBuyers.size,
        cartons: secCartons, nbDims: dimsArr.length, nb_releves: secNbReleves,
        children: dimsArr,
      });
    });
    treeBySecteur.sort((a, b) => (b.cartons - a.cartons) || (b.nbBuyers - a.nbBuyers));

    // ───── Gaps article et gaps client (par secteur × dim) ──────────────────
    const gapsByArticle = [];
    const gapsByClient = [];
    root.forEach((dimMap, sec) => {
      const secClients = clientsBySecteur.get(sec) || new Set();
      dimMap.forEach((artMap, dimVal) => {
        const articleGaps = [];
        const clientMissing = new Map();
        artMap.forEach(node => {
          if (node.releveOnly) return; // article relevé mais non vendu : hors gaps de pénétration
          const absents = [];
          secClients.forEach(t => { if (!node.buyers.has(t)) absents.push(t); });
          if (absents.length) {
            const clients = absents.map(t => tirInfoMap.get(t)).filter(Boolean)
              .sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr'));
            articleGaps.push({
              art_id: node.art_id, code: node.code, designation: node.designation,
              nbAbsents: clients.length, nbBuyers: node.buyers.size, clients,
              concurrents: dedupeConc(concByArticleSec.get(`${sec}||${node.art_id}`)),
            });
            absents.forEach(t => {
              if (!clientMissing.has(t)) clientMissing.set(t, []);
              clientMissing.get(t).push({ art_id: node.art_id, code: node.code, designation: node.designation });
            });
          }
        });
        if (articleGaps.length) {
          articleGaps.sort((a, b) => b.nbAbsents - a.nbAbsents);
          gapsByArticle.push({ secteur: sec, dim_value: dimVal, articles: articleGaps });
        }
        if (clientMissing.size) {
          const clientsArr = [];
          clientMissing.forEach((missing, t) => {
            const info = tirInfoMap.get(t); if (!info) return;
            missing.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fr', { numeric: true }));
            clientsArr.push({
              ...info, nbMissing: missing.length, nbArticlesDim: artMap.size, missingArticles: missing,
              concurrents: dedupeConc(concByClient.get(`${sec}||${t}`)),
            });
          });
          clientsArr.sort((a, b) => b.nbMissing - a.nbMissing);
          gapsByClient.push({ secteur: sec, dim_value: dimVal, nbArticlesDim: artMap.size, clients: clientsArr });
        }
      });
    });
    gapsByArticle.sort((a, b) => a.secteur.localeCompare(b.secteur, 'fr') || a.dim_value.localeCompare(b.dim_value, 'fr'));
    gapsByClient.sort((a, b) => a.secteur.localeCompare(b.secteur, 'fr') || a.dim_value.localeCompare(b.dim_value, 'fr'));

    // ───── Concurrents : liste plate secteur → client → produits (pour export Excel).
    // Limitée à l'univers client filtré (présent dans tirInfoMap).
    const concurrents = [];
    concByClient.forEach((list, key) => {
      const sep = key.indexOf('||');
      const sec = key.slice(0, sep);
      const tid = parseInt(key.slice(sep + 2), 10);
      const info = tirInfoMap.get(tid);
      if (!info) return;
      concurrents.push({
        secteur: sec, tir_id: tid, nom: info.nom, code: info.code, commercial: info.commercial || '',
        products: dedupeConc(list),
      });
    });
    concurrents.sort((a, b) => a.secteur.localeCompare(b.secteur, 'fr') || (a.nom || '').localeCompare(b.nom || '', 'fr'));

    // ───── Pricing : nouvelle hiérarchie SECTEUR → CLIENT → ARTICLE ─────────
    // PV chez le client : utilise pvByClientArt (lookup q2).
    const pvByClientArt = new Map();
    q2.recordset.forEach(row => {
      const key = `${row.tir_id}|${row.art_id}`;
      const pv = parseFloat(row.pv_moyen_ht);
      if (isFinite(pv) && pv > 0) pvByClientArt.set(key, pv);
    });
    // Groupement : secteur → tirid → [relevés]
    const pricingTree = new Map();
    q4.recordset.forEach(row => {
      const sec = row.secteur;
      const tid = row.tir_id;
      if (!pricingTree.has(sec)) pricingTree.set(sec, new Map());
      const cliMap = pricingTree.get(sec);
      if (!cliMap.has(tid)) cliMap.set(tid, []);
      cliMap.get(tid).push(row);
    });
    const pricingBySecteur = [];
    pricingTree.forEach((cliMap, sec) => {
      const clients = [];
      cliMap.forEach((rows, tid) => {
        // 1 relevé = 1 article × 1 date (pas d'agrégation, on garde le détail brut)
        const articles = rows.map(row => {
          const pvClient = pvByClientArt.get(`${tid}|${row.art_id}`) || null;
          const ecart_pct = (pvClient && row.prix_releve_ht > 0)
            ? (pvClient - row.prix_releve_ht) / pvClient * 100 : null;
          return {
            art_id: row.art_id, code: row.art_code, designation: row.art_designation,
            marque: row.art_marque, dim_value: row.dim_value,
            prix_releve_ht: row.prix_releve_ht, prix_promo_ht: row.prix_promo_ht,
            mon_pv_ht: pvClient, ecart_pct,
            marque_releve: row.marque_releve, match_type: row.match_type,
            date_releve: row.date_releve,
          };
        }).sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fr', { numeric: true })
                          || (b.date_releve || '').localeCompare(a.date_releve || ''));
        const info = tirInfoMap.get(tid) || { tir_id: tid, code: rows[0].client_code, nom: rows[0].client_nom, secteur: sec, commercial: '' };
        clients.push({
          tir_id: tid, code: info.code, nom: info.nom, commercial: info.commercial || '',
          nb_releves: rows.length,
          nb_articles: new Set(rows.map(r => r.art_id)).size,
          articles,
        });
      });
      clients.sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr'));
      const totReleves  = clients.reduce((s, c) => s + c.nb_releves, 0);
      pricingBySecteur.push({
        secteur: sec, nb_clients: clients.length, nb_releves: totReleves, clients,
      });
    });
    pricingBySecteur.sort((a, b) => a.secteur.localeCompare(b.secteur, 'fr'));

    // ───── Chart data : prix relevé moyen par secteur × dim_value ───────────
    // Aggr Q4 par (secteur, dim_value) → moyenne prix relevé HT.
    const chartAcc = new Map(); // `${sec}|${dim}` → { sum, n }
    const chartDimSet = new Set();
    const chartSecSet = new Set();
    q4.recordset.forEach(row => {
      const sec = row.secteur, dv = row.dim_value;
      if (sec == null || dv == null) return;
      chartSecSet.add(sec); chartDimSet.add(dv);
      const key = `${sec}|${dv}`;
      if (!chartAcc.has(key)) chartAcc.set(key, { sum: 0, n: 0 });
      const slot = chartAcc.get(key);
      slot.sum += parseFloat(row.prix_releve_ht) || 0;
      slot.n   += 1;
    });
    const chartSecteurs = Array.from(chartSecSet).sort((a, b) => a.localeCompare(b, 'fr'));
    const chartDims     = Array.from(chartDimSet).sort((a, b) => a.localeCompare(b, 'fr'));
    const chartSeries = chartDims.map(dv => ({
      dim_value: dv,
      prixMoyHt: chartSecteurs.map(sec => {
        const slot = chartAcc.get(`${sec}|${dv}`);
        return slot && slot.n > 0 ? slot.sum / slot.n : null;
      }),
    }));

    // ───── KPIs globaux (cartons remplace CA) ───────────────────────────────
    const globalBuyers = new Set();
    let globalCartons = 0;
    q2.recordset.forEach(r => { globalBuyers.add(r.tir_id); globalCartons += parseFloat(r.cartons) || 0; });
    const nb_articles_releves = releveByArt.size;
    const nb_articles_a_risque = Array.from(releveByArt.entries()).filter(([aid, rl]) => {
      const meta = artMeta.get(aid); if (!meta) return false;
      let ca = 0, qte = 0;
      q2.recordset.forEach(r => { if (r.art_id === aid) { ca += parseFloat(r.ca_net_ht)||0; qte += parseFloat(r.qte)||0; } });
      const pv = qte > 0 ? ca / qte : null;
      if (!pv || !rl.prix_concurrent_moy_ht) return false;
      return (pv - rl.prix_concurrent_moy_ht) / pv * 100 > 5;
    }).length;

    return {
      generatedAt: new Date().toISOString(),
      periode: p,
      periodeN1: isPeriodMode ? { date_debut: dN1, date_fin: fN1 } : null,
      tva,
      dim,
      db: { database: dbNameRow, societe },
      filtres: { secteurs, marques, familles, repids, cliactif: cliactifRaw, dim },
      kpis: {
        totalClientsPortefeuille: tirInfoMap.size,
        nbAcheteurs: globalBuyers.size,
        cartons: globalCartons,
        nbArticlesAvecRelevePrix: nb_articles_releves,
        nbArticlesARisque: nb_articles_a_risque,
        nbRelevés: q4.recordset.length,
      },
      treeBySecteur,
      gapsByArticle,
      gapsByClient,
      pricingBySecteur,
      concurrents,
      concurrentsNonRattaches,
      chart: {
        secteurs: chartSecteurs,
        series: chartSeries,
        dimLabel: dim,
      },
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

const DIM_LABELS_BACK = {
  ARTMARQUE: 'Marque', ARTFAMILLE: 'Famille', ARTSOUSFAMILLE: 'Sous-famille',
  ARTCATEGORIE: 'Catégorie', ARTCLASSE: 'Classe', ARTNATURE: 'Nature', ARTCOLLECTION: 'Collection',
};

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
  const dimL = DIM_LABELS_BACK[data.dim] || data.dim || 'Dimension';

  // ── Sheet 1 : Synthèse ───────────────────────────────────────────────────
  const wsSyn = wb.addWorksheet('Synthèse');
  wsSyn.columns = [
    { header:'Indicateur', key:'k', width:42 },
    { header:'Valeur',     key:'v', width:38 },
  ];
  wsSyn.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center'}; });
  wsSyn.addRow({ k:'Période',                  v:`${data.periode.date_debut} → ${data.periode.date_fin}` });
  if (data.periodeN1) wsSyn.addRow({ k:'Période N-1 (filtre CA N/N-1)', v:`${data.periodeN1.date_debut} → ${data.periodeN1.date_fin}` });
  wsSyn.addRow({ k:'TVA',                      v:`${data.tva} %` });
  wsSyn.addRow({ k:'Dimension article',        v:dimL });
  wsSyn.addRow({ k:'Filtre clients',           v:filtres.cliactif || 'O' });
  wsSyn.addRow({ k:'Base',                     v:`${data.db?.database || ''}${data.db?.societe ? ' · '+data.db.societe : ''}` });
  wsSyn.addRow({ k:'Secteurs filtrés',         v:(filtres.secteurs||[]).join(', ') || '(tous)' });
  wsSyn.addRow({ k:`${dimL} filtrée(s)`,        v:(filtres.marques||[]).join(', ') || '(toutes)' });
  wsSyn.addRow({ k:'Familles filtrées',        v:(filtres.familles||[]).join(', ') || '(toutes)' });
  wsSyn.addRow({ k:'Clients portefeuille',     v:k.totalClientsPortefeuille||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:'Acheteurs (période)',      v:k.nbAcheteurs||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:'Cartons vendus',           v:k.cartons||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:'Articles avec relevé prix', v:k.nbArticlesAvecRelevePrix||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:'Relevés résolus',          v:k.nbRelevés||0 }).getCell('v').numFmt = numFmt;
  wsSyn.addRow({ k:'Articles à risque (≥5%)',  v:k.nbArticlesARisque||0 }).getCell('v').numFmt = numFmt;

  // ── Sheet 2 : Hiérarchie (cartons remplace CA) ──────────────────────────
  const wsTree = wb.addWorksheet('Hiérarchie');
  wsTree.columns = [
    { header:'Niveau', key:'lvl', width:10 },
    { header:'Libellé', key:'lbl', width:55 },
    { header:'Clients', key:'cli', width:10 },
    { header:'Acheteurs', key:'ach', width:11 },
    { header:'Cartons', key:'crt', width:12 },
    { header:'Mon PV HT', key:'pv', width:13 },
    { header:'Mon relevé moy HT', key:'mrel', width:16 },
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
    const rS = wsTree.addRow({ lvl:'SECTEUR', lbl:s.label, cli:s.totalClients, ach:s.nbBuyers, crt:s.cartons, rel:s.nb_releves });
    rS.eachCell(c => { c.fill=lvl1Fill; c.font={ bold:true, size:10 }; });
    rS.getCell('crt').numFmt = numFmt;
    (s.children || []).forEach(m => {
      const rM = wsTree.addRow({ lvl:`  ${dimL.toUpperCase()}`, lbl:'  '+m.label, ach:m.nbBuyers, crt:m.cartons, rel:m.nb_releves });
      rM.eachCell(c => { c.fill=lvl2Fill; c.font={ bold:true, size:10 }; });
      rM.getCell('crt').numFmt = numFmt;
      (m.children || []).forEach(a => {
        const rA = wsTree.addRow({
          lvl:'    ART', lbl:'    '+(a.code||'')+' — '+(a.designation||''),
          ach:a.nbBuyers, crt:a.cartons,
          pv:a.pv_moyen_ht, mrel:a.prix_mon_releve_moy_ht, cmoy:a.prix_concurrent_moy_ht,
          cmin:a.prix_concurrent_min_ht, cmax:a.prix_concurrent_max_ht,
          ecart:a.ecart_pct, rel:a.nb_releves, der:a.dernier_releve,
        });
        rA.getCell('crt').numFmt  = numFmt;
        rA.getCell('pv').numFmt   = eurFmt;
        rA.getCell('mrel').numFmt = eurFmt;
        rA.getCell('cmoy').numFmt = eurFmt;
        rA.getCell('cmin').numFmt = eurFmt;
        rA.getCell('cmax').numFmt = eurFmt;
        rA.getCell('ecart').numFmt = pctFmt;
      });
    });
  });

  // ── Sheet 3 : Gaps articles (par secteur×dim×article → clients absents) ──
  const wsGapsArt = wb.addWorksheet('Gaps articles');
  wsGapsArt.columns = [
    { header:'Secteur', key:'sec', width:25 },
    { header:dimL,      key:'dim', width:22 },
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
          sec:entry.secteur, dim:entry.dim_value,
          cod:art.code, des:art.designation,
          nba:art.nbAbsents, tot:art.nbBuyers + art.nbAbsents,
          cli:c.nom, cco:c.code, com:c.commercial || '',
        });
      });
    });
  });

  // ── Sheet 4 : Gaps clients (par client → articles manquants par dim) ────
  const wsGapsCli = wb.addWorksheet('Gaps clients');
  wsGapsCli.columns = [
    { header:'Secteur', key:'sec', width:25 },
    { header:dimL,      key:'dim', width:22 },
    { header:'Client', key:'cli', width:35 },
    { header:'Code client', key:'cco', width:14 },
    { header:'Commercial', key:'com', width:22 },
    { header:'Nb manquants', key:'nbm', width:13 },
    { header:`Total ${dimL.toLowerCase()}`, key:'tot', width:13 },
    { header:'Code article manquant', key:'cod', width:18 },
    { header:'Désignation', key:'des', width:50 },
  ];
  wsGapsCli.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center',wrapText:true}; });
  wsGapsCli.views = [{ state:'frozen', ySplit:1 }];
  (data.gapsByClient || []).forEach(entry => {
    (entry.clients || []).forEach(c => {
      (c.missingArticles || []).forEach(a => {
        wsGapsCli.addRow({
          sec:entry.secteur, dim:entry.dim_value,
          cli:c.nom, cco:c.code, com:c.commercial || '',
          nbm:c.nbMissing, tot:c.nbArticlesDim,
          cod:a.code, des:a.designation,
        });
      });
    });
  });

  // ── Sheet 5 : Prix par secteur > client > article ───────────────────────
  const wsPri = wb.addWorksheet('Prix concurrents');
  wsPri.columns = [
    { header:'Secteur', key:'sec', width:25 },
    { header:'Client', key:'cli', width:35 },
    { header:'Code client', key:'cco', width:14 },
    { header:'Commercial', key:'com', width:22 },
    { header:'Code article', key:'cod', width:14 },
    { header:'Article', key:'des', width:40 },
    { header:'Marque article', key:'mar', width:20 },
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
  (data.pricingBySecteur || []).forEach(entry => {
    (entry.clients || []).forEach(c => {
      (c.articles || []).forEach(a => {
        const r = wsPri.addRow({
          sec:entry.secteur, cli:c.nom, cco:c.code, com:c.commercial,
          cod:a.code, des:a.designation, mar:a.marque,
          dat:a.date_releve,
          pr:a.prix_releve_ht, pp:a.prix_promo_ht, pv:a.mon_pv_ht, ec:a.ecart_pct,
          mre:a.marque_releve, mat:a.match_type,
        });
        r.getCell('pr').numFmt = eurFmt;
        r.getCell('pp').numFmt = eurFmt;
        r.getCell('pv').numFmt = eurFmt;
        r.getCell('ec').numFmt = pctFmt;
      });
    });
  });

  // ── Sheet 6 : Chart data (prix relevé moyen par secteur × dim) ──────────
  if (data.chart && data.chart.secteurs.length && data.chart.series.length) {
    const wsChart = wb.addWorksheet(`Prix moy × ${dimL}`);
    wsChart.addRow(['Secteur', ...data.chart.series.map(s => s.dim_value)]);
    wsChart.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; });
    data.chart.secteurs.forEach((sec, i) => {
      const row = [sec, ...data.chart.series.map(s => s.prixMoyHt[i])];
      const r = wsChart.addRow(row);
      for (let j = 2; j <= row.length; j++) r.getCell(j).numFmt = eurFmt;
    });
    wsChart.columns.forEach(col => { col.width = 20; });
  }

  // ── Sheet 7 : Concurrents relevés par client ────────────────────────────
  if ((data.concurrents || []).length) {
    const wsConc = wb.addWorksheet('Concurrents par client');
    wsConc.columns = [
      { header:'Secteur', key:'sec', width:25 },
      { header:'Client', key:'cli', width:35 },
      { header:'Code client', key:'cco', width:14 },
      { header:'Commercial', key:'com', width:22 },
      { header:'Produit concurrent', key:'lib', width:40 },
      { header:'Référence', key:'ref', width:18 },
      { header:'Marque', key:'mar', width:18 },
      { header:`Classification (${dimL})`, key:'cla', width:22 },
      { header:'Type relevé', key:'typ', width:16 },
      { header:'Prix relevé HT', key:'pr', width:14 },
      { header:'Promo HT', key:'pp', width:13 },
      { header:'Dernier relevé', key:'dat', width:13 },
      { header:'Nb relevés', key:'nb', width:11 },
    ];
    wsConc.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center',wrapText:true}; });
    wsConc.views = [{ state:'frozen', ySplit:1 }];
    data.concurrents.forEach(entry => {
      (entry.products || []).forEach(p => {
        const r = wsConc.addRow({
          sec:entry.secteur, cli:entry.nom, cco:entry.code, com:entry.commercial,
          lib:p.libelle, ref:p.ref, mar:p.marque || '', cla:p.classif || 'Indéfini',
          typ:p.match_type, pr:p.prix_releve_ht, pp:p.prix_promo_ht, dat:p.date_releve, nb:p.nb_releves,
        });
        r.getCell('pr').numFmt = eurFmt;
        r.getCell('pp').numFmt = eurFmt;
        r.getCell('nb').numFmt = numFmt;
      });
    });
  }

  // ── Sheet 8 : Produits concurrents non rattachés (secteur → client → produit) ──
  if ((data.concurrentsNonRattaches || []).length) {
    const wsNR = wb.addWorksheet('Concurrents non rattachés');
    wsNR.columns = [
      { header:'Secteur', key:'sec', width:25 },
      { header:'Client', key:'cli', width:35 },
      { header:'Code client', key:'cco', width:14 },
      { header:'Référence', key:'ref', width:18 },
      { header:'Produit concurrent', key:'lib', width:42 },
      { header:'Marque', key:'mar', width:20 },
      { header:'Type relevé', key:'typ', width:18 },
      { header:'Prix relevé HT', key:'pr', width:14 },
      { header:'Promo HT', key:'pp', width:13 },
      { header:'Dernier relevé', key:'dat', width:13 },
      { header:'Nb relevés', key:'nb', width:11 },
    ];
    wsNR.getRow(1).eachCell(c => { c.fill=headerFill; c.font=headerFont; c.border=border; c.alignment={horizontal:'center',wrapText:true}; });
    wsNR.views = [{ state:'frozen', ySplit:1 }];
    data.concurrentsNonRattaches.forEach(entry => {
      (entry.clients || []).forEach(c => {
        (c.produits || []).forEach(p => {
          const r = wsNR.addRow({
            sec:entry.secteur, cli:c.nom, cco:c.code,
            ref:p.ref, lib:p.libelle, mar:p.marque || '', typ:p.match_type,
            pr:p.prix_releve_ht, pp:p.prix_promo_ht, dat:p.date_releve, nb:p.nb_releves,
          });
          r.getCell('pr').numFmt = eurFmt;
          r.getCell('pp').numFmt = eurFmt;
          r.getCell('nb').numFmt = numFmt;
        });
      });
    });
  }

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
  const dimL = DIM_LABELS_BACK[data.dim] || data.dim || 'Dimension';

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
    ${data.periodeN1 ? `· N-1 : ${esc(data.periodeN1.date_debut)} → ${esc(data.periodeN1.date_fin)}` : ''}
    · TVA ${esc(data.tva)} %
    · Dim : ${esc(dimL)}
    · Filtre clients : ${esc(f.cliactif || 'O')}
    · Base : ${esc(data.db?.database || '')}${data.db?.societe ? ' · '+esc(data.db.societe) : ''}
    · Secteurs : ${(f.secteurs||[]).map(esc).join(', ') || '(tous)'}
    · ${esc(dimL)} : ${(f.marques||[]).map(esc).join(', ') || '(toutes)'}
    · Familles : ${(f.familles||[]).map(esc).join(', ') || '(toutes)'}
    · Généré le ${new Date(data.generatedAt).toLocaleString('fr-FR')}
  </div>
  <div class="kpis">
    <div class="kpi"><div class="l">Clients portefeuille</div><div class="v">${fmt(k.totalClientsPortefeuille)}</div></div>
    <div class="kpi"><div class="l">Acheteurs</div><div class="v">${fmt(k.nbAcheteurs)}</div></div>
    <div class="kpi"><div class="l">Cartons vendus</div><div class="v">${fmt(k.cartons)}</div></div>
    <div class="kpi"><div class="l">Articles avec relevé</div><div class="v">${fmt(k.nbArticlesAvecRelevePrix)}</div></div>
    <div class="kpi"><div class="l">Articles à risque</div><div class="v">${fmt(k.nbArticlesARisque)}</div></div>
  </div>

  <h2>📂 Hiérarchie secteur → ${esc(dimL.toLowerCase())} → article</h2>
  <table>
    <thead><tr>
      <th>Niveau</th><th>Clients</th><th>Acheteurs</th><th>Cartons</th>
      <th>Mon PV</th><th>Conc. moy</th><th>Min / Max</th><th>Écart</th><th>Relevés</th>
    </tr></thead><tbody>`;
  (data.treeBySecteur || []).forEach(s => {
    html += `<tr class="lvl-sec"><td>${esc(s.label)}</td><td>${fmt(s.totalClients)}</td><td>${fmt(s.nbBuyers)}</td><td>${fmt(s.cartons)}</td><td colspan="4">${s.children.length} ${esc(dimL.toLowerCase())}(s)</td><td>${fmt(s.nb_releves)}</td></tr>`;
    s.children.forEach(m => {
      html += `<tr class="lvl-mar"><td>↳ ${esc(m.label)}</td><td></td><td>${fmt(m.nbBuyers)}</td><td>${fmt(m.cartons)}</td><td colspan="4">${m.children.length} art</td><td>${fmt(m.nb_releves)}</td></tr>`;
      m.children.forEach(a => {
        const ec = a.ecart_pct;
        const ecCls = ec==null ? '' : (ec >= 5 ? 'ecart-bad' : (ec <= -2 ? 'ecart-good' : 'ecart-avg'));
        const minMax = (a.prix_concurrent_min_ht != null && a.prix_concurrent_max_ht != null)
          ? `${fmtEur(a.prix_concurrent_min_ht, 2)} / ${fmtEur(a.prix_concurrent_max_ht, 2)}` : '—';
        html += `<tr class="lvl-art"><td>${esc(a.code)} — ${esc(a.designation || '')}</td><td></td><td>${fmt(a.nbBuyers)}</td><td>${fmt(a.cartons)}</td><td>${fmtEur(a.pv_moyen_ht, 2)}</td><td>${fmtEur(a.prix_concurrent_moy_ht, 2)}</td><td>${minMax}</td><td class="${ecCls}">${fmtPct(ec)}</td><td>${fmt(a.nb_releves)}</td></tr>`;
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
        const concList = (art.concurrents || []).slice(0, 15).map(p =>
          `${esc(p.libelle)}${p.marque ? ' ('+esc(p.marque)+')' : ''}${p.prix_releve_ht!=null ? ' '+fmtEur(p.prix_releve_ht,2) : ''}`).join(' · ');
        const concHtml = concList
          ? `<br><small style="color:#1565c0">🆚 ${concList}${art.concurrents.length > 15 ? ' …' : ''}</small>` : '';
        html += `<div class="gap-row"><b>${esc(entry.secteur)} · ${esc(entry.dim_value)} · ${esc(art.code)}</b> ${esc(art.designation || '')}<span class="count">${art.nbAbsents}/${tot} (${fmt(pct, 1)}%)</span><br><small>${cliList}${extra}</small>${concHtml}</div>`;
      });
    });
  }

  // Pricing par secteur > client > article
  if ((data.pricingBySecteur || []).length) {
    html += `<div class="pagebreak"></div><h2>💶 Comparatif prix concurrents — par secteur d'activité → client → article</h2>`;
    data.pricingBySecteur.forEach(entry => {
      html += `<h3 style="font-size:10pt;margin:8px 0 4px;color:#1B5E20;border-bottom:1px solid #1B5E20">${esc(entry.secteur)} <small style="color:#666;font-weight:400">· ${entry.nb_clients} client(s) · ${entry.nb_releves} relevé(s)</small></h3>`;
      entry.clients.forEach(c => {
        html += `<h4 style="font-size:9pt;margin:6px 0 2px;color:#444">${esc(c.nom)} <small style="color:#888;font-weight:400">· ${esc(c.code||'')} · ${esc(c.commercial||'')}</small></h4>`;
        html += `<table><thead><tr>
          <th>Code</th><th>Article</th><th>Date</th>
          <th>Prix relevé</th><th>Promo</th><th>Mon PV</th><th>Écart</th>
        </tr></thead><tbody>`;
        c.articles.forEach(a => {
          const ec = a.ecart_pct;
          const ecCls = ec==null ? '' : (ec >= 5 ? 'ecart-bad' : (ec <= -2 ? 'ecart-good' : 'ecart-avg'));
          html += `<tr>
            <td>${esc(a.code||'')}</td>
            <td>${esc(a.designation || '')}</td>
            <td>${esc(a.date_releve || '')}</td>
            <td>${fmtEur(a.prix_releve_ht, 2)}</td>
            <td>${fmtEur(a.prix_promo_ht, 2)}</td>
            <td>${fmtEur(a.mon_pv_ht, 2)}</td>
            <td class="${ecCls}">${fmtPct(ec)}</td>
          </tr>`;
        });
        html += `</tbody></table>`;
      });
    });
  }

  html += `</body></html>`;
  return html;
}

module.exports = router;

const express = require('express');
const router  = express.Router();
const { getUserPool, sql } = require('../../config/database');

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

// ── Filtres : dépôts + familles + fournisseurs ────────────────────────────────
router.get('/filters', async (req, res) => {
  try {
    const pool = await getUserPool(req.user);
    const [deps, fams, fous] = await Promise.all([
      pool.request().query(`
        SELECT DEPID, DEPINTITULE AS libelle, DEPISPRINCIPAL AS principal
        FROM DEPOTS WHERE DEPISACTIF='O' ORDER BY DEPISPRINCIPAL DESC, DEPINTITULE
      `),
      pool.request().query(`
        SELECT DISTINCT ISNULL(RTRIM(af.AFMINTITULE),'Sans famille') AS libelle, af.AFMID AS id
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID = ad.ARTID
        LEFT JOIN ARTFAMILLES af ON af.AFMID = a.AFMID
        WHERE ad.ARDSTOCKREEL <> 0
        ORDER BY libelle
      `),
      pool.request().query(`
        SELECT DISTINCT t.TIRID AS id, RTRIM(t.TIRSOCIETE) AS libelle,
               COUNT(DISTINCT p.ARTID) AS nb_articles
        FROM PRODUITS p
        JOIN TIERS t ON t.TIRID=p.TIRID AND t.TIRTYPE='F'
        JOIN ARTICLES a ON a.ARTID=p.ARTID
        GROUP BY t.TIRID, t.TIRSOCIETE
        ORDER BY nb_articles DESC, libelle
      `)
    ]);
    res.json({ depots: deps.recordset, familles: fams.recordset, fournisseurs: fous.recordset });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KPIs globaux ──────────────────────────────────────────────────────────────
router.get('/kpis', async (req, res) => {
  const depid = req.query.depid ? parseInt(req.query.depid) : null;
  const fouid = req.query.fouid ? parseInt(req.query.fouid) : null;
  const depF  = depid ? 'AND ad.DEPID=@depid' : '';
  const fouF  = fouid ? "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)" : '';
  try {
    const pool = await getUserPool(req.user);
    const r = pool.request();
    if (depid) r.input('depid', sql.Int, depid);
    if (fouid) r.input('fouid', sql.Int, fouid);

    const [val, rupt, seuil, mvt] = await Promise.all([
      // Valeur stock actuel (CRUMP + PRMP)
      r.query(`
        SELECT
          SUM(CASE WHEN ad.ARDSTOCKREEL>0 THEN ad.ARDSTOCKREEL * ISNULL(a.ARTCRUMP,0) ELSE 0 END) AS val_crump,
          SUM(CASE WHEN ad.ARDSTOCKREEL>0 THEN ad.ARDSTOCKREEL * ISNULL(a.ARTPRMP,0)  ELSE 0 END) AS val_prmp,
          SUM(CASE WHEN ad.ARDSTOCKREEL>0 THEN ad.ARDSTOCKREEL * ISNULL(a.ARTPMP,0)   ELSE 0 END) AS val_pmp,
          COUNT(CASE WHEN ad.ARDSTOCKREEL>0 THEN 1 END)   AS nb_en_stock,
          COUNT(*)                                         AS nb_articles_geres
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID=ad.ARTID
        WHERE 1=1 ${depF} ${fouF}
      `),
      // Ruptures (stock <= 0, seuil > 0)
      (async () => {
        const r2 = pool.request();
        if (depid) r2.input('depid', sql.Int, depid);
        if (fouid) r2.input('fouid', sql.Int, fouid);
        return r2.query(`SELECT COUNT(*) AS nb FROM ARTDEPOT ad JOIN ARTICLES a ON a.ARTID=ad.ARTID WHERE ad.ARDSTOCKREEL<=0 AND ad.ARDSEUILMIN>0 ${depF} ${fouF}`);
      })(),
      // Sous seuil (0 < stock < seuil_min)
      (async () => {
        const r2 = pool.request();
        if (depid) r2.input('depid', sql.Int, depid);
        if (fouid) r2.input('fouid', sql.Int, fouid);
        return r2.query(`SELECT COUNT(*) AS nb FROM ARTDEPOT ad JOIN ARTICLES a ON a.ARTID=ad.ARTID WHERE ad.ARDSTOCKREEL>0 AND ad.ARDSEUILMIN>0 AND ad.ARDSTOCKREEL<ad.ARDSEUILMIN ${depF} ${fouF}`);
      })(),
      // Dernière date de mouvement
      pool.request().query(`SELECT MAX(OPEDATE) AS last_mvt FROM OPERATIONSTOCK WHERE OPENATURESTOCK='R'`)
    ]);

    const v = val.recordset[0];
    res.json({
      val_crump:       parseFloat(v.val_crump) || 0,
      val_prmp:        parseFloat(v.val_prmp)  || 0,
      val_pmp:         parseFloat(v.val_pmp)   || 0,
      nb_en_stock:     v.nb_en_stock     || 0,
      nb_articles_geres: v.nb_articles_geres || 0,
      nb_ruptures:     rupt.recordset[0].nb || 0,
      nb_sous_seuil:   seuil.recordset[0].nb || 0,
      last_mvt:        mvt.recordset[0].last_mvt,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Ruptures de stock ─────────────────────────────────────────────────────────
router.get('/ruptures', async (req, res) => {
  const depid   = req.query.depid   ? parseInt(req.query.depid)   : null;
  const famille = req.query.famille ? parseInt(req.query.famille) : null;
  const fouid   = req.query.fouid   ? parseInt(req.query.fouid)   : null;
  const limit   = Math.min(parseInt(req.query.limit) || 100, 500);
  const inclSousSeuil = req.query.sous_seuil === '1';

  const depF = depid   ? 'AND ad.DEPID=@depid'    : '';
  const famF = famille ? 'AND a.AFMID=@famille'   : '';
  const fouF = fouid   ? "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)" : '';
  const stockCond = inclSousSeuil
    ? 'ad.ARDSEUILMIN>0 AND ad.ARDSTOCKREEL<ad.ARDSEUILMIN'
    : 'ad.ARDSTOCKREEL<=0 AND ad.ARDSEUILMIN>0';

  try {
    const pool = await getUserPool(req.user);
    const r = pool.request();
    r.input('limit', sql.Int, limit);
    if (depid)   r.input('depid',   sql.Int, depid);
    if (famille) r.input('famille', sql.Int, famille);
    if (fouid)   r.input('fouid',   sql.Int, fouid);

    // Date 90 jours en arrière pour CA récent
    const d90 = new Date(); d90.setDate(d90.getDate() - 90);
    r.input('date90', sql.VarChar(10), isoDate(d90));

    const result = await r.query(`
      SELECT TOP (@limit)
        a.ARTID, RTRIM(a.ARTCODE) AS ref, RTRIM(a.ARTDESIGNATION) AS designation,
        ISNULL(RTRIM(af.AFMINTITULE),'Sans famille') AS famille,
        ad.ARDSTOCKREEL    AS stock_reel,
        ad.ARDSTOCKCDE     AS stock_cde,
        ad.ARDSTOCKRSV     AS stock_rsv,
        ad.ARDSEUILMIN     AS seuil_min,
        ad.ARDSEUILMAX     AS seuil_max,
        ad.ARDLASTDATEIN   AS derniere_entree,
        ad.ARDLASTDATEOUT  AS derniere_sortie,
        ISNULL(a.ARTCRUMP, 0) AS pr_crump,
        ISNULL(a.ARTPRMP,  0) AS pr_prmp,
        -- Manque à stock : qté à commander pour revenir au seuil min
        CASE WHEN ad.ARDSEUILMIN>0 THEN ad.ARDSEUILMIN - ad.ARDSTOCKREEL ELSE 0 END AS manque_qte,
        -- CA sur les 90 derniers jours (jointure ventes)
        ISNULL(ca90.ca_90j, 0) AS ca_90j,
        ISNULL(ca90.qte_90j, 0) AS qte_90j
      FROM ARTDEPOT ad
      JOIN ARTICLES a ON a.ARTID = ad.ARTID
      LEFT JOIN ARTFAMILLES af ON af.AFMID = a.AFMID
      LEFT JOIN (
        SELECT pl.ARTID,
          SUM(ABS(pl.PLVMNTNETHT) * pn.PINSENSSTATISTIQUE) AS ca_90j,
          SUM(ABS(pl.PLVQTE)      * pn.PINSENSSTATISTIQUE) AS qte_90j
        FROM PIECEVENTELIGNES pl
        JOIN PIECEVENTES pv ON pv.PCVID = pl.PCVID
        JOIN PIECE_NATURE pn ON pn.PINID = pv.PINID
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0
          AND pv.PCVDATEEFFET >= @date90
        GROUP BY pl.ARTID
      ) ca90 ON ca90.ARTID = a.ARTID
      WHERE ${stockCond} ${depF} ${famF} ${fouF}
      ORDER BY ISNULL(ca90.ca_90j,0) DESC, ad.ARDSTOCKREEL ASC
    `);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Valorisation stock courant ─────────────────────────────────────────────────
router.get('/valeur', async (req, res) => {
  const depid    = req.query.depid    ? parseInt(req.query.depid)    : null;
  const famille  = req.query.famille  ? parseInt(req.query.famille)  : null;
  const fouid    = req.query.fouid    ? parseInt(req.query.fouid)    : null;
  const groupBy  = req.query.group    || 'famille'; // 'famille' | 'article' | 'fournisseur'
  const limit    = Math.min(parseInt(req.query.limit) || 200, 1000);
  const depF     = depid   ? 'AND ad.DEPID=@depid'    : '';
  const famF     = famille ? 'AND a.AFMID=@famille'   : '';
  const fouF     = fouid   ? "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)" : '';

  try {
    const pool = await getUserPool(req.user);
    const r = pool.request();
    r.input('limit', sql.Int, limit);
    if (depid)   r.input('depid',   sql.Int, depid);
    if (famille) r.input('famille', sql.Int, famille);
    if (fouid)   r.input('fouid',   sql.Int, fouid);

    let query;
    if (groupBy === 'article') {
      query = `
        SELECT TOP (@limit)
          a.ARTID,
          RTRIM(a.ARTCODE)        AS ref,
          RTRIM(a.ARTDESIGNATION) AS designation,
          ISNULL(RTRIM(af.AFMINTITULE),'Sans famille') AS famille,
          SUM(ad.ARDSTOCKREEL)    AS stock_reel,
          AVG(ISNULL(a.ARTCRUMP,0)) AS pr_crump,
          AVG(ISNULL(a.ARTPRMP,0))  AS pr_prmp,
          AVG(ISNULL(a.ARTPMP,0))   AS pr_pmp,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTCRUMP,0)) AS val_crump,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTPRMP,0))  AS val_prmp,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTPMP,0))   AS val_pmp
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID = ad.ARTID
        LEFT JOIN ARTFAMILLES af ON af.AFMID = a.AFMID
        WHERE ad.ARDSTOCKREEL > 0 ${depF} ${famF} ${fouF}
        GROUP BY a.ARTID, a.ARTCODE, a.ARTDESIGNATION, af.AFMINTITULE
        ORDER BY val_crump DESC
      `;
    } else if (groupBy === 'fournisseur') {
      query = `
        SELECT TOP (@limit)
          ISNULL(RTRIM(tf.TIRSOCIETE),'Sans fournisseur') AS fournisseur,
          t.TIRID AS fournisseur_id,
          COUNT(DISTINCT a.ARTID)                      AS nb_articles,
          SUM(ad.ARDSTOCKREEL)                         AS stock_reel,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTCRUMP,0)) AS val_crump,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTPRMP,0))  AS val_prmp,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTPMP,0))   AS val_pmp
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID = ad.ARTID
        LEFT JOIN ARTFAMILLES af ON af.AFMID = a.AFMID
        OUTER APPLY (SELECT TOP 1 p.TIRID FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.PROISPRINCIPAL='O' ORDER BY p.PROID) pro_fv
        LEFT JOIN TIERS tf ON tf.TIRID=pro_fv.TIRID AND tf.TIRTYPE='F'
        LEFT JOIN TIERS t  ON t.TIRID=tf.TIRID
        WHERE ad.ARDSTOCKREEL > 0 ${depF} ${famF}
        GROUP BY tf.TIRID, tf.TIRSOCIETE, t.TIRID
        ORDER BY val_crump DESC
      `;
    } else {
      query = `
        SELECT TOP (@limit)
          ISNULL(RTRIM(af.AFMINTITULE),'Sans famille') AS famille,
          af.AFMID AS famille_id,
          COUNT(DISTINCT a.ARTID)                      AS nb_articles,
          SUM(ad.ARDSTOCKREEL)                         AS stock_reel,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTCRUMP,0)) AS val_crump,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTPRMP,0))  AS val_prmp,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTPMP,0))   AS val_pmp
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID = ad.ARTID
        LEFT JOIN ARTFAMILLES af ON af.AFMID = a.AFMID
        WHERE ad.ARDSTOCKREEL > 0 ${depF} ${famF} ${fouF}
        GROUP BY af.AFMID, af.AFMINTITULE
        ORDER BY val_crump DESC
      `;
    }
    const result = await r.query(query);
    res.json({ rows: result.recordset, groupBy });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Mouvements de stock ───────────────────────────────────────────────────────
router.get('/mouvements', async (req, res) => {
  const depid   = req.query.depid   ? parseInt(req.query.depid)   : null;
  const artid   = req.query.artid   ? parseInt(req.query.artid)   : null;
  const famille = req.query.famille ? parseInt(req.query.famille) : null;
  const fouid   = req.query.fouid   ? parseInt(req.query.fouid)   : null;
  const nature  = req.query.nature  || '';  // R, C, V, etc.
  const limit   = Math.min(parseInt(req.query.limit) || 100, 1000);
  const debut   = req.query.debut   || isoDate(new Date(new Date().getFullYear(), 0, 1));
  const fin     = req.query.fin     || isoDate(new Date());

  try {
    const pool = await getUserPool(req.user);
    const r = pool.request();
    r.input('debut',  sql.VarChar(10), debut);
    r.input('fin',    sql.VarChar(10), fin);
    r.input('limit',  sql.Int, limit);
    if (depid)   r.input('depid',   sql.Int, depid);
    if (artid)   r.input('artid',   sql.Int, artid);
    if (famille) r.input('famille', sql.Int, famille);
    if (fouid)   r.input('fouid',   sql.Int, fouid);
    if (nature)  r.input('nature',  sql.VarChar(1), nature);

    const depF    = depid   ? 'AND o.DEPID=@depid'   : '';
    const artF    = artid   ? 'AND o.ARTID=@artid'   : '';
    const famF    = famille ? 'AND a.AFMID=@famille' : '';
    const fouF    = fouid   ? "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)" : '';
    const natF    = nature  ? 'AND o.OPENATURESTOCK=@nature' : '';

    const result = await r.query(`
      SELECT TOP (@limit)
        o.OPEID,
        CONVERT(VARCHAR(10), o.OPEDATE, 120) AS date_op,
        RTRIM(a.ARTCODE)        AS ref,
        RTRIM(a.ARTDESIGNATION) AS designation,
        ISNULL(RTRIM(af.AFMINTITULE),'')  AS famille,
        d.DEPINTITULE           AS depot,
        o.OPENATURESTOCK        AS nature,
        st.STKTYPE              AS nature_lib,
        o.OPEQUANTITE           AS qte,
        o.OPESENS               AS sens,
        o.OPESTOCKAVANT         AS stock_avant,
        o.OPESTOCKAVANT + o.OPEQUANTITE AS stock_apres,
        ISNULL(o.OPECRUMP, 0)   AS pr_crump,
        ISNULL(o.OPEPRMP,  0)   AS pr_prmp,
        ISNULL(o.OPEPMP,   0)   AS pr_pmp,
        ISNULL(o.OPEINTITULE,'') AS intitule
      FROM OPERATIONSTOCK o
      JOIN ARTICLES a     ON a.ARTID  = o.ARTID
      JOIN DEPOTS d       ON d.DEPID  = o.DEPID
      LEFT JOIN ARTFAMILLES af ON af.AFMID = a.AFMID
      LEFT JOIN STOCK_TYPE st  ON st.STKCODE = o.OPENATURESTOCK
      WHERE o.OPEDATE >= @debut AND o.OPEDATE <= @fin
        ${depF} ${artF} ${famF} ${fouF} ${natF}
      ORDER BY o.OPEID DESC
    `);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stock reconstitué à une date ──────────────────────────────────────────────
router.get('/a-date', async (req, res) => {
  const date    = req.query.date    || isoDate(new Date());
  const depid   = req.query.depid   ? parseInt(req.query.depid)   : null;
  const famille = req.query.famille ? parseInt(req.query.famille) : null;
  const fouid   = req.query.fouid   ? parseInt(req.query.fouid)   : null;
  const group   = req.query.group   || 'article'; // 'article' | 'famille'
  const limit   = Math.min(parseInt(req.query.limit) || 200, 1000);

  const depF  = depid   ? 'AND o.DEPID=@depid'    : '';
  const famF  = famille ? 'AND a.AFMID=@famille'  : '';
  const fouF  = fouid   ? "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)" : '';

  try {
    const pool = await getUserPool(req.user);
    const r = pool.request();
    r.input('date',  sql.VarChar(10), date);
    r.input('limit', sql.Int, limit);
    if (depid)   r.input('depid',   sql.Int, depid);
    if (famille) r.input('famille', sql.Int, famille);
    if (fouid)   r.input('fouid',   sql.Int, fouid);

    // Reconstituer le stock à la date : dernière opération REEL <= date par article+dépôt
    const result = await r.query(`
      SELECT TOP (@limit)
        a.ARTID,
        RTRIM(a.ARTCODE)        AS ref,
        RTRIM(a.ARTDESIGNATION) AS designation,
        ISNULL(RTRIM(af.AFMINTITULE),'Sans famille') AS famille,
        d.DEPINTITULE           AS depot,
        (o.OPESTOCKAVANT + o.OPEQUANTITE) AS stock_qte,
        o.OPECRUMP              AS pr_crump,
        o.OPEPRMP               AS pr_prmp,
        (o.OPESTOCKAVANT + o.OPEQUANTITE) * ISNULL(o.OPECRUMP,0) AS val_crump,
        (o.OPESTOCKAVANT + o.OPEQUANTITE) * ISNULL(o.OPEPRMP,0)  AS val_prmp
      FROM OPERATIONSTOCK o
      JOIN (
        SELECT ARTID, DEPID, MAX(OPEID) AS last_id
        FROM OPERATIONSTOCK
        WHERE OPENATURESTOCK='R' AND OPEDATE <= @date
        GROUP BY ARTID, DEPID
      ) sub ON sub.ARTID=o.ARTID AND sub.DEPID=o.DEPID AND sub.last_id=o.OPEID
      JOIN ARTICLES a  ON a.ARTID  = o.ARTID
      JOIN DEPOTS d    ON d.DEPID  = o.DEPID
      LEFT JOIN ARTFAMILLES af ON af.AFMID = a.AFMID
      WHERE o.OPENATURESTOCK='R'
        AND (o.OPESTOCKAVANT + o.OPEQUANTITE) > 0
        ${depF} ${famF} ${fouF}
      ORDER BY val_crump DESC
    `);

    // Totaux
    const rows    = result.recordset;
    const totCrump = rows.reduce((s, r) => s + (parseFloat(r.val_crump)||0), 0);
    const totPrmp  = rows.reduce((s, r) => s + (parseFloat(r.val_prmp)||0),  0);
    const totQte   = rows.reduce((s, r) => s + (parseFloat(r.stock_qte)||0), 0);

    res.json({ date, rows, totaux: { val_crump: totCrump, val_prmp: totPrmp, total_qte: totQte } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Évolution mensuelle de la valeur du stock ─────────────────────────────────
router.get('/evolution', async (req, res) => {
  const depid  = req.query.depid ? parseInt(req.query.depid) : null;
  const moisN  = parseInt(req.query.mois) || 13; // nb de mois
  const depF   = depid ? 'AND o.DEPID=@depid' : '';

  try {
    const pool = await getUserPool(req.user);
    const r = pool.request();
    if (depid) r.input('depid', sql.Int, depid);

    // Valeur du stock (CRUMP) à la fin de chaque mois des N derniers mois
    // = dernière opération de chaque article dans ce mois, stock après × prix
    const result = await r.query(`
      SELECT
        FORMAT(o.OPEDATE,'yyyy-MM') AS mois,
        SUM((o.OPESTOCKAVANT + o.OPEQUANTITE) * ISNULL(o.OPECRUMP,0)) AS val_crump,
        SUM((o.OPESTOCKAVANT + o.OPEQUANTITE) * ISNULL(o.OPEPRMP,0))  AS val_prmp
      FROM OPERATIONSTOCK o
      JOIN (
        SELECT ARTID, DEPID, FORMAT(OPEDATE,'yyyy-MM') AS mois, MAX(OPEID) AS last_id
        FROM OPERATIONSTOCK
        WHERE OPENATURESTOCK='R'
          AND OPEDATE >= DATEADD(MONTH, -${moisN}, GETDATE())
        GROUP BY ARTID, DEPID, FORMAT(OPEDATE,'yyyy-MM')
      ) sub ON sub.ARTID=o.ARTID AND sub.DEPID=o.DEPID AND sub.last_id=o.OPEID
            AND FORMAT(o.OPEDATE,'yyyy-MM')=sub.mois
      WHERE o.OPENATURESTOCK='R' AND o.OPESTOCKAVANT+o.OPEQUANTITE>0
        ${depF}
      GROUP BY FORMAT(o.OPEDATE,'yyyy-MM')
      ORDER BY mois
    `);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec } = require('child_process');
const nodemailer = require('nodemailer');
const cron     = require('node-cron');
const ExcelJS  = require('exceljs');
const { getPool, getUserPool, getConnPool, loadConnections, getDbsSocietes, sql } = require('../../config/database');
const _resolvePool = (p) => getUserPool({ database: p?._userDatabase, connId: p?._userConnId });

const REPORTS_FILE   = path.join(__dirname, '../../data/reports.json');
const CSOURCES_FILE  = path.join(__dirname, '../../data/custom-sources.json');
const CUSTOMDIM_FILE = path.join(__dirname, '../../data/custom-dimensions.json');
const activeJobs    = new Map();

function readCSources() {
  try { return JSON.parse(fs.readFileSync(CSOURCES_FILE, 'utf8')); } catch { return []; }
}
function writeCSources(data) {
  fs.mkdirSync(path.dirname(CSOURCES_FILE), { recursive: true });
  fs.writeFileSync(CSOURCES_FILE, JSON.stringify(data, null, 2));
}

// ── Storage ───────────────────────────────────────────────────────────────────

function readReports() {
  try { return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8')); } catch { return []; }
}
function writeReports(reports) {
  fs.mkdirSync(path.dirname(REPORTS_FILE), { recursive: true });
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Split sur les virgules de niveau 0 uniquement — préserve les parens internes.
// Indispensable pour les groupBy contenant des fonctions à plusieurs args, ex :
// FORMAT(pv.PCVDATEEFFET,'yyyy-MM')  → 1 seule partie (et non 2 cassées).
function splitTopLevelCommas(s) {
  if (!s) return [];
  const parts = [];
  let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(last, i)); last = i + 1; }
  }
  parts.push(s.slice(last));
  return parts.map(p => p.trim()).filter(Boolean);
}

// ── Param resolver ─────────────────────────────────────────────────────────────

function rp(val) {
  if (typeof val !== 'string') return val;
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  return val
    .replace('{{year}}',       String(y))
    .replace('{{month}}',      String(m))
    .replace('{{prev_year}}',  String(y - 1))
    .replace('{{prev_month}}', String(m === 1 ? 12 : m - 1));
}

// ── Data sources ───────────────────────────────────────────────────────────────

const SOURCES = {
  kpis_commerciaux: {
    label: 'KPIs commerciaux',
    displayType: 'kpi',
    paramDefs: [
      { key: 'annee', label: 'Année',  placeholder: '{{year}}' },
      { key: 'mois',  label: 'Mois (vide = année entière)', placeholder: '{{month}}' },
      { key: 'repid', label: 'ID commercial (vide = tous)', placeholder: '' }
    ],
    async fetch(p) {
      const annee  = parseInt(rp(p.annee)) || new Date().getFullYear();
      const anneen1 = annee - 1;
      const moisList = p.mois ? String(p.mois).split(',').map(s=>parseInt(s.trim())).filter(n=>n>=1&&n<=12) : [];
      const repid  = p.repid ? parseInt(rp(p.repid)) : null;
      const pool = await _resolvePool(p); const r = pool.request();
      r.input('annee',   sql.Int, annee);
      r.input('anneen1', sql.Int, anneen1);
      if (repid) r.input('repid', sql.Int, repid);
      const mF = moisList.length ? `AND MONTH(pv.PCVDATEEFFET) IN (${moisList.join(',')})` : '';
      const rF = repid ? 'AND pv.TIRID_REP=@repid' : '';
      const res = await r.query(`
        SELECT
          SUM(CASE WHEN YEAR(pv.PCVDATEEFFET)=@annee   ${mF} THEN ABS(pv.PCVMNTHT)*pn.PINSENSSTATISTIQUE ELSE 0 END) AS ca,
          SUM(CASE WHEN YEAR(pv.PCVDATEEFFET)=@anneen1 ${mF} THEN ABS(pv.PCVMNTHT)*pn.PINSENSSTATISTIQUE ELSE 0 END) AS ca_n1,
          COUNT(CASE WHEN YEAR(pv.PCVDATEEFFET)=@annee ${mF} AND pn.PINSENSSTATISTIQUE=1 THEN 1 END) AS nb_factures,
          COUNT(DISTINCT CASE WHEN YEAR(pv.PCVDATEEFFET)=@annee ${mF} AND pn.PINSENSSTATISTIQUE=1 THEN pv.TIRID END) AS nb_clients
        FROM PIECEVENTES pv JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 ${rF}
      `);
      const d = res.recordset[0];
      const evol = d.ca_n1 > 0 ? ((d.ca - d.ca_n1) / d.ca_n1 * 100) : null;
      return [
        { label: `CA HT ${annee}`,             valeur: d.ca,          format: 'euro' },
        { label: `Évolution vs ${anneen1}`,     valeur: evol,          format: 'percent' },
        { label: 'Nb factures',                 valeur: d.nb_factures, format: 'integer' },
        { label: 'Clients actifs',              valeur: d.nb_clients,  format: 'integer' },
        { label: 'Ticket moyen',                valeur: d.nb_factures > 0 ? d.ca / d.nb_factures : 0, format: 'euro' },
      ];
    }
  },
  top_clients: {
    label: 'Top clients (CA HT)',
    displayType: 'table',
    paramDefs: [
      { key: 'annee', label: 'Année',  placeholder: '{{year}}' },
      { key: 'mois',  label: 'Mois',   placeholder: '' },
      { key: 'repid', label: 'ID commercial', placeholder: '' },
      { key: 'limit', label: 'Nb lignes', placeholder: '10' }
    ],
    async fetch(p) {
      const annee = parseInt(rp(p.annee)) || new Date().getFullYear();
      const moisList = p.mois ? String(p.mois).split(',').map(s=>parseInt(s.trim())).filter(n=>n>=1&&n<=12) : [];
      const repid = p.repid ? parseInt(rp(p.repid)) : null;
      const limit = Math.min(parseInt(p.limit) || 10, 50);
      const pool = await _resolvePool(p); const r = pool.request();
      r.input('annee', sql.Int, annee);
      if (repid) r.input('repid', sql.Int, repid);
      const mF = moisList.length ? `AND MONTH(pv.PCVDATEEFFET) IN (${moisList.join(',')})` : '';
      const rF = repid ? 'AND pv.TIRID_REP=@repid' : '';
      const res = await r.query(`
        SELECT TOP ${limit} RTRIM(t.TIRSOCIETE) AS label, SUM(ABS(pv.PCVMNTHT)*pn.PINSENSSTATISTIQUE) AS valeur
        FROM PIECEVENTES pv JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID JOIN TIERS t ON t.TIRID=pv.TIRID
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND YEAR(pv.PCVDATEEFFET)=@annee ${mF} ${rF}
        GROUP BY t.TIRID, t.TIRSOCIETE ORDER BY valeur DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'euro' }));
    }
  },
  par_commercial: {
    label: 'CA par commercial',
    displayType: 'table',
    paramDefs: [
      { key: 'annee', label: 'Année', placeholder: '{{year}}' },
      { key: 'mois',  label: 'Mois',  placeholder: '' }
    ],
    async fetch(p) {
      const annee = parseInt(rp(p.annee)) || new Date().getFullYear();
      const moisList = p.mois ? String(p.mois).split(',').map(s=>parseInt(s.trim())).filter(n=>n>=1&&n<=12) : [];
      const pool = await _resolvePool(p); const r = pool.request();
      r.input('annee', sql.Int, annee);
      const mF = moisList.length ? `AND MONTH(pv.PCVDATEEFFET) IN (${moisList.join(',')})` : '';
      const res = await r.query(`
        SELECT ISNULL(RTRIM(t.TIRSOCIETE),'Non assigné') AS label, SUM(ABS(pv.PCVMNTHT)*pn.PINSENSSTATISTIQUE) AS valeur
        FROM PIECEVENTES pv JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID
        LEFT JOIN TIERS t ON t.TIRID=pv.TIRID_REP AND t.TIRTYPE='R'
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND YEAR(pv.PCVDATEEFFET)=@annee ${mF}
        GROUP BY t.TIRID, t.TIRSOCIETE ORDER BY valeur DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'euro' }));
    }
  },
  top_familles: {
    label: 'Top familles articles (CA HT)',
    displayType: 'table',
    paramDefs: [
      { key: 'annee', label: 'Année',  placeholder: '{{year}}' },
      { key: 'mois',  label: 'Mois',   placeholder: '' },
      { key: 'repid', label: 'ID commercial', placeholder: '' },
      { key: 'limit', label: 'Nb lignes', placeholder: '10' }
    ],
    async fetch(p) {
      const annee = parseInt(rp(p.annee)) || new Date().getFullYear();
      const moisList = p.mois ? String(p.mois).split(',').map(s=>parseInt(s.trim())).filter(n=>n>=1&&n<=12) : [];
      const repid = p.repid ? parseInt(rp(p.repid)) : null;
      const limit = Math.min(parseInt(p.limit) || 10, 50);
      const pool = await _resolvePool(p); const r = pool.request();
      r.input('annee', sql.Int, annee);
      if (repid) r.input('repid', sql.Int, repid);
      const mF = moisList.length ? `AND MONTH(pv.PCVDATEEFFET) IN (${moisList.join(',')})` : '';
      const rF = repid ? 'AND pv.TIRID_REP=@repid' : '';
      const res = await r.query(`
        SELECT TOP ${limit} ISNULL(RTRIM(af.AFMINTITULE),'Sans famille') AS label, SUM(ABS(pl.PLVMNTNETHT)*pn.PINSENSSTATISTIQUE) AS valeur
        FROM PIECEVENTELIGNES pl JOIN PIECEVENTES pv ON pv.PCVID=pl.PCVID JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID
        LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID LEFT JOIN ARTFAMILLES af ON af.AFMID=a.AFMID
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND pl.ARTID IS NOT NULL
          AND YEAR(pv.PCVDATEEFFET)=@annee ${mF} ${rF}
        GROUP BY af.AFMID, af.AFMINTITULE ORDER BY valeur DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'euro' }));
    }
  },
  segmentation_clients: {
    label: 'Segmentation clients',
    displayType: 'table',
    paramDefs: [
      { key: 'annee', label: 'Année',  placeholder: '{{year}}' },
      { key: 'mois',  label: 'Mois',   placeholder: '' },
      { key: 'repid', label: 'ID commercial', placeholder: '' },
      { key: 'dim',   label: 'Dimension', placeholder: 'TIRCATEGORIE', hint: 'TIRCATEGORIE | TIRACTIVITE | TIRGEO | TIRBRANCHE | TIRENSEIGNE | TIRORIGINE | TIRCIBLE1 | TIRCIBLE2' }
    ],
    async fetch(p) {
      const VALID = new Set(['TIRCATEGORIE','TIRACTIVITE','TIRGEO','TIRBRANCHE','TIRENSEIGNE','TIRORIGINE','TIRCIBLE1','TIRCIBLE2']);
      const dim = VALID.has(p.dim) ? p.dim : 'TIRCATEGORIE';
      const annee = parseInt(rp(p.annee)) || new Date().getFullYear();
      const moisList = p.mois ? String(p.mois).split(',').map(s=>parseInt(s.trim())).filter(n=>n>=1&&n<=12) : [];
      const repid = p.repid ? parseInt(rp(p.repid)) : null;
      const pool = await _resolvePool(p); const r = pool.request();
      r.input('annee', sql.Int, annee);
      if (repid) r.input('repid', sql.Int, repid);
      const mF = moisList.length ? `AND MONTH(pv.PCVDATEEFFET) IN (${moisList.join(',')})` : '';
      const rF = repid ? 'AND pv.TIRID_REP=@repid' : '';
      const res = await r.query(`
        SELECT ISNULL(RTRIM(t.${dim}),'Non défini') AS label, SUM(ABS(pv.PCVMNTHT)*pn.PINSENSSTATISTIQUE) AS valeur
        FROM PIECEVENTES pv JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID JOIN TIERS t ON t.TIRID=pv.TIRID
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND t.TIRTYPE='C'
          AND YEAR(pv.PCVDATEEFFET)=@annee ${mF} ${rF}
        GROUP BY t.${dim} ORDER BY valeur DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'euro' }));
    }
  },
  segmentation_articles: {
    label: 'Segmentation articles',
    displayType: 'table',
    paramDefs: [
      { key: 'annee', label: 'Année',  placeholder: '{{year}}' },
      { key: 'mois',  label: 'Mois',   placeholder: '' },
      { key: 'repid', label: 'ID commercial', placeholder: '' },
      { key: 'dim',   label: 'Dimension', placeholder: 'ARTFAMILLE', hint: 'ARTFAMILLE | ARTSOUSFAMILLE | ARTCATEGORIE | ARTNATURE | ARTCOLLECTION | ARTMARQUE | ARTCLASSE' }
    ],
    async fetch(p) {
      const VALID = new Set(['ARTFAMILLE','ARTSOUSFAMILLE','ARTCATEGORIE','ARTNATURE','ARTCOLLECTION','ARTMARQUE','ARTCLASSE']);
      const dim = VALID.has(p.dim) ? p.dim : 'ARTFAMILLE';
      const annee = parseInt(rp(p.annee)) || new Date().getFullYear();
      const moisList = p.mois ? String(p.mois).split(',').map(s=>parseInt(s.trim())).filter(n=>n>=1&&n<=12) : [];
      const repid = p.repid ? parseInt(rp(p.repid)) : null;
      const pool = await _resolvePool(p); const r = pool.request();
      r.input('annee', sql.Int, annee);
      if (repid) r.input('repid', sql.Int, repid);
      const mF = moisList.length ? `AND MONTH(pv.PCVDATEEFFET) IN (${moisList.join(',')})` : '';
      const rF = repid ? 'AND pv.TIRID_REP=@repid' : '';
      const lExpr = dim === 'ARTFAMILLE' ? `ISNULL(RTRIM(af.AFMINTITULE),'Sans famille')` : `ISNULL(RTRIM(a.${dim}),'Non défini')`;
      const jFam  = dim === 'ARTFAMILLE' ? `LEFT JOIN ARTFAMILLES af ON af.AFMID=a.AFMID` : '';
      const gBy   = dim === 'ARTFAMILLE' ? 'af.AFMID, af.AFMINTITULE' : `a.${dim}`;
      const res = await r.query(`
        SELECT ${lExpr} AS label, SUM(ABS(pl.PLVMNTNETHT)*pn.PINSENSSTATISTIQUE) AS valeur
        FROM PIECEVENTELIGNES pl JOIN PIECEVENTES pv ON pv.PCVID=pl.PCVID JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID
        LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID ${jFam}
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND pl.ARTID IS NOT NULL
          AND YEAR(pv.PCVDATEEFFET)=@annee ${mF} ${rF}
        GROUP BY ${gBy} ORDER BY valeur DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'euro' }));
    }
  },
  comp_annuel: {
    label: 'Comparatif CA — N années',
    displayType: 'pivot',
    paramDefs: [
      { key: 'annee_fin', label: 'Dernière année',              placeholder: '{{year}}' },
      { key: 'nb',        label: 'Nb années (2-5)',             placeholder: '3' },
      { key: 'mois',      label: 'Mois (vide = total annuel)',  placeholder: '' },
      { key: 'repid',     label: 'ID commercial',               placeholder: '' }
    ],
    async fetch(p) {
      const fin   = parseInt(rp(p.annee_fin)) || new Date().getFullYear();
      const nb    = Math.min(Math.max(parseInt(p.nb)||3, 2), 5);
      const moisList = p.mois ? String(p.mois).split(',').map(s=>parseInt(s.trim())).filter(n=>n>=1&&n<=12) : [];
      const repid = p.repid ? parseInt(rp(p.repid)) : null;
      const annees = Array.from({length:nb}, (_,i) => fin - nb + 1 + i);
      const pool = await _resolvePool(p); const req = pool.request();
      if (repid) req.input('repid', sql.Int, repid);
      const mF = moisList.length ? `AND MONTH(pv.PCVDATEEFFET) IN (${moisList.join(',')})` : '';
      const rF = repid ? 'AND pv.TIRID_REP=@repid' : '';
      const MOIS_NOMS = ['Jan','Fev','Mar','Avr','Mai','Jun','Jul','Aou','Sep','Oct','Nov','Dec'];
      const res = await req.query(`
        SELECT MONTH(pv.PCVDATEEFFET) AS m, ${annees.map(y =>
          `SUM(CASE WHEN YEAR(pv.PCVDATEEFFET)=${y} THEN ABS(pv.PCVMNTHT)*pn.PINSENSSTATISTIQUE ELSE 0 END) AS y${y}`
        ).join(',')}
        FROM PIECEVENTES pv JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0
          AND YEAR(pv.PCVDATEEFFET) BETWEEN ${annees[0]} AND ${annees[annees.length-1]} ${mF} ${rF}
        GROUP BY MONTH(pv.PCVDATEEFFET) ORDER BY m
      `);
      if (mois && res.recordset.length <= 1) {
        // Résultat mono-ligne (mois précis) → 1 ligne par année
        const row = res.recordset[0] || {};
        return { type:'pivot', columns: annees.map(String),
          rows:[{ label: mois ? MOIS_NOMS[mois-1] : 'CA HT',
            values: Object.fromEntries(annees.map(y => [String(y), row[`y${y}`]||0])) }] };
      }
      const rows = res.recordset.map(row => ({
        label: MOIS_NOMS[(row.m||1)-1],
        values: Object.fromEntries(annees.map(y => [String(y), row[`y${y}`]||0]))
      }));
      return { type:'pivot', columns: annees.map(String), rows };
    }
  },
  comp_mensuel: {
    label: 'Comparatif mensuel N vs N-1',
    displayType: 'pivot',
    paramDefs: [
      { key: 'annee', label: 'Année de référence', placeholder: '{{year}}' },
      { key: 'repid', label: 'ID commercial',      placeholder: '' }
    ],
    async fetch(p) {
      const annee  = parseInt(rp(p.annee)) || new Date().getFullYear();
      const anneen1 = annee - 1;
      const repid  = p.repid ? parseInt(rp(p.repid)) : null;
      const pool = await _resolvePool(p); const req = pool.request();
      req.input('annee', sql.Int, annee); req.input('n1', sql.Int, anneen1);
      if (repid) req.input('repid', sql.Int, repid);
      const rF = repid ? 'AND pv.TIRID_REP=@repid' : '';
      const MOIS_NOMS = ['Janvier','Fevrier','Mars','Avril','Mai','Juin','Juillet','Aout','Septembre','Octobre','Novembre','Decembre'];
      const res = await req.query(`
        SELECT MONTH(pv.PCVDATEEFFET) AS m,
          SUM(CASE WHEN YEAR(pv.PCVDATEEFFET)=@annee THEN ABS(pv.PCVMNTHT)*pn.PINSENSSTATISTIQUE ELSE 0 END) AS n,
          SUM(CASE WHEN YEAR(pv.PCVDATEEFFET)=@n1    THEN ABS(pv.PCVMNTHT)*pn.PINSENSSTATISTIQUE ELSE 0 END) AS n1
        FROM PIECEVENTES pv JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0
          AND YEAR(pv.PCVDATEEFFET) IN (@annee,@n1) ${rF}
        GROUP BY MONTH(pv.PCVDATEEFFET) ORDER BY m
      `);
      const byM = {}; res.recordset.forEach(r => { byM[r.m] = r; });
      const rows = Array.from({length:12},(_,i)=>({
        label: MOIS_NOMS[i],
        values: { [String(anneen1)]: byM[i+1]?.n1||0, [String(annee)]: byM[i+1]?.n||0 }
      }));
      return { type:'pivot', columns:[String(anneen1), String(annee)], rows };
    }
  },
  comp_journalier: {
    label: 'Comparatif journalier — mois en cours vs M-1',
    displayType: 'pivot',
    paramDefs: [
      { key: 'annee', label: 'Année',  placeholder: '{{year}}' },
      { key: 'mois',  label: 'Mois',   placeholder: '{{month}}' },
      { key: 'repid', label: 'ID commercial', placeholder: '' }
    ],
    async fetch(p) {
      const annee = parseInt(rp(p.annee)) || new Date().getFullYear();
      const mois  = parseInt(rp(p.mois))  || new Date().getMonth()+1;
      const moisP = mois===1?12:mois-1, anneeP = mois===1?annee-1:annee;
      const repid = p.repid ? parseInt(rp(p.repid)) : null;
      const pool = await _resolvePool(p); const req = pool.request();
      req.input('annee',  sql.Int, annee);  req.input('mois',   sql.Int, mois);
      req.input('anneeP', sql.Int, anneeP); req.input('moisP',  sql.Int, moisP);
      if (repid) req.input('repid', sql.Int, repid);
      const rF = repid ? 'AND pv.TIRID_REP=@repid' : '';
      const MOIS_C=['Jan','Fev','Mar','Avr','Mai','Jun','Jul','Aou','Sep','Oct','Nov','Dec'];
      const colC=`${MOIS_C[mois-1]} ${annee}`, colP=`${MOIS_C[moisP-1]} ${anneeP}`;
      const res = await req.query(`
        SELECT DAY(pv.PCVDATEEFFET) AS j, YEAR(pv.PCVDATEEFFET) AS a, MONTH(pv.PCVDATEEFFET) AS m,
               SUM(ABS(pv.PCVMNTHT)*pn.PINSENSSTATISTIQUE) AS ca
        FROM PIECEVENTES pv JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID
        WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 ${rF}
          AND ((YEAR(pv.PCVDATEEFFET)=@annee AND MONTH(pv.PCVDATEEFFET)=@mois) OR
               (YEAR(pv.PCVDATEEFFET)=@anneeP AND MONTH(pv.PCVDATEEFFET)=@moisP))
        GROUP BY DAY(pv.PCVDATEEFFET),YEAR(pv.PCVDATEEFFET),MONTH(pv.PCVDATEEFFET) ORDER BY j
      `);
      const curr={}, prev={};
      res.recordset.forEach(r=>{
        if(r.a===annee&&r.m===mois) curr[r.j]=r.ca; else prev[r.j]=r.ca;
      });
      const rows=Array.from({length:31},(_,i)=>{
        const j=i+1, c=curr[j]||0, pr=prev[j]||0;
        if(!c&&!pr) return null;
        return {label:`Jour ${String(j).padStart(2,'0')}`, values:{[colP]:pr,[colC]:c}};
      }).filter(Boolean);
      return { type:'pivot', columns:[colP,colC], rows };
    }
  },
  stock_kpis: {
    label: 'Stock — KPIs globaux',
    displayType: 'kpi',
    paramDefs: [
      { key: 'depid', label: 'Dépôt', type: 'depot', placeholder: '' },
      { key: 'fouid', label: 'Fournisseur', type: 'fournisseur', placeholder: '' }
    ],
    async fetch(p) {
      const depid = p.depid ? parseInt(p.depid) : null;
      const fouid = p.fouid ? parseInt(p.fouid) : null;
      const pool = await _resolvePool(p); const r = pool.request();
      const dF = depid ? (r.input('depid', sql.Int, depid), 'AND ad.DEPID=@depid') : '';
      const fF = fouid ? (r.input('fouid', sql.Int, fouid), "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)") : '';
      const res = await r.query(`
        SELECT
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTCRUMP,0))  AS val_crump,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTPRMP,0))   AS val_prmp,
          SUM(ad.ARDSTOCKREEL * ISNULL(a.ARTPMP,0))    AS val_pmp,
          COUNT(CASE WHEN ad.ARDSTOCKREEL <= 0 AND ISNULL(ad.ARDSEUILMIN,0) > 0 THEN 1 END) AS nb_ruptures,
          COUNT(CASE WHEN ad.ARDSTOCKREEL > 0 AND ad.ARDSTOCKREEL < ISNULL(ad.ARDSEUILMIN,0) THEN 1 END) AS nb_sous_seuil,
          COUNT(CASE WHEN ad.ARDSTOCKREEL > 0 THEN 1 END) AS nb_en_stock,
          COUNT(*) AS nb_articles
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID=ad.ARTID
        WHERE 1=1 ${dF} ${fF}
      `);
      const d = res.recordset[0];
      return [
        { label: 'Valeur stock (CRUMP)', valeur: d.val_crump, format: 'euro' },
        { label: 'Valeur stock (PRMP)',  valeur: d.val_prmp,  format: 'euro' },
        { label: 'Valeur stock (PMP)',   valeur: d.val_pmp,   format: 'euro' },
        { label: 'Ruptures',             valeur: d.nb_ruptures,  format: 'integer' },
        { label: 'Sous seuil min',       valeur: d.nb_sous_seuil, format: 'integer' },
        { label: 'En stock',             valeur: d.nb_en_stock,  format: 'integer' },
        { label: 'Articles gérés',       valeur: d.nb_articles,  format: 'integer' },
      ];
    }
  },
  stock_ruptures: {
    label: 'Stock — Ruptures',
    displayType: 'table',
    paramDefs: [
      { key: 'depid', label: 'Dépôt', type: 'depot', placeholder: '' },
      { key: 'fouid', label: 'Fournisseur', type: 'fournisseur', placeholder: '' },
      { key: 'limit', label: 'Nb lignes', placeholder: '20' }
    ],
    async fetch(p) {
      const depid = p.depid ? parseInt(p.depid) : null;
      const fouid = p.fouid ? parseInt(p.fouid) : null;
      const limit = Math.min(parseInt(p.limit) || 20, 100);
      const pool = await _resolvePool(p); const r = pool.request();
      const dF = depid ? (r.input('depid', sql.Int, depid), 'AND ad.DEPID=@depid') : '';
      const fF = fouid ? (r.input('fouid', sql.Int, fouid), "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)") : '';
      const res = await r.query(`
        SELECT TOP ${limit}
          RTRIM(a.ARTCODE) AS label,
          ad.ARDSTOCKREEL  AS valeur,
          ISNULL(ad.ARDSEUILMIN,0) AS seuil_min,
          ISNULL(a.ARTPCB,0) AS artpcb,
          CASE WHEN ISNULL(a.ARTPCB,0)>0 THEN CAST(ad.ARDSTOCKREEL*1.0/a.ARTPCB AS INT) ELSE 0 END AS nb_cartons
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID=ad.ARTID
        WHERE ad.ARDSTOCKREEL <= 0 AND ISNULL(ad.ARDSEUILMIN,0) > 0 ${dF} ${fF}
        ORDER BY ad.ARDSTOCKREEL ASC, seuil_min DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'qty', extra: { seuil_min: row.seuil_min, artpcb: row.artpcb, nb_cartons: row.nb_cartons } }));
    }
  },
  stock_par_famille: {
    label: 'Stock — Valorisation par famille',
    displayType: 'table',
    paramDefs: [
      { key: 'depid', label: 'Dépôt', type: 'depot', placeholder: '' },
      { key: 'fouid', label: 'Fournisseur', type: 'fournisseur', placeholder: '' },
      { key: 'prix',  label: 'Base prix (crump/prmp/pmp)', placeholder: 'crump' }
    ],
    async fetch(p) {
      const depid = p.depid ? parseInt(p.depid) : null;
      const fouid = p.fouid ? parseInt(p.fouid) : null;
      const PRIX_MAP = { prmp: 'a.ARTPRMP', pmp: 'a.ARTPMP' };
      const prexpr = PRIX_MAP[p.prix] || 'a.ARTCRUMP';
      const pool = await _resolvePool(p); const r = pool.request();
      const dF = depid ? (r.input('depid', sql.Int, depid), 'AND ad.DEPID=@depid') : '';
      const fF = fouid ? (r.input('fouid', sql.Int, fouid), "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)") : '';
      const res = await r.query(`
        SELECT ISNULL(RTRIM(af.AFMINTITULE),'Sans famille') AS label,
               SUM(ad.ARDSTOCKREEL * ISNULL(${prexpr},0)) AS valeur,
               SUM(ad.ARDSTOCKREEL) AS qte,
               SUM(CASE WHEN ISNULL(a.ARTPCB,0)>0 THEN FLOOR(ad.ARDSTOCKREEL*1.0/a.ARTPCB) ELSE 0 END) AS nb_cartons
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID=ad.ARTID
        LEFT JOIN ARTFAMILLES af ON af.AFMID=a.AFMID
        WHERE ad.ARDSTOCKREEL > 0 ${dF} ${fF}
        GROUP BY af.AFMID, af.AFMINTITULE
        ORDER BY valeur DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'euro', extra: { qte: row.qte, nb_cartons: row.nb_cartons } }));
    }
  },
  stock_par_article: {
    label: 'Stock — Valorisation par article (Top)',
    displayType: 'table',
    paramDefs: [
      { key: 'depid',  label: 'Dépôt', type: 'depot', placeholder: '' },
      { key: 'fouid',  label: 'Fournisseur', type: 'fournisseur', placeholder: '' },
      { key: 'prix',   label: 'Base prix (crump/prmp/pmp)', placeholder: 'crump' },
      { key: 'limit',  label: 'Nb lignes', placeholder: '20' }
    ],
    async fetch(p) {
      const depid = p.depid ? parseInt(p.depid) : null;
      const fouid = p.fouid ? parseInt(p.fouid) : null;
      const limit = Math.min(parseInt(p.limit) || 20, 100);
      const PRIX_MAP = { prmp: 'a.ARTPRMP', pmp: 'a.ARTPMP' };
      const prexpr = PRIX_MAP[p.prix] || 'a.ARTCRUMP';
      const pool = await _resolvePool(p); const r = pool.request();
      const dF = depid ? (r.input('depid', sql.Int, depid), 'AND ad.DEPID=@depid') : '';
      const fF = fouid ? (r.input('fouid', sql.Int, fouid), "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)") : '';
      const res = await r.query(`
        SELECT TOP ${limit}
          RTRIM(a.ARTDESIGNATION) AS label,
          SUM(ad.ARDSTOCKREEL * ISNULL(${prexpr},0)) AS valeur,
          SUM(ad.ARDSTOCKREEL) AS qte,
          SUM(CASE WHEN ISNULL(a.ARTPCB,0)>0 THEN FLOOR(ad.ARDSTOCKREEL*1.0/a.ARTPCB) ELSE 0 END) AS nb_cartons
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID=ad.ARTID
        WHERE ad.ARDSTOCKREEL > 0 ${dF} ${fF}
        GROUP BY a.ARTID, a.ARTDESIGNATION, a.ARTPCB
        ORDER BY valeur DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'euro', extra: { qte: row.qte, nb_cartons: row.nb_cartons } }));
    }
  },
  stock_sous_seuil: {
    label: 'Stock — Sous seuil minimum',
    displayType: 'table',
    paramDefs: [
      { key: 'depid',  label: 'Dépôt', type: 'depot', placeholder: '' },
      { key: 'fouid',  label: 'Fournisseur', type: 'fournisseur', placeholder: '' },
      { key: 'limit',  label: 'Nb lignes', placeholder: '20' }
    ],
    async fetch(p) {
      const depid = p.depid ? parseInt(p.depid) : null;
      const fouid = p.fouid ? parseInt(p.fouid) : null;
      const limit = Math.min(parseInt(p.limit) || 20, 100);
      const pool = await _resolvePool(p); const r = pool.request();
      const dF = depid ? (r.input('depid', sql.Int, depid), 'AND ad.DEPID=@depid') : '';
      const fF = fouid ? (r.input('fouid', sql.Int, fouid), "AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.TIRID=@fouid)") : '';
      const res = await r.query(`
        SELECT TOP ${limit}
          RTRIM(a.ARTDESIGNATION) AS label,
          ad.ARDSTOCKREEL AS valeur,
          ad.ARDSEUILMIN  AS seuil_min,
          ad.ARDSEUILMAX  AS seuil_max,
          ISNULL(a.ARTPCB,0) AS artpcb,
          CASE WHEN ISNULL(a.ARTPCB,0)>0 THEN CAST(ad.ARDSTOCKREEL*1.0/a.ARTPCB AS INT) ELSE 0 END AS nb_cartons
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID=ad.ARTID
        WHERE ad.ARDSTOCKREEL > 0 AND ad.ARDSTOCKREEL < ISNULL(ad.ARDSEUILMIN,0)
          AND ISNULL(ad.ARDSEUILMIN,0) > 0 ${dF} ${fF}
        ORDER BY (ad.ARDSTOCKREEL - ad.ARDSEUILMIN) ASC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'qty', extra: { seuil_min: row.seuil_min, seuil_max: row.seuil_max, artpcb: row.artpcb, nb_cartons: row.nb_cartons } }));
    }
  },
  stock_par_fournisseur: {
    label: 'Stock — Valorisation par fournisseur',
    displayType: 'table',
    paramDefs: [
      { key: 'depid', label: 'Dépôt', type: 'depot', placeholder: '' },
      { key: 'prix',  label: 'Base prix (crump/prmp/pmp)', placeholder: 'crump' }
    ],
    async fetch(p) {
      const depid = p.depid ? parseInt(p.depid) : null;
      const PRIX_MAP = { prmp: 'a.ARTPRMP', pmp: 'a.ARTPMP' };
      const prexpr = PRIX_MAP[p.prix] || 'a.ARTCRUMP';
      const pool = await _resolvePool(p); const r = pool.request();
      const dF = depid ? (r.input('depid', sql.Int, depid), 'AND ad.DEPID=@depid') : '';
      const res = await r.query(`
        SELECT ISNULL(RTRIM(tf.TIRSOCIETE),'Sans fournisseur') AS label,
               SUM(ad.ARDSTOCKREEL * ISNULL(${prexpr},0)) AS valeur,
               SUM(ad.ARDSTOCKREEL) AS qte,
               SUM(CASE WHEN ISNULL(a.ARTPCB,0)>0 THEN FLOOR(ad.ARDSTOCKREEL*1.0/a.ARTPCB) ELSE 0 END) AS nb_cartons,
               COUNT(DISTINCT a.ARTID) AS nb_articles
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID=ad.ARTID
        OUTER APPLY (SELECT TOP 1 p.TIRID FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.PROISPRINCIPAL='O' ORDER BY p.PROID) pro_f
        LEFT JOIN TIERS tf ON tf.TIRID=pro_f.TIRID AND tf.TIRTYPE='F'
        WHERE ad.ARDSTOCKREEL > 0 ${dF}
        GROUP BY tf.TIRID, tf.TIRSOCIETE
        ORDER BY valeur DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'euro', extra: { qte: row.qte, nb_cartons: row.nb_cartons, nb_articles: row.nb_articles } }));
    }
  },
  stock_ruptures_fournisseur: {
    label: 'Stock — Ruptures par fournisseur',
    displayType: 'table',
    paramDefs: [
      { key: 'depid', label: 'Dépôt', type: 'depot', placeholder: '' },
      { key: 'limit', label: 'Nb lignes', placeholder: '20' }
    ],
    async fetch(p) {
      const depid = p.depid ? parseInt(p.depid) : null;
      const limit = Math.min(parseInt(p.limit) || 20, 100);
      const pool = await _resolvePool(p); const r = pool.request();
      const dF = depid ? (r.input('depid', sql.Int, depid), 'AND ad.DEPID=@depid') : '';
      const res = await r.query(`
        SELECT TOP ${limit}
          ISNULL(RTRIM(tf.TIRSOCIETE),'Sans fournisseur') AS label,
          COUNT(*) AS valeur
        FROM ARTDEPOT ad
        JOIN ARTICLES a ON a.ARTID=ad.ARTID
        OUTER APPLY (SELECT TOP 1 p.TIRID FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.PROISPRINCIPAL='O' ORDER BY p.PROID) pro_f
        LEFT JOIN TIERS tf ON tf.TIRID=pro_f.TIRID AND tf.TIRTYPE='F'
        WHERE ad.ARDSTOCKREEL <= 0 AND ISNULL(ad.ARDSEUILMIN,0) > 0 ${dF}
        GROUP BY tf.TIRID, tf.TIRSOCIETE
        ORDER BY valeur DESC
      `);
      return res.recordset.map(row => ({ label: row.label, valeur: row.valeur, format: 'integer' }));
    }
  },
  custom_sql: {
    label: 'Requête SQL personnalisée',
    displayType: 'table',
    paramDefs: [
      { key: 'sql', label: 'Requête SQL', type: 'textarea', placeholder: 'SELECT TOP 20 ...' }
    ],
    async fetch(p) {
      if (!p.sql) return [];
      const pool = await _resolvePool(p);
      const res  = await pool.request().query(p.sql);
      return res.recordset.map(row => {
        const keys = Object.keys(row);
        return { label: String(row[keys[0]] ?? ''), valeur: row[keys[1]], format: 'number' };
      });
    }
  }
};

// ── Dimensions registry ───────────────────────────────────────────────────────
// level:'header' → base PIECEVENTES  |  level:'line' → base PIECEVENTELIGNES
// joins: tableau de clauses JOIN déduplicables (même alias = une seule jointure)

// ── Custom dimensions storage ─────────────────────────────────────────────────
function readCustomDims() {
  try { return JSON.parse(fs.readFileSync(CUSTOMDIM_FILE,'utf8')); } catch { return []; }
}
function writeCustomDims(d) {
  fs.mkdirSync(path.dirname(CUSTOMDIM_FILE),{recursive:true});
  fs.writeFileSync(CUSTOMDIM_FILE, JSON.stringify(d,null,2));
}

// ── Tables joignables (définit les alias et JOINs disponibles) ────────────────
const JOINABLE_TABLES = {
  TIERS_CLIENT:  { label:'TIERS — Clients',               physTable:'TIERS',            alias:'tc',   level:'header', group:'Client',      dimFilter:"TIRTYPE='C'",
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  TIERS_REP:     { label:'TIERS — Commerciaux',           physTable:'TIERS',            alias:'tr',   level:'header', group:'Commercial',  dimFilter:"TIRTYPE='R'",
    joins:["LEFT JOIN TIERS tr ON tr.TIRID=pv.TIRID_REP AND tr.TIRTYPE='R'"] },
  TIERS_FOURN:   { label:'TIERS — Fournisseurs',          physTable:'TIERS',            alias:'tf',   level:'line',   group:'Fournisseur', dimFilter:"TIRTYPE='F'",
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID","OUTER APPLY (SELECT TOP 1 p.TIRID FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.PROISPRINCIPAL='O' ORDER BY p.PROID) pro_fpa","LEFT JOIN TIERS tf ON tf.TIRID=pro_fpa.TIRID AND tf.TIRTYPE='F'"] },
  PIECEVENTES:   { label:'PIECEVENTES — En-têtes',        physTable:'PIECEVENTES',      alias:'pv',   level:'header', group:'Document',  joins:[] },
  PIECE_NATURE:  { label:'PIECE_NATURE — Nature pièces',  physTable:'PIECE_NATURE',     alias:'pn',   level:'header', group:'Document',  joins:[] },
  PIECEVENTELIGNES:{ label:'PIECEVENTELIGNES — Lignes',   physTable:'PIECEVENTELIGNES', alias:'pl',   level:'line',   group:'Document',  joins:[] },
  ARTICLES:      { label:'ARTICLES',                      physTable:'ARTICLES',         alias:'a',    level:'line',   group:'Article',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  ARTFAMILLES:   { label:'ARTFAMILLES — Familles',        physTable:'ARTFAMILLES',      alias:'af',   level:'line',   group:'Article',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID","LEFT JOIN ARTFAMILLES af ON af.AFMID=a.AFMID"] },
  TIERS_FP:      { label:'TIERS_FP — Champs libres tiers', physTable:'TIERS_FP',       alias:'tfp',  level:'header', group:'Client',
    joins:["LEFT JOIN TIERS_FP tfp ON tfp.TIRID=pv.TIRID"] },
  ARTICLES_P:    { label:'ARTICLES_P — Champs libres article', physTable:'ARTICLES_P', alias:'ap',   level:'line',   group:'Article',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID","LEFT JOIN ARTICLES_P ap ON ap.ARTID=pl.ARTID"] },
  // ── Adresses ─────────────────────────────────────────────────────────────────
  ADRESSES:      { label:'ADRESSES — Livraison client',  physTable:'ADRESSES', alias:'adr_cli', level:'header', group:'Adresse',
    joins:["LEFT JOIN ADRESSES adr_cli ON adr_cli.TIRID=pv.TIRID AND adr_cli.ADRTYPE='L'"] },
  // ── Opérations de stock ──────────────────────────────────────────────────────
  OPERATIONSTOCK:{ label:'OPERATIONSTOCK — Mouvements',  physTable:'OPERATIONSTOCK', alias:'os_dim', level:'line', group:'Stock',
    joins:["LEFT JOIN OPERATIONSTOCK os_dim ON os_dim.ARTID=pl.ARTID AND os_dim.OPENATURESTOCK='R'"] },
  // ── Achats ───────────────────────────────────────────────────────────────────
  PIECEACHATS:       { label:'PIECEACHATS — En-têtes',        physTable:'PIECEACHATS',      alias:'pa',  level:'achats-header', group:'Achat',
    joins:[] },
  PIECEACHATLIGNES:  { label:'PIECEACHATLIGNES — Lignes',     physTable:'PIECEACHATLIGNES', alias:'pal', level:'achats-line',   group:'Achat',
    joins:[] },
  PIECE_NATURE_ACH:  { label:'PIECE_NATURE — Nature achats',  physTable:'PIECE_NATURE',     alias:'pan', level:'achats-header', group:'Achat',
    joins:[] },
  TIERS_FOURN_ACH:   { label:'TIERS — Fournisseurs (achat)',  physTable:'TIERS',            alias:'tfa', level:'achats-header', group:'Fournisseur Achat', dimFilter:"TIRTYPE='F'",
    joins:["JOIN TIERS tfa ON tfa.TIRID=pa.TIRID"] },
  ARTICLES_ACH:      { label:'ARTICLES (achats)',             physTable:'ARTICLES',         alias:'aa',  level:'achats-line',   group:'Article Achat',
    joins:["LEFT JOIN ARTICLES aa ON aa.ARTID=pal.ARTID"] },
  ARTFAMILLES_ACH:   { label:'ARTFAMILLES (achats)',          physTable:'ARTFAMILLES',      alias:'afa', level:'achats-line',   group:'Article Achat',
    joins:["LEFT JOIN ARTICLES aa ON aa.ARTID=pal.ARTID","LEFT JOIN ARTFAMILLES afa ON afa.AFMID=aa.AFMID"] },
  ADRESSES_FOURN:    { label:'ADRESSES — Fournisseur (achat)',physTable:'ADRESSES',         alias:'adr_fa', level:'achats-header', group:'Fournisseur Achat',
    joins:["LEFT JOIN ADRESSES adr_fa ON adr_fa.TIRID=pa.TIRID AND adr_fa.ADRTYPE='L'"] },
  // ── Comptabilité ─────────────────────────────────────────────────────────────
  ECRITURES:         { label:'ECRITURES — Écritures comptables', physTable:'ECRITURES',   alias:'ecr', level:'compta', group:'Écriture',   joins:[] },
  COMPTES_CPT:       { label:'COMPTES — Plan comptable',          physTable:'COMPTES',     alias:'cpt', level:'compta', group:'Compte',
    joins:["LEFT JOIN COMPTES cpt ON cpt.CPTID=ecr.CPTID"] },
  JOURNAUX:          { label:'JOURNAUX — Journaux comptables',    physTable:'JOURNAUX',    alias:'jrn', level:'compta', group:'Journal',
    joins:["LEFT JOIN JOURNAUX jrn ON jrn.JRNID=ecr.ECRJRNID"] },
  TIERS_ECR_C:       { label:'TIERS — Client écriture',           physTable:'TIERS',       alias:'ter_c', level:'compta', group:'Client', dimFilter:"TIRTYPE='C'",
    joins:["LEFT JOIN TIERS ter_c ON ter_c.CPTID=ecr.CPTID AND ter_c.TIRTYPE='C'"] },
  TIERS_ECR_F:       { label:'TIERS — Fournisseur écriture',      physTable:'TIERS',       alias:'ter_f', level:'compta', group:'Fournisseur', dimFilter:"TIRTYPE='F'",
    joins:["LEFT JOIN TIERS ter_f ON ter_f.CPTID=ecr.CPTID AND ter_f.TIRTYPE='F'"] },
};

// Convertit un enregistrement custom-dim en définition de dimension
function customDimToDef(dim) {
  const jt = JOINABLE_TABLES[dim.tableKey];
  if (!jt) return null;

  // ── Formule (concat / calc / sql libre) ──────────────────────────────────
  if (dim.type === 'formula') {
    // Collecter les joins de toutes les tables impliquées (dédupliqués)
    const seen = new Set();
    const joins = [];
    [dim.tableKey, ...(dim.extraTableKeys || [])].forEach(tk => {
      (JOINABLE_TABLES[tk]?.joins || []).forEach(j => {
        if (!seen.has(j)) { seen.add(j); joins.push(j); }
      });
    });
    return { label: dim.label, group: dim.group || jt.group, level: jt.level,
      expr: dim.expr, groupBy: dim.groupBy, joins };
  }

  // ── Colonne simple ────────────────────────────────────────────────────────
  const alias = jt.alias, col = dim.column, dt = (dim.dataType||'varchar').toLowerCase();
  let expr, groupBy;
  if (/^(int|bigint|smallint|tinyint|bit|decimal|numeric|float|real|money)/.test(dt)) {
    expr    = `CAST(ISNULL(${alias}.${col},0) AS VARCHAR(50))`;
    groupBy = `${alias}.${col}`;
  } else if (/^(date|datetime)/.test(dt)) {
    expr    = `CONVERT(VARCHAR(10),${alias}.${col},120)`;
    groupBy = `CONVERT(DATE,${alias}.${col})`;
  } else {
    expr    = `ISNULL(RTRIM(${alias}.${col}),'—')`;
    groupBy = `${alias}.${col}`;
  }
  return { label:dim.label||col, group:dim.group||jt.group, level:jt.level, expr, groupBy, joins:jt.joins };
}

// Fusionne dimensions codées + dimensions custom + overrides de libellé
function getActiveDimensions() {
  const result = {};
  for (const [id, d] of Object.entries(DIMENSIONS)) result[id] = { ...d };
  readCustomDims().forEach(dim => {
    if (dim.builtin) {
      if (result[dim.id]) result[dim.id] = { ...result[dim.id], label: dim.label };
    } else {
      const id = dim.id || `custom_${dim.tableKey}_${dim.column}`.toLowerCase().replace(/[^a-z0-9_]/g,'_');
      const def = customDimToDef(dim);
      if (def) result[id] = def;
    }
  });
  return result;
}

const DIMENSIONS = {
  // ── Commercial ───────────────────────────────────────────────────────────────
  rep_nom:          { label:'Commercial (nom)',    group:'Commercial', level:'header',
    expr:"ISNULL(RTRIM(tr.TIRSOCIETE),'Non assigné')", groupBy:'tr.TIRID,tr.TIRSOCIETE',
    joins:["LEFT JOIN TIERS tr ON tr.TIRID=pv.TIRID_REP AND tr.TIRTYPE='R'"] },
  rep_code:         { label:'Commercial (code)',   group:'Commercial', level:'header',
    expr:"ISNULL(RTRIM(tr.TIRCODE),'—')",              groupBy:'tr.TIRID,tr.TIRCODE',
    joins:["LEFT JOIN TIERS tr ON tr.TIRID=pv.TIRID_REP AND tr.TIRTYPE='R'"] },

  // ── Client ───────────────────────────────────────────────────────────────────
  cli_nom:          { label:'Client (nom)',         group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRSOCIETE),'Non défini')",   groupBy:'tc.TIRID,tc.TIRSOCIETE',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  cli_code:         { label:'Client (code)',        group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRCODE),'—')",               groupBy:'tc.TIRID,tc.TIRCODE',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  cli_categorie:    { label:'Catégorie client',     group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRCATEGORIE),'Non défini')",  groupBy:'tc.TIRCATEGORIE',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  cli_activite:     { label:'Activité client',      group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRACTIVITE),'Non défini')",   groupBy:'tc.TIRACTIVITE',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  cli_geo:          { label:'Zone géo client',      group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRGEO),'Non défini')",        groupBy:'tc.TIRGEO',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  cli_branche:      { label:'Branche client',       group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRBRANCHE),'Non défini')",    groupBy:'tc.TIRBRANCHE',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  cli_enseigne:     { label:'Enseigne client',      group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRENSEIGNE),'Non défini')",   groupBy:'tc.TIRENSEIGNE',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  cli_origine:      { label:'Origine client',       group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRORIGINE),'Non défini')",    groupBy:'tc.TIRORIGINE',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  cli_cible1:       { label:'Cible 1 client',       group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRCIBLE1),'Non défini')",     groupBy:'tc.TIRCIBLE1',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },
  cli_cible2:       { label:'Cible 2 client',       group:'Client', level:'header',
    expr:"ISNULL(RTRIM(tc.TIRCIBLE2),'Non défini')",     groupBy:'tc.TIRCIBLE2',
    joins:["JOIN TIERS tc ON tc.TIRID=pv.TIRID"] },

  // ── Article ──────────────────────────────────────────────────────────────────
  art_famille:      { label:'Famille',              group:'Article', level:'line',
    expr:"ISNULL(RTRIM(af.AFMINTITULE),'Sans famille')", groupBy:'af.AFMID,af.AFMINTITULE',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID","LEFT JOIN ARTFAMILLES af ON af.AFMID=a.AFMID"] },
  art_sousfamille:  { label:'Sous-famille',         group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTSOUSFAMILLE),'Non défini')", groupBy:'a.ARTSOUSFAMILLE',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  art_categorie:    { label:'Catégorie article',    group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTCATEGORIE),'Non défini')",   groupBy:'a.ARTCATEGORIE',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  art_nature:       { label:'Nature article',       group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTNATURE),'Non défini')",      groupBy:'a.ARTNATURE',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  art_collection:   { label:'Collection',           group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTCOLLECTION),'Non défini')",  groupBy:'a.ARTCOLLECTION',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  art_marque:       { label:'Marque',               group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTMARQUE),'Non défini')",      groupBy:'a.ARTMARQUE',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  art_classe:       { label:'Classe article',       group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTCLASSE),'Non défini')",      groupBy:'a.ARTCLASSE',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  art_ref:          { label:'Article (référence)',  group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTCODE),'—')",                groupBy:'a.ARTID,a.ARTCODE',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  art_designation:  { label:'Article (désignation)',group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTDESIGNATION),'—')",         groupBy:'a.ARTID,a.ARTDESIGNATION',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  art_ref_design:   { label:'Article (réf + désignation)', group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTCODE),'—')+' – '+ISNULL(RTRIM(a.ARTDESIGNATION),'—')",
    groupBy:'a.ARTID,a.ARTCODE,a.ARTDESIGNATION',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },
  art_unite:        { label:'Unité de mesure',      group:'Article', level:'line',
    expr:"ISNULL(RTRIM(a.ARTUNITE),'—')",               groupBy:'a.ARTUNITE',
    joins:["LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID"] },

  // ── Période ──────────────────────────────────────────────────────────────────
  time_annee:       { label:'Année',                group:'Période', level:'header',
    expr:"CAST(YEAR(pv.PCVDATEEFFET) AS VARCHAR(4))",
    groupBy:'YEAR(pv.PCVDATEEFFET)', joins:[] },
  time_trimestre:   { label:'Trimestre',            group:'Période', level:'header',
    expr:"CAST(YEAR(pv.PCVDATEEFFET) AS VARCHAR(4))+'-T'+CAST(DATEPART(q,pv.PCVDATEEFFET) AS VARCHAR(1))",
    groupBy:'YEAR(pv.PCVDATEEFFET),DATEPART(q,pv.PCVDATEEFFET)', joins:[] },
  time_mois:        { label:'Mois (n°)',            group:'Période', level:'header',
    expr:"RIGHT('0'+CAST(MONTH(pv.PCVDATEEFFET) AS VARCHAR(2)),2)",
    groupBy:'MONTH(pv.PCVDATEEFFET)', joins:[] },
  time_mois_lib:    { label:'Mois (libellé)',       group:'Période', level:'header',
    expr:"CASE MONTH(pv.PCVDATEEFFET) WHEN 1 THEN '01 - Janvier' WHEN 2 THEN '02 - Février' WHEN 3 THEN '03 - Mars' WHEN 4 THEN '04 - Avril' WHEN 5 THEN '05 - Mai' WHEN 6 THEN '06 - Juin' WHEN 7 THEN '07 - Juillet' WHEN 8 THEN '08 - Août' WHEN 9 THEN '09 - Septembre' WHEN 10 THEN '10 - Octobre' WHEN 11 THEN '11 - Novembre' ELSE '12 - Décembre' END",
    groupBy:'MONTH(pv.PCVDATEEFFET)', joins:[] },
  time_anneemois:   { label:'Année-Mois',           group:'Période', level:'header',
    expr:"FORMAT(pv.PCVDATEEFFET,'yyyy-MM')",
    groupBy:"FORMAT(pv.PCVDATEEFFET,'yyyy-MM')", joins:[] },
  time_semaine:     { label:'Semaine',              group:'Période', level:'header',
    expr:"CAST(YEAR(pv.PCVDATEEFFET) AS VARCHAR)+'-S'+RIGHT('0'+CAST(DATEPART(wk,pv.PCVDATEEFFET) AS VARCHAR(2)),2)",
    groupBy:'YEAR(pv.PCVDATEEFFET),DATEPART(wk,pv.PCVDATEEFFET)', joins:[] },
  time_jour:        { label:'Jour (n°)',            group:'Période', level:'header',
    expr:"RIGHT('0'+CAST(DAY(pv.PCVDATEEFFET) AS VARCHAR(2)),2)",
    groupBy:'DAY(pv.PCVDATEEFFET)', joins:[] },
  time_date:        { label:'Date',                 group:'Période', level:'header',
    expr:"CONVERT(VARCHAR(10),pv.PCVDATEEFFET,120)",
    groupBy:'CONVERT(DATE,pv.PCVDATEEFFET)', joins:[] },
  time_anneetrim:   { label:'Année + Trimestre',    group:'Période', level:'header',
    expr:"CAST(YEAR(pv.PCVDATEEFFET) AS VARCHAR(4))+' T'+CAST(DATEPART(q,pv.PCVDATEEFFET) AS VARCHAR(1))",
    groupBy:'YEAR(pv.PCVDATEEFFET),DATEPART(q,pv.PCVDATEEFFET)', joins:[] },

  // ── Fournisseur ───────────────────────────────────────────────────────────────
  fournisseur_nom:  { label:'Fournisseur principal',group:'Fournisseur', level:'line',
    expr:"ISNULL(RTRIM(tf.TIRSOCIETE),'Sans fournisseur')", groupBy:'tf.TIRID,tf.TIRSOCIETE',
    joins:[
      "LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID",
      "OUTER APPLY (SELECT TOP 1 p.TIRID FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.PROISPRINCIPAL='O' ORDER BY p.PROID) pro_fpa",
      "LEFT JOIN TIERS tf ON tf.TIRID=pro_fpa.TIRID AND tf.TIRTYPE='F'"
    ] },
  fournisseur_code: { label:'Fournisseur (code)',   group:'Fournisseur', level:'line',
    expr:"ISNULL(RTRIM(tf.TIRCODE),'—')",                  groupBy:'tf.TIRID,tf.TIRCODE',
    joins:[
      "LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID",
      "OUTER APPLY (SELECT TOP 1 p.TIRID FROM PRODUITS p WHERE p.ARTID=a.ARTID AND p.PROISPRINCIPAL='O' ORDER BY p.PROID) pro_fpa",
      "LEFT JOIN TIERS tf ON tf.TIRID=pro_fpa.TIRID AND tf.TIRTYPE='F'"
    ] },
  fournisseur_all:  { label:'Fournisseur (tous)',   group:'Fournisseur', level:'line',
    expr:"ISNULL(RTRIM(tfall.TIRSOCIETE),'Sans fournisseur')", groupBy:'tfall.TIRID,tfall.TIRSOCIETE',
    joins:[
      "LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID",
      "LEFT JOIN PRODUITS pro_fall ON pro_fall.ARTID=a.ARTID",
      "LEFT JOIN TIERS tfall ON tfall.TIRID=pro_fall.TIRID AND tfall.TIRTYPE='F'"
    ] },

  // ── Pièce / Document ─────────────────────────────────────────────────────────
  pv_nature:        { label:'Nature de pièce',      group:'Document', level:'header',
    expr:"ISNULL(RTRIM(pn.PINLIBELLE),'—')",               groupBy:'pn.PINID,pn.PINLIBELLE',
    joins:[] },
  pv_annee_creation:{ label:'Année création pièce', group:'Document', level:'header',
    expr:"CAST(YEAR(pv.PCVDATECREATION) AS VARCHAR(4))",    groupBy:'YEAR(pv.PCVDATECREATION)',
    joins:[] },

  // ── Adresse livraison client ──────────────────────────────────────────────────
  cli_adr_ville:    { label:'Ville livraison',      group:'Adresse', level:'header',
    expr:"ISNULL(RTRIM(adr_cli.ADRVILLE),'—')",            groupBy:'adr_cli.ADRVILLE',
    joins:["LEFT JOIN ADRESSES adr_cli ON adr_cli.TIRID=pv.TIRID AND adr_cli.ADRTYPE='L'"] },
  cli_adr_cp:       { label:'Code postal livraison',group:'Adresse', level:'header',
    expr:"ISNULL(RTRIM(adr_cli.ADRCODEPOSTAL),'—')",       groupBy:'adr_cli.ADRCODEPOSTAL',
    joins:["LEFT JOIN ADRESSES adr_cli ON adr_cli.TIRID=pv.TIRID AND adr_cli.ADRTYPE='L'"] },
  cli_adr_pays:     { label:'Pays livraison',       group:'Adresse', level:'header',
    expr:"ISNULL(RTRIM(adr_cli.ADRNATION),'—')",           groupBy:'adr_cli.ADRNATION',
    joins:["LEFT JOIN ADRESSES adr_cli ON adr_cli.TIRID=pv.TIRID AND adr_cli.ADRTYPE='L'"] },
  cli_adr_region:   { label:'Région livraison',     group:'Adresse', level:'header',
    expr:"ISNULL(RTRIM(adr_cli.ADRREGION),'—')",           groupBy:'adr_cli.ADRREGION',
    joins:["LEFT JOIN ADRESSES adr_cli ON adr_cli.TIRID=pv.TIRID AND adr_cli.ADRTYPE='L'"] },

  // ── ACHATS — Période : utilise les dims `time_*` génériques (remap pv.PCVDATEEFFET → pa.PCADATEEFFET)

  // ── ACHATS — Fournisseur ─────────────────────────────────────────────────────
  ach_fourn_nom:    { label:'Fournisseur achat (nom)',  group:'Fournisseur', domain:'achats', level:'achats-header',
    expr:"ISNULL(RTRIM(tfa.TIRSOCIETE),'Sans fournisseur')", groupBy:'tfa.TIRID,tfa.TIRSOCIETE',
    joins:["JOIN TIERS tfa ON tfa.TIRID=pa.TIRID"] },
  ach_fourn_code:   { label:'Fournisseur achat (code)', group:'Fournisseur', domain:'achats', level:'achats-header',
    expr:"ISNULL(RTRIM(tfa.TIRCODE),'—')",                   groupBy:'tfa.TIRID,tfa.TIRCODE',
    joins:["JOIN TIERS tfa ON tfa.TIRID=pa.TIRID"] },
  ach_fourn_cat:    { label:'Catégorie fournisseur',    group:'Fournisseur', domain:'achats', level:'achats-header',
    expr:"ISNULL(RTRIM(tfa.TIRCATEGORIE),'Non défini')",     groupBy:'tfa.TIRCATEGORIE',
    joins:["JOIN TIERS tfa ON tfa.TIRID=pa.TIRID"] },
  ach_fourn_pays:   { label:'Pays fournisseur',         group:'Fournisseur', domain:'achats', level:'achats-header',
    expr:"ISNULL(RTRIM(adr_fa.ADRNATION),'—')",              groupBy:'adr_fa.ADRNATION',
    joins:["JOIN TIERS tfa ON tfa.TIRID=pa.TIRID","LEFT JOIN ADRESSES adr_fa ON adr_fa.TIRID=pa.TIRID AND adr_fa.ADRTYPE='L'"] },

  // ── ACHATS — Nature pièce ────────────────────────────────────────────────────
  ach_nature:       { label:'Nature pièce achat',  group:'Achat', domain:'achats', level:'achats-header',
    expr:"ISNULL(RTRIM(pan.PINLIBELLE),'—')",  groupBy:'pan.PINID,pan.PINLIBELLE',
    joins:[] },

  // ── ACHATS — Article : utilise les dims `art_*` génériques (remap pl.ARTID → pal.ARTID)

  // ── ACHATS — Produit (catalogue fournisseur PRODUITS) ───────────────────────
  // Un ARTID peut correspondre à plusieurs PROID (plusieurs fournisseurs catalogue).
  // PRO* déjà exposé par V_STATISTIQUE_ACHAT via va.PRO* → aucune jointure extra.
  ach_proid:         { label:'PROID',                         group:'Produit (catalogue)', domain:'achats', level:'achats-line',
    expr:"pal.PROID", groupBy:'pal.PROID', joins:[] },
  ach_pro_code:      { label:'Code produit (catalogue)',      group:'Produit (catalogue)', domain:'achats', level:'achats-line',
    expr:"ISNULL(RTRIM(va.PROCODE),'—')", groupBy:'va.PROCODE', joins:[] },
  ach_pro_design:    { label:'Désignation produit',           group:'Produit (catalogue)', domain:'achats', level:'achats-line',
    expr:"ISNULL(RTRIM(va.PRODESIGNATION),'—')", groupBy:'va.PRODESIGNATION', joins:[] },
  ach_pro_code_design:{ label:'Code + désignation produit',   group:'Produit (catalogue)', domain:'achats', level:'achats-line',
    expr:"ISNULL(RTRIM(va.PROCODE),'—')+' – '+ISNULL(RTRIM(va.PRODESIGNATION),'—')",
    groupBy:'va.PROCODE,va.PRODESIGNATION', joins:[] },
  ach_pro_type:      { label:'Type produit',                  group:'Produit (catalogue)', domain:'achats', level:'achats-line',
    expr:"ISNULL(RTRIM(va.PROTYPE),'—')", groupBy:'va.PROTYPE', joins:[] },
  ach_pro_nature:    { label:'Nature produit',                group:'Produit (catalogue)', domain:'achats', level:'achats-line',
    expr:"ISNULL(RTRIM(va.PRONATURE),'—')", groupBy:'va.PRONATURE', joins:[] },
  ach_pro_collection:{ label:'Collection produit',            group:'Produit (catalogue)', domain:'achats', level:'achats-line',
    expr:"ISNULL(RTRIM(va.PROCOLLECTION),'—')", groupBy:'va.PROCOLLECTION', joins:[] },

  // ── ACHATS — Fournisseur catalogue (via PRODUITS.TIRID) ─────────────────────
  // Jointure explicite : PRODUITS → TIERS (TIRTYPE='F'). Peut différer du
  // fournisseur d'entête pa.TIRID (= `ach_fourn_*`) quand on achète chez un
  // fournisseur différent de celui référencé au catalogue.
  ach_pro_fourn_nom:  { label:'Fournisseur catalogue (nom)',  group:'Fournisseur', domain:'achats', level:'achats-line',
    expr:"ISNULL(RTRIM(tfpa.TIRSOCIETE),'—')", groupBy:'tfpa.TIRID,tfpa.TIRSOCIETE',
    joins:["LEFT JOIN PRODUITS pro_fa ON pro_fa.PROID=pal.PROID",
           "LEFT JOIN TIERS tfpa ON tfpa.TIRID=pro_fa.TIRID AND tfpa.TIRTYPE='F'"] },
  ach_pro_fourn_code: { label:'Fournisseur catalogue (code)', group:'Fournisseur', domain:'achats', level:'achats-line',
    expr:"ISNULL(RTRIM(tfpa.TIRCODE),'—')",    groupBy:'tfpa.TIRID,tfpa.TIRCODE',
    joins:["LEFT JOIN PRODUITS pro_fa ON pro_fa.PROID=pal.PROID",
           "LEFT JOIN TIERS tfpa ON tfpa.TIRID=pro_fa.TIRID AND tfpa.TIRTYPE='F'"] },

  // ── COMPTABILITÉ — Compte (numéro via COMPTES.CPTCODE, FK ecr.CPTID) ─────────
  cpt_num:           { label:'N° de compte',          group:'Compte', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(cpt.CPTCODE),'—')",            groupBy:'cpt.CPTID,cpt.CPTCODE',
    joins:["LEFT JOIN COMPTES cpt ON cpt.CPTID=ecr.CPTID"] },
  cpt_libelle:       { label:'Libellé compte',         group:'Compte', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(cpt.CPTLIBELLE),'—')",          groupBy:'cpt.CPTID,cpt.CPTLIBELLE',
    joins:["LEFT JOIN COMPTES cpt ON cpt.CPTID=ecr.CPTID"] },
  cpt_classe:        { label:'Classe de compte',       group:'Compte', domain:'compta', level:'compta',
    expr:"LEFT(RTRIM(cpt.CPTCODE),1)",                 groupBy:'LEFT(cpt.CPTCODE,1)',
    joins:["LEFT JOIN COMPTES cpt ON cpt.CPTID=ecr.CPTID"] },
  cpt_racine2:       { label:'Racine 2 chiffres',      group:'Compte', domain:'compta', level:'compta',
    expr:"LEFT(RTRIM(cpt.CPTCODE),2)",                 groupBy:'LEFT(cpt.CPTCODE,2)',
    joins:["LEFT JOIN COMPTES cpt ON cpt.CPTID=ecr.CPTID"] },
  cpt_racine3:       { label:'Racine 3 chiffres',      group:'Compte', domain:'compta', level:'compta',
    expr:"LEFT(RTRIM(cpt.CPTCODE),3)",                 groupBy:'LEFT(cpt.CPTCODE,3)',
    joins:["LEFT JOIN COMPTES cpt ON cpt.CPTID=ecr.CPTID"] },

  // ── COMPTABILITÉ — Journal ────────────────────────────────────────────────────
  jrn_code:          { label:'Code journal',           group:'Journal', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(jrn.JRNCODE),'—')",             groupBy:'jrn.JRNID,jrn.JRNCODE',
    joins:["LEFT JOIN JOURNAUX jrn ON jrn.JRNID=ecr.ECRJRNID"] },
  jrn_libelle:       { label:'Libellé journal',        group:'Journal', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(jrn.JRNLIBELLE),'—')",          groupBy:'jrn.JRNID,jrn.JRNLIBELLE',
    joins:["LEFT JOIN JOURNAUX jrn ON jrn.JRNID=ecr.ECRJRNID"] },

  // ── COMPTABILITÉ — Client (écriture sur tiers TIRTYPE='C') ──────────────────
  ecr_client_nom:    { label:'Client (écriture)',      group:'Client', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(ter_c.TIRSOCIETE),'—')",        groupBy:'ter_c.TIRID,ter_c.TIRSOCIETE',
    joins:["LEFT JOIN TIERS ter_c ON ter_c.CPTID=ecr.CPTID AND ter_c.TIRTYPE='C'"] },
  ecr_client_code:   { label:'Client (écriture, code)',group:'Client', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(ter_c.TIRCODE),'—')",           groupBy:'ter_c.TIRID,ter_c.TIRCODE',
    joins:["LEFT JOIN TIERS ter_c ON ter_c.CPTID=ecr.CPTID AND ter_c.TIRTYPE='C'"] },
  // ── COMPTABILITÉ — Fournisseur (écriture sur tiers TIRTYPE='F') ─────────────
  ecr_fourn_nom:     { label:'Fournisseur (écriture)', group:'Fournisseur', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(ter_f.TIRSOCIETE),'—')",        groupBy:'ter_f.TIRID,ter_f.TIRSOCIETE',
    joins:["LEFT JOIN TIERS ter_f ON ter_f.CPTID=ecr.CPTID AND ter_f.TIRTYPE='F'"] },
  ecr_fourn_code:    { label:'Fournisseur (écriture, code)', group:'Fournisseur', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(ter_f.TIRCODE),'—')",           groupBy:'ter_f.TIRID,ter_f.TIRCODE',
    joins:["LEFT JOIN TIERS ter_f ON ter_f.CPTID=ecr.CPTID AND ter_f.TIRTYPE='F'"] },

  // ── COMPTABILITÉ — Période : utilise les dims `time_*` génériques (remap pv.PCVDATEEFFET → ecr.ECRDATEEFFET)

  // ── COMPTABILITÉ — Document ───────────────────────────────────────────────────
  ecr_libelle:       { label:'Libellé écriture',       group:'Écriture', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(ecr.ECRLIBELLE),'—')",          groupBy:'ecr.ECRLIBELLE', joins:[] },
  ecr_num_piece:     { label:'N° pièce',               group:'Écriture', domain:'compta', level:'compta',
    expr:"ISNULL(RTRIM(ecr.ECRNUMERO),'—')",           groupBy:'ecr.ECRNUMERO', joins:[] },
};

// Mapping dim codée → (tableKey, column) pour le configurateur
const BUILTIN_DIM_MAP = {
  rep_nom:         { tableKey:'TIERS_REP',      column:'TIRSOCIETE' },
  rep_code:        { tableKey:'TIERS_REP',      column:'TIRCODE' },
  cli_nom:         { tableKey:'TIERS_CLIENT',   column:'TIRSOCIETE' },
  cli_code:        { tableKey:'TIERS_CLIENT',   column:'TIRCODE' },
  cli_categorie:   { tableKey:'TIERS_CLIENT',   column:'TIRCATEGORIE' },
  cli_activite:    { tableKey:'TIERS_CLIENT',   column:'TIRACTIVITE' },
  cli_geo:         { tableKey:'TIERS_CLIENT',   column:'TIRGEO' },
  cli_branche:     { tableKey:'TIERS_CLIENT',   column:'TIRBRANCHE' },
  cli_enseigne:    { tableKey:'TIERS_CLIENT',   column:'TIRENSEIGNE' },
  cli_origine:     { tableKey:'TIERS_CLIENT',   column:'TIRORIGINE' },
  cli_cible1:      { tableKey:'TIERS_CLIENT',   column:'TIRCIBLE1' },
  cli_cible2:      { tableKey:'TIERS_CLIENT',   column:'TIRCIBLE2' },
  art_famille:     { tableKey:'ARTFAMILLES',    column:'AFMINTITULE' },
  art_sousfamille: { tableKey:'ARTICLES',       column:'ARTSOUSFAMILLE' },
  art_categorie:   { tableKey:'ARTICLES',       column:'ARTCATEGORIE' },
  art_nature:      { tableKey:'ARTICLES',       column:'ARTNATURE' },
  art_collection:  { tableKey:'ARTICLES',       column:'ARTCOLLECTION' },
  art_marque:      { tableKey:'ARTICLES',       column:'ARTMARQUE' },
  art_classe:      { tableKey:'ARTICLES',       column:'ARTCLASSE' },
  art_ref:         { tableKey:'ARTICLES',       column:'ARTCODE' },
  art_designation: { tableKey:'ARTICLES',       column:'ARTDESIGNATION' },
  art_unite:       { tableKey:'ARTICLES',       column:'ARTUNITE' },
  fournisseur_nom: { tableKey:'TIERS_FOURN',    column:'TIRSOCIETE' },
  fournisseur_code:{ tableKey:'TIERS_FOURN',    column:'TIRCODE' },
  pv_nature:       { tableKey:'PIECE_NATURE',   column:'PINLIBELLE' },
};

// ── Dimension filters registry ────────────────────────────────────────────────
// Maps dimension ID → { paramKey, label, sqlType, filterSQL, valueQuery }
// filterSQL: WHERE fragment using the same alias as the dimension's join
// valueQuery: SQL to fetch distinct {id, libelle} pairs; null = use existing list
const DIM_FILTERS = {
  rep_nom:        { paramKey:'repid',        label:'Commercial',        sqlType:'int', filterSQL:'AND pv.TIRID_REP=@repid',             valueQuery:null },
  cli_nom:        { paramKey:'tirid',        label:'Client',            sqlType:'int', filterSQL:'AND pv.TIRID=@tirid',
    valueQuery:`SELECT DISTINCT pv.TIRID AS id, RTRIM(tc.TIRSOCIETE) AS libelle FROM PIECEVENTES pv JOIN TIERS tc ON tc.TIRID=pv.TIRID JOIN PIECE_NATURE pn ON pn.PINID=pv.PINID WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 ORDER BY libelle` },
  cli_categorie:  { paramKey:'cli_cat',      label:'Catégorie client',  sqlType:'str', filterSQL:"AND tc.TIRCATEGORIE=@cli_cat",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=7 ORDER BY libelle` },
  cli_activite:   { paramKey:'cli_act',      label:'Activité client',   sqlType:'str', filterSQL:"AND tc.TIRACTIVITE=@cli_act",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=5 ORDER BY libelle` },
  cli_geo:        { paramKey:'cli_geo',      label:'Zone géo',          sqlType:'str', filterSQL:"AND tc.TIRGEO=@cli_geo",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=3 ORDER BY libelle` },
  cli_branche:    { paramKey:'cli_branche',  label:'Branche',           sqlType:'str', filterSQL:"AND tc.TIRBRANCHE=@cli_branche",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=6 ORDER BY libelle` },
  cli_enseigne:   { paramKey:'cli_enseigne', label:'Enseigne',          sqlType:'str', filterSQL:"AND tc.TIRENSEIGNE=@cli_enseigne",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=19 ORDER BY libelle` },
  cli_origine:    { paramKey:'cli_origine',  label:'Origine client',    sqlType:'str', filterSQL:"AND tc.TIRORIGINE=@cli_origine",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=14 ORDER BY libelle` },
  cli_cible1:     { paramKey:'cli_cible1',   label:'Cible 1',           sqlType:'str', filterSQL:"AND tc.TIRCIBLE1=@cli_cible1",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=20 ORDER BY libelle` },
  cli_cible2:     { paramKey:'cli_cible2',   label:'Cible 2',           sqlType:'str', filterSQL:"AND tc.TIRCIBLE2=@cli_cible2",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=21 ORDER BY libelle` },
  art_famille:    { paramKey:'afmid',        label:'Famille article',   sqlType:'int', filterSQL:"AND af.AFMID=@afmid",
    valueQuery:`SELECT AFMID AS id, RTRIM(AFMINTITULE) AS libelle FROM ARTFAMILLES ORDER BY libelle` },
  art_sousfamille:{ paramKey:'art_sfam',     label:'Sous-famille',      sqlType:'str', filterSQL:"AND a.ARTSOUSFAMILLE=@art_sfam",
    valueQuery:`SELECT DISTINCT RTRIM(ARTSOUSFAMILLE) AS id, RTRIM(ARTSOUSFAMILLE) AS libelle FROM ARTICLES WHERE ARTSOUSFAMILLE IS NOT NULL AND LEN(RTRIM(ARTSOUSFAMILLE))>0 ORDER BY libelle` },
  art_categorie:  { paramKey:'art_cat',      label:'Catégorie article', sqlType:'str', filterSQL:"AND a.ARTCATEGORIE=@art_cat",
    valueQuery:`SELECT DISTINCT RTRIM(ARTCATEGORIE) AS id, RTRIM(ARTCATEGORIE) AS libelle FROM ARTICLES WHERE ARTCATEGORIE IS NOT NULL AND LEN(RTRIM(ARTCATEGORIE))>0 ORDER BY libelle` },
  art_nature:     { paramKey:'art_nat',      label:'Nature article',    sqlType:'str', filterSQL:"AND a.ARTNATURE=@art_nat",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=10 ORDER BY libelle` },
  art_marque:     { paramKey:'art_marque',   label:'Marque',            sqlType:'str', filterSQL:"AND a.ARTMARQUE=@art_marque",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=25 ORDER BY libelle` },
  art_classe:     { paramKey:'art_classe',   label:'Classe article',    sqlType:'str', filterSQL:"AND a.ARTCLASSE=@art_classe",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=24 ORDER BY libelle` },
  art_collection: { paramKey:'art_coll',     label:'Collection',        sqlType:'str', filterSQL:"AND a.ARTCOLLECTION=@art_coll",
    valueQuery:`SELECT RTRIM(ENULIBELLE) AS id, RTRIM(ENULIBELLE) AS libelle FROM ENUMERES WHERE ENUTYPE=9 ORDER BY libelle` },
  fournisseur_nom:{ paramKey:'fouid',        label:'Fournisseur',       sqlType:'int', valueQuery:null,
    filterSQL:"AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=pl.ARTID AND p.TIRID=@fouid AND p.PROISPRINCIPAL='O')" },
  fournisseur_all:{ paramKey:'fouid',        label:'Fournisseur',       sqlType:'int', valueQuery:null,
    filterSQL:"AND EXISTS(SELECT 1 FROM PRODUITS p WHERE p.ARTID=pl.ARTID AND p.TIRID=@fouid)" },
};

// ── Measures registry ─────────────────────────────────────────────────────────
// Toutes les mesures CA/marges/PR/PA sont calculées au niveau ligne (PIECEVENTELIGNES) :
//   CA  = (PLVMNTNETHT - PCVREMISEPIED*PLVMNTNETHT) * SENS
//   Frais = PLVFRAISTOTAL (pré-totalisé, fiable que PLVFRAIS1/2/3 soient en taux ou en montant)
//   PR  = pl.<COL> * PLVQTE * SENS  où COL ∈ {PLVCRUMP, PLVPRMP, PLVLASTPR}
//   PA  = pl.<COL> * PLVQTE * SENS  où COL ∈ {PLVLASTPA, PLVPMP, PLVCUMP}
const _CA_LINE  = `(pl.PLVMNTNETHT - pv.PCVREMISEPIED*pl.PLVMNTNETHT)*pn.PINSENSSTATISTIQUE`;
const _FRAIS    = `ISNULL(pl.PLVFRAISTOTAL,0)`;
const _PR = col => `pl.${col}*pl.PLVQTE*pn.PINSENSSTATISTIQUE`;
const MEASURES = {
  ca:       { label:'CA HT',            format:'euro',
              sqlLine:`SUM(${_CA_LINE})`,
              sqlHead:null, requiresLines:true },
  // Qté facturée : seulement pour articles à nature stock 'R'
  qte:      { label:'Quantité',         format:'qty',
              sqlLine:`SUM(CASE WHEN pn.PINNATURESTOCK='R' THEN pl.PLVQTE*pn.PINSENSSTATISTIQUE ELSE 0 END)`,
              sqlHead:null, requiresLines:true },
  // Marges SF (sans frais) : CA - PR * PLVQTE * SENS
  marge_sf:      { label:'Marge brute SF (CRUMP)',   format:'euro',
              sqlLine:`SUM(${_CA_LINE} - ${_PR('PLVCRUMP')})`,
              sqlHead:null, requiresLines:true },
  marge_sf_prmp: { label:'Marge brute SF (PRMP)',    format:'euro',
              sqlLine:`SUM(${_CA_LINE} - ${_PR('PLVPRMP')})`,
              sqlHead:null, requiresLines:true },
  marge_sf_last: { label:'Marge brute SF (Dernier)', format:'euro',
              sqlLine:`SUM(${_CA_LINE} - ${_PR('PLVLASTPR')})`,
              sqlHead:null, requiresLines:true },
  // Frais totalisés au niveau ligne
  frais:    { label:'Frais',            format:'euro',
              sqlLine:`SUM(${_FRAIS})`,
              sqlHead:null, requiresLines:true },
  // Marges AF (avec frais)
  marge_af:      { label:'Marge nette AF (CRUMP)',   format:'euro',
              sqlLine:`SUM(${_CA_LINE} - (pl.PLVCRUMP+${_FRAIS})*pl.PLVQTE*pn.PINSENSSTATISTIQUE)`,
              sqlHead:null, requiresLines:true },
  marge_af_prmp: { label:'Marge nette AF (PRMP)',    format:'euro',
              sqlLine:`SUM(${_CA_LINE} - (pl.PLVPRMP+${_FRAIS})*pl.PLVQTE*pn.PINSENSSTATISTIQUE)`,
              sqlHead:null, requiresLines:true },
  marge_af_last: { label:'Marge nette AF (Dernier)', format:'euro',
              sqlLine:`SUM(${_CA_LINE} - (pl.PLVLASTPR+${_FRAIS})*pl.PLVQTE*pn.PINSENSSTATISTIQUE)`,
              sqlHead:null, requiresLines:true },
  // Montants PR (coût de revient total)
  pr_crump: { label:'Montant revient CRUMP',   format:'euro',
              sqlLine:`SUM(${_PR('PLVCRUMP')})`,
              sqlHead:null, requiresLines:true },
  pr_prmp:  { label:'Montant revient PRMP',    format:'euro',
              sqlLine:`SUM(${_PR('PLVPRMP')})`,
              sqlHead:null, requiresLines:true },
  pr_last:  { label:'Montant revient LASTPR',  format:'euro',
              sqlLine:`SUM(${_PR('PLVLASTPR')})`,
              sqlHead:null, requiresLines:true },
  // Montants PA (prix d'achat, sans frais)
  pa_last:  { label:'Montant achat LASTPA',    format:'euro',
              sqlLine:`SUM(${_PR('PLVLASTPA')})`,
              sqlHead:null, requiresLines:true },
  pa_pmp:   { label:'Montant achat PMP',       format:'euro',
              sqlLine:`SUM(${_PR('PLVPMP')})`,
              sqlHead:null, requiresLines:true },
  pa_cump:  { label:'Montant achat CUMP',      format:'euro',
              sqlLine:`SUM(${_PR('PLVCUMP')})`,
              sqlHead:null, requiresLines:true },
  nb_cartons: { label:'Nb cartons',    format:'qty',
              sqlLine:'SUM(ABS(pl.PLVD1)*pn.PINSENSSTATISTIQUE)',
              sqlHead:null, requiresLines:true },
  // ── Stock (OPERATIONSTOCK) ────────────────────────────────────────────────────
  // Stock = cumul de toutes les opérations (entrées positives, sorties négatives) jusqu'à @dateFin.
  // MAX() évite le double-comptage quand plusieurs lignes de vente par article dans la même requête.
  // Pour un regroupement multi-articles (ex: par marque), utiliser SUM sur des valeurs déjà distinctes
  // par article n'est pas possible en SQL pur sans sous-requête dédiée — MAX est une approximation.
  qte_stock:     { label:'Qté en stock',     format:'qty',  aggType:'max', noPivot:true,
              sqlLine:'MAX(ISNULL(_stk.total_qte,0))',
              sqlHead:null, requiresLines:true,
              extraJoins:[`LEFT JOIN (
  SELECT o.ARTID,
    SUM(o.OPEQUANTITE) AS total_qte,
    FLOOR(SUM(o.OPEQUANTITE)*1.0/NULLIF(MAX(a_pcb.ARTPCB),0)) AS total_cartons
  FROM OPERATIONSTOCK o
  JOIN ARTICLES a_pcb ON a_pcb.ARTID=o.ARTID
  WHERE o.OPENATURESTOCK='R' AND o.OPEDATE<=@dateFin
  GROUP BY o.ARTID
) _stk ON _stk.ARTID=pl.ARTID`] },
  // ── ACHATS ───────────────────────────────────────────────────────────────────
  // Refactor sur V_STATISTIQUE_ACHAT (2026-04-24) : JOIN va ON va.PLAID=pal.PLAID
  //   va.MNTNETHT  = montant net HT signé (équivalent de v.CA_Total_HT côté ventes)
  //   va.PLAQTEUS  = quantité signée (évite le recalcul PLAQTE*PINSENSSTATISTIQUE)
  // La vue n'expose PAS CRUMP/PRMP/LASTPR → ces colonnes restent sur pal.*, mais
  // on profite de va.PLAQTEUS comme qté signée.
  ach_montant:    { label:'Montant achat HT',   format:'euro', domain:'achats',
    sqlLine:'SUM(va.MNTNETHT)',
    sqlHead:null, requiresLines:true },
  ach_qte:        { label:'Qté achetée',        format:'qty',  domain:'achats',
    sqlLine:`SUM(CASE WHEN pan.PINNATURESTOCK='R' THEN va.PLAQTEUS ELSE 0 END)`,
    sqlHead:null, requiresLines:true },
  ach_nb_lignes:  { label:'Nb lignes achat',    format:'qty',  domain:'achats',
    sqlLine:'COUNT(pal.PLAID)',
    sqlHead:'COUNT(pa.PCAID)', requiresLines:false },
  ach_pa_crump:   { label:'PA CRUMP total',     format:'euro', domain:'achats',
    sqlLine:'SUM(ISNULL(pal.PLACRUMP,0)*va.PLAQTEUS)',
    sqlHead:null, requiresLines:true },
  ach_pa_prmp:    { label:'PA PRMP total',      format:'euro', domain:'achats',
    sqlLine:'SUM(ISNULL(pal.PLAPRMP,0)*va.PLAQTEUS)',
    sqlHead:null, requiresLines:true },
  ach_pa_last:    { label:'PA Dernier total',   format:'euro', domain:'achats',
    sqlLine:'SUM(ISNULL(pal.PLALASTPR,0)*va.PLAQTEUS)',
    sqlHead:null, requiresLines:true },
  ach_frais:      { label:'Frais achat',        format:'euro', domain:'achats',
    sqlLine:'SUM(ISNULL(pal.PLAFRAISTOTAL,0)*pan.PINSENSSTATISTIQUE)',
    sqlHead:null, requiresLines:true },
  // ── Comptabilité ─────────────────────────────────────────────────────────────
  ecr_debit:  { label:'Total Débit',  format:'euro', domain:'compta', requiresLines:false,
    sqlLine:'SUM(ISNULL(ecr.ECRDEBIT,0))',
    sqlHead:'SUM(ISNULL(ecr.ECRDEBIT,0))' },
  ecr_credit: { label:'Total Crédit', format:'euro', domain:'compta', requiresLines:false,
    sqlLine:'SUM(ISNULL(ecr.ECRCREDIT,0))',
    sqlHead:'SUM(ISNULL(ecr.ECRCREDIT,0))' },
  ecr_solde:  { label:'Solde (D-C)',  format:'euro', domain:'compta', requiresLines:false,
    sqlLine:'SUM(ISNULL(ecr.ECRDEBIT,0)-ISNULL(ecr.ECRCREDIT,0))',
    sqlHead:'SUM(ISNULL(ecr.ECRDEBIT,0)-ISNULL(ecr.ECRCREDIT,0))' },
  ecr_nb:     { label:'Nb écritures', format:'qty',  domain:'compta', requiresLines:false,
    sqlLine:'COUNT(ecr.ECRID)',
    sqlHead:'COUNT(ecr.ECRID)' },
  // ── Stock (suite) ────────────────────────────────────────────────────────────
  cartons_stock: { label:'Cartons en stock', format:'qty',  aggType:'max', noPivot:true,
              sqlLine:'MAX(ISNULL(_stk.total_cartons,0))',
              sqlHead:null, requiresLines:true,
              extraJoins:[`LEFT JOIN (
  SELECT o.ARTID,
    SUM(o.OPEQUANTITE) AS total_qte,
    FLOOR(SUM(o.OPEQUANTITE)*1.0/NULLIF(MAX(a_pcb.ARTPCB),0)) AS total_cartons
  FROM OPERATIONSTOCK o
  JOIN ARTICLES a_pcb ON a_pcb.ARTID=o.ARTID
  WHERE o.OPENATURESTOCK='R' AND o.OPEDATE<=@dateFin
  GROUP BY o.ARTID
) _stk ON _stk.ARTID=pl.ARTID`] },
};
router.get('/measures', (req, res) => res.json(
  Object.entries(MEASURES).map(([key, m]) => ({ key, label: m.label, format: m.format }))
));

// ── Custom source SQL executor ────────────────────────────────────────────────

async function executeCustomSource(cs, overrideParams = {}, overrideMeasures = null, overrideLayout = null, overrideDimensions = null) {
  // ── Merge toolbar dim filters into params.filters[] (parité dashboard live ↔ export) ──
  // Côté dashboard live, le merge se fait client-side : la toolbar (branche client, etc.)
  // remplace la valeur du filtre sauvegardé sur la même dim. Côté export, filterParams
  // arrive en clés top-level non mergées → on réplique la même fusion ici.
  {
    const SKIP_KEYS = new Set(['periode_debut','periode_fin','mois','annees','annee','dbs','asof','pr','mg','today','_userDatabase','_userConnId','filters']);
    const paramKeyToDim = {};
    Object.entries(DIM_FILTERS).forEach(([dimId, df]) => { paramKeyToDim[df.paramKey] = dimId; });
    // Dims temps exposables comme filtres toolbar (paramKey === dimId côté client, DIM_FILTER_MAP).
    // Absentes de DIM_FILTERS (pas de filterSQL dédié, elles passent par le bloc user-filters via
    // activeDimMap) → on les ajoute ici pour que l'export/email applique le sélecteur comme le live.
    ['time_annee','time_mois','time_anneemois','time_trimestre'].forEach(d => { paramKeyToDim[d] = d; });
    const toolbarReplacements = new Map();
    Object.entries(overrideParams).forEach(([k, v]) => {
      if (SKIP_KEYS.has(k)) return;
      const dimId = paramKeyToDim[k];
      if (!dimId) return;
      const sval = (v === '' || v == null) ? null : String(v);
      if (sval === null) { toolbarReplacements.set(dimId, null); return; }
      const op = sval.includes(',') ? 'IN' : '=';
      toolbarReplacements.set(dimId, { op, val: sval });
    });
    if (toolbarReplacements.size > 0) {
      const savedFilters = Array.isArray(overrideParams.filters) ? overrideParams.filters : [];
      const newFilters = [];
      const replacedDims = new Set();
      savedFilters.forEach(f => {
        if (!toolbarReplacements.has(f.dimId)) { newFilters.push(f); return; }
        const repl = toolbarReplacements.get(f.dimId);
        replacedDims.add(f.dimId);
        if (repl == null) {
          // toolbar vide → si filtre obligatoire, conserver avec val='' (forcera 1=0 plus bas)
          // sinon comportement historique = retirer le filtre saved (= afficher tout).
          if (f.required) newFilters.push({ ...f, val: '' });
          return;
        }
        newFilters.push({ dimId: f.dimId, op: repl.op, val: repl.val,
          ...(f.required    ? { required: true }              : {}),
          ...(f.connector   ? { connector: f.connector }      : {}),
          ...(f.openGroups  ? { openGroups: f.openGroups }    : {}),
          ...(f.closeGroups ? { closeGroups: f.closeGroups }  : {}),
        });
      });
      for (const [dim, repl] of toolbarReplacements.entries()) {
        if (replacedDims.has(dim) || repl == null) continue;
        newFilters.push({ dimId: dim, op: repl.op, val: repl.val });
      }
      overrideParams = { ...overrideParams, filters: newFilters };
      // Strip toolbar paramKeys déjà convertis (évite double-application via DIM_FILTERS loop)
      for (const [dim] of toolbarReplacements.entries()) {
        const df = DIM_FILTERS[dim];
        if (df) delete overrideParams[df.paramKey];
      }
    }
  }

  let effectiveDimIds = (overrideDimensions?.length > 0 ? overrideDimensions : cs.dimensions) || [];
  // Auto-injection : quand une dim article de niveau supérieur (Famille, Catégorie, Marque…) est
  // choisie, on ajoute automatiquement ARTCODE + ARTDESIGNATION comme colonnes détail. Si en plus
  // aucune rupture n'est définie, la dim parente devient automatiquement la rupture pour produire
  // une vue hiérarchique (parent en groupe, articles en feuilles) plutôt qu'un libellé concaténé.
  const ART_HIGH = new Set(['art_famille','art_sousfamille','art_categorie','art_nature','art_collection','art_marque','art_classe','art_unite']);
  const ART_DETAIL = new Set(['art_ref','art_designation','art_ref_design']);
  let autoInjectedParentArtDim = null;
  if (effectiveDimIds.some(id => ART_HIGH.has(id)) && !effectiveDimIds.some(id => ART_DETAIL.has(id))) {
    autoInjectedParentArtDim = effectiveDimIds.find(id => ART_HIGH.has(id));
    effectiveDimIds = [...effectiveDimIds];
    if (!effectiveDimIds.includes('art_ref'))         effectiveDimIds.push('art_ref');
    if (!effectiveDimIds.includes('art_designation')) effectiveDimIds.push('art_designation');
  }
  const dims = effectiveDimIds.map(id => getActiveDimensions()[id]).filter(Boolean);
  if (!dims.length) return [];

  // ── Measures ───────────────────────────────────────────────────────────────
  const measSrc = overrideMeasures?.length ? overrideMeasures : (cs.measures?.length ? cs.measures : ['ca']);
  const measKeys = measSrc.filter(k => MEASURES[k]);
  const activeMeas = measKeys.map(k => ({ key: k, ...MEASURES[k] }));

  // ── Période ────────────────────────────────────────────────────────────────
  const f = cs.filters || {}, curY = new Date().getFullYear();
  function parsePV(val, fallY) {
    if (!val) return { d:`${fallY}-01-01`, f:`${fallY}-12-31` };
    const s = String(val);
    const now = new Date();
    const pad = n => String(n).padStart(2,'0');
    const isoD = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    if (s === 'ytd')   { return { d:`${curY}-01-01`, f:isoD(now) }; }
    if (s === 'mtd' || s === 'month') { const mm=pad(now.getMonth()+1); return { d:`${curY}-${mm}-01`, f:isoD(now) }; }
    if (s === '30j')   { const f=new Date(now); f.setDate(f.getDate()-30);   return { d:isoD(f), f:isoD(now) }; }
    if (s === '90j')   { const f=new Date(now); f.setDate(f.getDate()-90);   return { d:isoD(f), f:isoD(now) }; }
    if (s === '12m')   { const f=new Date(now); f.setMonth(f.getMonth()-12); return { d:isoD(f), f:isoD(now) }; }
    if (s.startsWith('cal:')) { const y=parseInt(s.slice(4))||fallY; return { d:`${y}-01-01`, f:`${y}-12-31` }; }
    if (s.startsWith('exe:')) { const p=s.slice(4).split(':'); return { d:p[0], f:p[1] }; }
    if (s.startsWith('ytd_exe:')) { const p=s.slice(8).split(':'); return { d:p[0], f:isoD(now) }; }
    return { d:`${parseInt(rp(s))||fallY}-01-01`, f:`${parseInt(rp(s))||fallY}-12-31` };
  }
  const dv = overrideParams.periode_debut || f.periode_debut || overrideParams.annee || f.annee || String(curY);
  const fv = overrideParams.periode_fin   || f.periode_fin   || dv;
  let dateDebut = parsePV(dv, curY).d;
  let dateFin   = parsePV(fv, curY).f;
  // Multi-année (ex : annees="2023,2024,2025") — surcharge la période en spannant min→max
  // et active un filtre YEAR(...) IN (...) plus loin (utile pour les années non-consécutives).
  const anneesRaw = overrideParams.annees || f.annees;
  const anneesList = anneesRaw ? String(anneesRaw).split(',').map(s => parseInt(s.trim())).filter(n => n >= 1900 && n <= 9999) : [];
  if (anneesList.length > 0) {
    const minY = Math.min(...anneesList);
    const maxY = Math.max(...anneesList);
    dateDebut = `${minY}-01-01`;
    dateFin   = `${maxY}-12-31`;
  }
  const moisRaw = overrideParams.mois || f.mois;
  const moisList = moisRaw ? String(moisRaw).split(',').map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 12) : [];
  if (moisList.length > 0) {
    // Stock snapshot = dernier jour du mois le plus tardif sélectionné
    const maxMois = Math.max(...moisList);
    const finYear = new Date(dateFin).getFullYear();
    const lastDay = new Date(finYear, maxMois, 0); // jour 0 du mois suivant = dernier jour de maxMois
    const p2 = n => String(n).padStart(2,'0');
    dateFin = `${lastDay.getFullYear()}-${p2(lastDay.getMonth()+1)}-${p2(lastDay.getDate())}`;
  }
  const repid = (overrideParams.repid || f.repid) ? parseInt(rp(overrideParams.repid || f.repid)) : null;
  const limit = Math.min(parseInt(cs.limit) || 20, 200);

  // ── Détection domaine ────────────────────────────────────────────────────────
  const domain =
    (dims.some(d => d.domain === 'compta') || activeMeas.some(m => m.domain === 'compta')) ? 'compta' :
    (dims.some(d => d.domain === 'achats') || activeMeas.some(m => m.domain === 'achats')) ? 'achats' :
    'ventes';

  // Remap des alias ventes (hardcodés dans certains dims/joins) vers les alias
  // du domaine courant. Permet d'utiliser des dims ventes (time_*, art_*, etc.)
  // dans un widget achats sans que le SQL ne référence pv/pl qui ne sont pas joints.
  // Note : pv.TIRID n'est PAS remappé — pa.TIRID est le fournisseur (sémantique ≠ client).
  const domainRemap =
    domain === 'achats' ? [
      ['pv.PCVDATEEFFET', 'pa.PCADATEEFFET'],
      ['pl.ARTID',        'pal.ARTID'],
    ] :
    domain === 'compta' ? [
      ['pv.PCVDATEEFFET', 'ecr.ECRDATEEFFET'],
    ] : [];
  const applyRemap = (s) => {
    if (!s || !domainRemap.length) return s;
    let out = s;
    for (const [from, to] of domainRemap) out = out.replaceAll(from, to);
    return out;
  };
  if (domainRemap.length) {
    for (let i = 0; i < dims.length; i++) {
      const d = dims[i];
      dims[i] = { ...d,
        expr:    applyRemap(d.expr),
        groupBy: applyRemap(d.groupBy),
        joins:   (d.joins || []).map(applyRemap),
      };
    }
    for (let i = 0; i < activeMeas.length; i++) {
      const m = activeMeas[i];
      if (m.extraJoins?.length) {
        activeMeas[i] = { ...m, extraJoins: m.extraJoins.map(applyRemap) };
      }
    }
  }

  // ── Query setup ────────────────────────────────────────────────────────────
  const needsLines = domain === 'compta' ? false
    : domain === 'achats'
    // En achats : les dims ventes (level='line') utilisées via remap (pl.ARTID → pal.ARTID)
    // nécessitent aussi la table PIECEACHATLIGNES pal
    ? dims.some(d => d.level === 'achats-line' || d.level === 'line')
      || activeMeas.some(m => m.requiresLines && m.domain === 'achats')
    : dims.some(d => d.level === 'line') || activeMeas.some(m => m.requiresLines);
  const seenJoins = new Set();
  // En domain='ventes' avec lignes, ARTICLES `a` est déjà joint dans fromSQL ci-dessous.
  // Pré-peupler seenJoins évite que les dim/measures qui font le même LEFT JOIN ARTICLES
  // (cf. dimDefs lignes 612-832) ne génèrent une erreur "alias dupliqué".
  if (domain === 'ventes') {
    seenJoins.add('LEFT JOIN ARTICLES a ON a.ARTID=pl.ARTID');
  }
  const joinsSQL = [...dims.flatMap(d => d.joins), ...activeMeas.flatMap(m => m.extraJoins || [])]
    .filter(j => { if (seenJoins.has(j)) return false; seenJoins.add(j); return true; }).join('\n');
  const selExprs = dims.map((d, i) => `${d.expr} AS c${i}`);
  const seenGb = new Set();
  const groupBys = dims.flatMap(d => d.groupBy.split(',').map(s => s.trim()))
    .filter(g => { if (seenGb.has(g)) return false; seenGb.add(g); return true; });
  const dateField = domain === 'compta' ? 'ecr.ECRDATEEFFET' : domain === 'achats' ? 'pa.PCADATEEFFET' : 'pv.PCVDATEEFFET';
  const mF = moisList.length ? `AND MONTH(${dateField}) IN (${moisList.join(',')})` : '';
  const yF = anneesList.length ? `AND YEAR(${dateField}) IN (${anneesList.join(',')})` : '';
  const rF = (domain === 'ventes' && repid) ? 'AND pv.TIRID_REP=@repid' : '';
  let fromSQL;
  if (domain === 'compta') {
    fromSQL = `FROM ECRITURES ecr\n${joinsSQL}\nWHERE 1=1`;
  } else if (domain === 'achats') {
    if (needsLines) {
      fromSQL = `FROM PIECEACHATLIGNES pal\nJOIN PIECEACHATS pa ON pa.PCAID=pal.PCAID\nJOIN PIECE_NATURE pan WITH (NOLOCK) ON pan.PINID=pa.PINID\nJOIN V_STATISTIQUE_ACHAT va ON va.PLAID=pal.PLAID\n${joinsSQL}\nWHERE pan.PINSENSSTATISTIQUE<>0 AND pal.ARTID IS NOT NULL`;
    } else {
      fromSQL = `FROM PIECEACHATS pa\nJOIN PIECE_NATURE pan WITH (NOLOCK) ON pan.PINID=pa.PINID\n${joinsSQL}\nWHERE pan.PINSENSSTATISTIQUE<>0`;
    }
  } else if (needsLines) {
    // ARTICLES déjà joint ici (alias `a`) : la dedup via seenJoins ci-dessus l'a retiré des dim joins.
    fromSQL = `FROM PIECEVENTELIGNES pl\nJOIN PIECEVENTES pv ON pv.PCVID=pl.PCVID\nJOIN PIECE_NATURE pn WITH (NOLOCK) ON pn.PINID=pv.PINID\nJOIN ARTICLES a WITH (NOLOCK) ON a.ARTID=pl.ARTID\n${joinsSQL}\nWHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND a.ARTISSTATISTIQUE='O'`;
  } else {
    fromSQL = `FROM PIECEVENTES pv\nJOIN PIECE_NATURE pn WITH (NOLOCK) ON pn.PINID=pv.PINID\n${joinsSQL}\nWHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0`;
  }
  const metricExprs = activeMeas.map((m, i) => {
    const expr = needsLines ? m.sqlLine : (m.sqlHead || m.sqlLine);
    return `${expr} AS m${i}`;
  });

  // ── Ruptures & pivot cols (widget override prioritaire sur source) ──────────
  let ruptureIds  = (overrideLayout?.ruptures  ?? cs.ruptures  ?? (cs.rupture  ? [cs.rupture]  : []));
  // Auto-rupture quand on a auto-injecté du détail article (ARTCODE/DESIGNATION) et qu'aucune
  // rupture n'est définie. Hiérarchie pliable/dépliable : Parent (Marque, Famille…) ▸ ARTCODE ▸
  // ARTDESIGNATION (feuille). L'utilisateur peut donc collapser à 2 niveaux comme une rupture
  // classique, plutôt qu'avoir un libellé concaténé en une seule colonne.
  if (autoInjectedParentArtDim && (!Array.isArray(ruptureIds) || ruptureIds.length === 0)) {
    ruptureIds = [autoInjectedParentArtDim, 'art_ref'];
  }
  const pivotColIds = (overrideLayout?.pivotCols ?? cs.pivotCols ?? (cs.pivotCol ? [cs.pivotCol] : []));
  const doPivot     = overrideLayout?.pivot ?? cs.pivot ?? false;
  const sortDir     = overrideLayout?.sortDir ?? cs.sortDir ?? 'desc';   // 'asc' | 'desc' | 'none'
  const topN        = parseInt(overrideLayout?.topN ?? cs.topN) || 0;     // 0 = pas de limite
  const sortBy      = overrideLayout?.sortBy ?? cs.sortBy ?? 'measure';   // 'measure' | dim id
  const ruptureIdxs  = ruptureIds.map(id  => effectiveDimIds.indexOf(id)).filter(i=>i>=0);
  const pivotColIdxs = pivotColIds.map(id => effectiveDimIds.indexOf(id)).filter(i=>i>=0);
  const TEMPORAL = new Set(['time_annee','time_mois','time_mois_lib','time_anneemois','time_semaine','time_jour','time_date','time_anneetrim','time_trimestre']);
  const autoTidx = effectiveDimIds.findIndex(id => TEMPORAL.has(id));
  const effPivotIdxs = pivotColIdxs.length > 0 ? pivotColIdxs
    : (doPivot && autoTidx >= 0) ? [autoTidx] : [];
  const structSet = new Set([...ruptureIdxs, ...effPivotIdxs]);
  const hasPivot   = doPivot && effPivotIdxs.length > 0;
  const hasRupture = ruptureIdxs.length > 0;
  const rawLimit   = (hasPivot || hasRupture) ? Math.min(limit * 500, 10000) : limit;
  // Detect temporal dimensions in row position (not pivot column, not rupture) for chronological sort
  const hasTemporalRowDim = effectiveDimIds.some((id, i) => !structSet.has(i) && TEMPORAL.has(id));
  const temporalOrderCols = effectiveDimIds
    .map((id, i) => (!structSet.has(i) && TEMPORAL.has(id)) ? `c${i} ASC` : null)
    .filter(Boolean);

  // ── Pools à interroger (multi-connexions) ─────────────────────────────────
  // `_userDatabase` + `_userConnId` sont injectés par les routes (req.user.*) pour que
  // le pool 'default' suive la base ET le serveur choisi au login.
  const dbsParam = overrideParams.dbs;
  const userInfo = { database: overrideParams._userDatabase, connId: overrideParams._userConnId };
  const dbIds = dbsParam ? String(dbsParam).split(',').map(s => s.trim()).filter(Boolean) : ['default'];
  const connList = loadConnections();
  const pools = await Promise.all(dbIds.map(id =>
    id === 'default' ? getUserPool(userInfo) : getConnPool(id)
  ));

  // ── Build dimension filter SQL (même pour tous les pools) ─────────────────
  const seenDimParams = new Set(['repid']);
  let dimFilterSQL = '';
  const dimInputs = []; // { key, type, value } — appliqués sur chaque pool
  for (const dimId of effectiveDimIds) {
    const df = DIM_FILTERS[dimId];
    if (!df || !df.filterSQL) continue;
    if (seenDimParams.has(df.paramKey)) continue;
    const rawVal = overrideParams[df.paramKey];
    if (!rawVal) continue;
    seenDimParams.add(df.paramKey);
    const vals = String(rawVal).split(',').map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) {
      dimInputs.push({ key: df.paramKey, type: df.sqlType === 'int' ? sql.Int : sql.NVarChar(255), value: df.sqlType === 'int' ? parseInt(vals[0]) : vals[0] });
      dimFilterSQL += ` ${df.filterSQL}`;
    } else {
      vals.forEach((v, i) => {
        dimInputs.push({ key: `${df.paramKey}_${i}`, type: df.sqlType === 'int' ? sql.Int : sql.NVarChar(255), value: df.sqlType === 'int' ? parseInt(v) : v });
      });
      const inParams = vals.map((_, i) => `@${df.paramKey}_${i}`).join(', ');
      const inSQL = df.filterSQL.replace(new RegExp(`=\\s*@${df.paramKey}\\b`), ` IN (${inParams})`);
      dimFilterSQL += ` ${inSQL}`;
    }
  }

  // ── User-defined widget filters ────────────────────────────────────────────
  const userFilters = Array.isArray(overrideParams.filters) ? overrideParams.filters : [];
  let extraJoinsForFilters = '';
  const activeDimMap = getActiveDimensions();
  const ALLOWED_OPS = new Set(['=','!=','>','<','>=','<=','LIKE','NOT LIKE','IN','NOT IN','BETWEEN','IS NULL','IS NOT NULL']);
  const filterClauses = []; // { connector:'AND'|'OR', sql:string }
  for (let fi = 0; fi < userFilters.length; fi++) {
    const flt = userFilters[fi];
    if (!flt.dimId || !ALLOWED_OPS.has(flt.op)) continue;
    const fDim = activeDimMap[flt.dimId];
    if (!fDim) continue;
    if (!effectiveDimIds.includes(flt.dimId)) {
      fDim.joins.forEach(j => {
        if (!seenJoins.has(j)) { seenJoins.add(j); extraJoinsForFilters += j + '\n'; }
      });
    }
    // groupBy peut avoir plusieurs parties : id+libellé (ex: tr.TIRID,tr.TIRSOCIETE)
    // On prend le dernier élément = le champ texte affiché, pas l'ID entier.
    // ATTENTION : split sur les virgules de NIVEAU 0 uniquement (respect des parens)
    // sinon on casse les expressions du type FORMAT(date,'yyyy-MM').
    const gbParts = splitTopLevelCommas(fDim.groupBy);
    const colExpr = gbParts[gbParts.length - 1];
    const pk = `wf${fi}`;
    const op = flt.op;
    const connector = flt.connector === 'OR' ? 'OR' : 'AND';
    let clauseSQL = '';
    if (op === 'IS NULL')     { clauseSQL = `(${colExpr}) IS NULL`; }
    else if (op === 'IS NOT NULL') { clauseSQL = `(${colExpr}) IS NOT NULL`; }
    else {
      const val = flt.val;
      const valEmpty = (val === undefined || val === null || val === '');
      if (valEmpty && flt.required) {
        // Filtre obligatoire (★) sans valeur → bloque tout l'affichage tant que la toolbar
        // ne fournit pas de valeur.
        clauseSQL = '1=0';
      } else if (valEmpty) {
        // Filtre optionnel sans valeur → on saute (comportement historique).
        continue;
      } else if (op === 'BETWEEN') {
        const val2 = flt.val2;
        if (!val2) {
          if (flt.required) { clauseSQL = '1=0'; } else { continue; }
        } else {
          dimInputs.push({ key: `${pk}a`, type: sql.NVarChar(500), value: String(val) });
          dimInputs.push({ key: `${pk}b`, type: sql.NVarChar(500), value: String(val2) });
          clauseSQL = `(${colExpr}) BETWEEN @${pk}a AND @${pk}b`;
        }
      } else if (op === 'IN' || op === 'NOT IN') {
        const vals = String(val).split(',').map(s => s.trim()).filter(Boolean);
        if (!vals.length) {
          if (flt.required) { clauseSQL = '1=0'; } else { continue; }
        } else {
          const params = vals.map((v, k) => { dimInputs.push({ key: `${pk}_${k}`, type: sql.NVarChar(500), value: v }); return `@${pk}_${k}`; });
          clauseSQL = `(${colExpr}) ${op} (${params.join(', ')})`;
        }
      } else {
        const vals = String(val).split(',').map(s => s.trim()).filter(Boolean);
        if (!vals.length) {
          if (flt.required) { clauseSQL = '1=0'; } else { continue; }
        } else if (vals.length > 1 && (op === '=' || op === '!=')) {
          const inOp = op === '=' ? 'IN' : 'NOT IN';
          const params = vals.map((v, k) => { dimInputs.push({ key: `${pk}_${k}`, type: sql.NVarChar(500), value: v }); return `@${pk}_${k}`; });
          clauseSQL = `(${colExpr}) ${inOp} (${params.join(', ')})`;
        } else {
          dimInputs.push({ key: pk, type: sql.NVarChar(500), value: String(vals[0]) });
          clauseSQL = `(${colExpr}) ${op} @${pk}`;
        }
      }
    }
    if (clauseSQL) {
      const og = Math.max(0, parseInt(flt.openGroups)  || 0);
      const cg = Math.max(0, parseInt(flt.closeGroups) || 0);
      filterClauses.push({ connector, sql: clauseSQL, og, cg });
    }
  }
  if (filterClauses.length) {
    // Auto-balance les parenthèses (corrige une saisie utilisateur incohérente)
    let totalOpen = 0, totalClose = 0;
    filterClauses.forEach(c => { totalOpen += c.og; totalClose += c.cg; });
    if (totalOpen > totalClose) filterClauses[filterClauses.length - 1].cg += (totalOpen - totalClose);
    else if (totalClose > totalOpen) filterClauses[0].og += (totalClose - totalOpen);
    const combined = filterClauses.map((c, i) => {
      const op = '('.repeat(c.og), cl = ')'.repeat(c.cg);
      return i === 0 ? `${op}${c.sql}${cl}` : `${c.connector} ${op}${c.sql}${cl}`;
    }).join(' ');
    dimFilterSQL += ` AND (${combined})`;
  }
  // Inject extra joins (filter-only dims) before WHERE
  if (extraJoinsForFilters) {
    fromSQL = fromSQL.replace('\nWHERE ', '\n' + extraJoinsForFilters + 'WHERE ');
  }

  const sqlSortDir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const measOrderClause = sortDir === 'none' ? '' : `, m0 ${sqlSortDir}`;
  // Si l'utilisateur a défini un filtre user-défini sur une dim temps (time_annee, time_mois,
  // time_anneemois, time_date, time_trimestre…), il pilote la fenêtre temporelle — on retire
  // le BETWEEN @dateDebut/@dateFin pour ne pas l'écraser.
  const hasTimeUserFilter = userFilters.some(f => typeof f?.dimId === 'string' && f.dimId.startsWith('time_'));
  const dateBetween = hasTimeUserFilter ? '' : `AND ${dateField} BETWEEN @dateDebut AND @dateFin`;
  const query = `SELECT TOP ${rawLimit} ${selExprs.join(', ')}, ${metricExprs.join(', ')}
${fromSQL}
  ${dateBetween} ${mF} ${yF} ${rF}${dimFilterSQL}
GROUP BY ${groupBys.join(', ')}
ORDER BY ${temporalOrderCols.length ? temporalOrderCols.join(', ') + measOrderClause : sortDir === 'none' ? '(SELECT NULL)' : `m0 ${sqlSortDir}`}`;
  if (activeMeas.some(m => m.aggType === 'max')) {
    console.log('[stock-debug] SQL généré :\n', query);
  }

  // ── Execute sur chaque pool et concatène les rawRows ─────────────────────
  const rawRows = (await Promise.all(pools.map(async pool => {
    const r = pool.request();
    r.input('dateDebut', sql.Date, new Date(dateDebut));
    r.input('dateFin',   sql.Date, new Date(dateFin));
    if (repid) r.input('repid', sql.Int, repid);
    dimInputs.forEach(({ key, type, value }) => r.input(key, type, value));
    try {
      const res = await r.query(query);
      return res.recordset.map(row => ({
        dimVals: dims.map((_, i) => String(row[`c${i}`] ?? '')),
        values:  Object.fromEntries(activeMeas.map((m, i) => [m.key, parseFloat(row[`m${i}`]) || 0]))
      }));
    } catch(qErr) {
      console.error('[executeCustomSource] SQL error:', qErr.message, '\nQUERY:\n', query);
      throw qErr;
    }
  }))).flat();

  // ── Helpers ────────────────────────────────────────────────────────────────
  const leafDimIdxs = dims.map((_,i) => i).filter(i => !structSet.has(i));
  const getColKey = row => effPivotIdxs.map(i=>row.dimVals[i]).join(' / ') || '—';
  const getRowLbl = row => row.dimVals.filter((_,i)=>!structSet.has(i)).join(' / ') || '—';
  const getLeafDimVals = row => leafDimIdxs.map(i => row.dimVals[i]);
  // Tri par dimension (rupture ou détail) — par défaut tri sur première mesure
  const sortByDimIdx     = (sortBy !== 'measure') ? effectiveDimIds.indexOf(sortBy) : -1;
  const sortByIsRupture  = sortByDimIdx >= 0 && ruptureIdxs.includes(sortByDimIdx);
  const sortByIsLeaf     = sortByDimIdx >= 0 && leafDimIdxs.includes(sortByDimIdx);
  const sortByLeafLocal  = sortByIsLeaf ? leafDimIdxs.indexOf(sortByDimIdx) : -1;
  const sortByMeasure    = sortBy === 'measure' || sortByDimIdx < 0;
  const cmpLabel = (a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true, sensitivity: 'base' });
  const sortSign  = sortDir === 'asc' ? 1 : -1; // -1 = desc (plus grand au plus petit)
  const sortVal   = sub => {
    if (typeof sub === 'number') return sub;
    const v = sub[activeMeas[0].key];
    if (typeof v === 'number') return v;
    return Object.values(sub).reduce((s, x) => s + (typeof x === 'number' ? x : (x[activeMeas[0].key] || 0)), 0);
  };
  const applyTopN = arr => topN > 0 ? arr.slice(0, topN) : arr;
  function aggMeas(m, rowSet) {
    // Stock measures use MAX in SQL to avoid per-line duplication; keep MAX in subtotals too
    if (m.aggType === 'max') return rowSet.reduce((mx, r) => Math.max(mx, r.values[m.key] || 0), 0);
    return rowSet.reduce((s, r) => s + (r.values[m.key] || 0), 0);
  }
  function calcSub(rows, cols) {
    if (cols) {
      return Object.fromEntries(cols.map(c => [c,
        Object.fromEntries(activeMeas.map(m => [m.key,
          aggMeas(m, rows.filter(r => getColKey(r) === c))
        ]))
      ]));
    }
    return Object.fromEntries(activeMeas.map(m => [m.key, aggMeas(m, rows)]));
  }
  function buildTree(rows, remIdxs, cols) {
    if (remIdxs.length === 0) {
      if (cols) {
        const m = new Map();
        rows.forEach(r => {
          const l = getRowLbl(r), c = getColKey(r);
          if (!m.has(l)) m.set(l, {label: l, dimVals: getLeafDimVals(r), values: {}});
          const e = m.get(l);
          if (!e.values[c]) e.values[c] = {};
          activeMeas.forEach(meas => {
            if (meas.aggType === 'max')
              e.values[c][meas.key] = Math.max(e.values[c][meas.key] || 0, r.values[meas.key] || 0);
            else
              e.values[c][meas.key] = (e.values[c][meas.key] || 0) + (r.values[meas.key] || 0);
          });
        });
        if (sortDir === 'none') return [...m.values()];
        if (sortByIsLeaf) {
          return [...m.values()].sort((a, b) => sortSign * cmpLabel(a.dimVals?.[sortByLeafLocal] ?? '', b.dimVals?.[sortByLeafLocal] ?? ''));
        }
        if (hasTemporalRowDim && sortByMeasure) return [...m.values()];
        return [...m.values()].sort((a, b) => {
          const aS = Object.values(a.values).reduce((s, v) => s + (v[activeMeas[0].key] || 0), 0);
          const bS = Object.values(b.values).reduce((s, v) => s + (v[activeMeas[0].key] || 0), 0);
          return sortSign * (aS - bS);
        });
      }
      const m = new Map();
      rows.forEach(r => {
        const l = getRowLbl(r);
        if (!m.has(l)) m.set(l, {label: l, dimVals: getLeafDimVals(r), values: {}});
        activeMeas.forEach(meas => {
          if (meas.aggType === 'max')
            m.get(l).values[meas.key] = Math.max(m.get(l).values[meas.key] || 0, r.values[meas.key] || 0);
          else
            m.get(l).values[meas.key] = (m.get(l).values[meas.key] || 0) + (r.values[meas.key] || 0);
        });
      });
      if (sortDir === 'none') return [...m.values()];
      if (sortByIsLeaf) {
        return [...m.values()].sort((a, b) => sortSign * cmpLabel(a.dimVals?.[sortByLeafLocal] ?? '', b.dimVals?.[sortByLeafLocal] ?? ''));
      }
      if (hasTemporalRowDim && sortByMeasure) return [...m.values()];
      return [...m.values()].sort((a, b) => sortSign * ((a.values[activeMeas[0].key] || 0) - (b.values[activeMeas[0].key] || 0)));
    }
    const [ci, ...ri] = remIdxs, gm = new Map();
    rows.forEach(r => { const k = r.dimVals[ci] || '—'; if (!gm.has(k)) gm.set(k, []); gm.get(k).push(r); });
    const built = [...gm.entries()].map(([label, gRows]) => ({label, subtotal: calcSub(gRows, cols), children: buildTree(gRows, ri, cols)}));
    if (sortDir === 'none') return built;
    // Tri par dim si la dim de ce niveau (effectiveDimIds[ci]) correspond à sortBy
    if (sortByIsRupture && effectiveDimIds[ci] === sortBy) {
      return built.sort((a, b) => sortSign * cmpLabel(a.label, b.label));
    }
    return built.sort((a, b) => sortSign * (sortVal(a.subtotal) - sortVal(b.subtotal)));
  }

  // ── Measures metadata for client ───────────────────────────────────────────
  const measMeta = activeMeas.map(m => ({ key: m.key, label: m.label, format: m.format }));

  // ── Return ─────────────────────────────────────────────────────────────────
  const noPivotKeys   = activeMeas.filter(m => m.noPivot).map(m => m.key);
  const staticMeasures = activeMeas.filter(m => m.noPivot).map(m => ({ key: m.key, label: m.label, format: m.format }));
  const pivotMeasMeta  = measMeta.filter(m => !noPivotKeys.includes(m.key));

  // Extrait les mesures noPivot des cellules pivot → staticValues par ligne
  // Pour les feuilles : MAX à travers les colonnes pivot. Pour les groupes : somme des enfants.
  function applyStaticValues(rows, cols) {
    if (!noPivotKeys.length) return rows;
    rows.forEach(row => {
      if (row.children) {
        applyStaticValues(row.children, cols); // récursion d'abord
        const sv = {};
        noPivotKeys.forEach(key => {
          sv[key] = row.children.reduce((sum, child) => sum + (child.staticValues?.[key] || 0), 0);
        });
        row.staticValues = sv;
      } else {
        const sv = {};
        noPivotKeys.forEach(key => {
          let val = 0;
          cols.forEach(c => {
            const cell = row.values?.[c];
            if (cell && typeof cell === 'object') val = Math.max(val, cell[key] || 0);
          });
          sv[key] = val;
          cols.forEach(c => { if (row.values?.[c]) delete row.values[c][key]; });
        });
        row.staticValues = sv;
      }
    });
    return rows;
  }

  // Libellés colonnes — utilisés par l'export Excel pour mettre une dim par colonne
  const ruptureLabels  = ruptureIdxs.map(i => dims[i]?.label || effectiveDimIds[i] || `Niveau ${i+1}`);
  const leafDimLabels  = leafDimIdxs.map(i => dims[i].label);

  // ruptureIds pour les renderers (utilisé par evolMode='rows' avec evolRowDim au choix)
  const ruptureIdsOut = ruptureIdxs.map(i => effectiveDimIds[i]);
  if (hasPivot) {
    const cols = [...new Set(rawRows.map(r => getColKey(r)))].sort();
    if (hasRupture) return { type:'grouped', measures:pivotMeasMeta, staticMeasures, columns:cols, ruptureLabels, ruptureIds:ruptureIdsOut, leafDimLabels, groups:applyStaticValues(applyTopN(buildTree(rawRows,ruptureIdxs,cols).slice(0,limit)), cols) };
    return { type:'pivot', measures:pivotMeasMeta, staticMeasures, columns:cols, leafDimLabels, rows:applyStaticValues(applyTopN(buildTree(rawRows,[],cols).slice(0,limit)), cols) };
  }
  if (hasRupture) return { type:'grouped', measures:measMeta, columns:null, ruptureLabels, ruptureIds:ruptureIdsOut, leafDimLabels, groups:applyTopN(buildTree(rawRows,ruptureIdxs,null).slice(0,limit)) };
  const dimLabels = leafDimLabels;
  // Cas plat (sans rupture, sans pivot) : tri par dim si demandé (sinon ORDER BY SQL = mesure)
  let flatRows = rawRows.slice(0, limit).map(r => ({
    label: getRowLbl(r),
    dimVals: getLeafDimVals(r),
    values: r.values
  }));
  if (sortByIsLeaf && sortDir !== 'none') {
    flatRows.sort((a, b) => sortSign * cmpLabel(a.dimVals?.[sortByLeafLocal] ?? '', b.dimVals?.[sortByLeafLocal] ?? ''));
  }
  return { measures:measMeta, dimLabels, rows: applyTopN(flatRows) };
}

// ── Label helpers ─────────────────────────────────────────────────────────────
function stripSortPrefix(str) {
  if (!str) return str;
  return str.split(' / ').map(p => p.replace(/^\d{2} - /, '')).join(' / ');
}

// ── HTML report generation ────────────────────────────────────────────────────

function groupedHTML(data, dateFormat, widget) {
  const { columns, groups, measures, staticMeasures = [], ruptureIds = [] } = data;
  if (!groups?.length) return '<p style="color:#999;font-size:13px">Aucune donnée</p>';
  const isPivot  = Array.isArray(columns) && columns.length > 0;
  const evolMode = widget?.evolMode || 'cols';   // 'cols' | 'each_col' | 'rows' | 'each_col_rows' | 'off'
  const isRowsMode = (evolMode === 'rows' || evolMode === 'each_col_rows');
  // Niveau auquel l'évolution rows s'applique. Par défaut feuille (-1 = leaf).
  // Si widget.evolRowDim correspond à une dim rupture, on calcule au niveau de cette rupture.
  const evolRowDim = widget?.evolRowDim || 'leaf';
  const evolRowLevel = (evolRowDim === 'leaf') ? -1 : ruptureIds.indexOf(evolRowDim);
  const showEvolCol = isPivot && (
    (evolMode === 'cols' && columns.length >= 2) ||
    isRowsMode
  );
  const showInlineEvol = isPivot && (evolMode === 'each_col' || evolMode === 'each_col_rows') && columns.length >= 2;
  const showEvol = showEvolCol;
  const evolLabel = isRowsMode ? 'Évolution (vs préc.)' : 'Évolution';
  const meas = measures || [{key:'ca', label:'CA HT', format:'euro'}];
  const totOpt = widget?.showTotals || false;
  const showRowTot = isPivot && (totOpt === 'rows' || totOpt === 'both');
  const showColTot = isPivot && (totOpt === 'cols' || totOpt === 'both');
  const TD_TOT_BL = 'border-left:2px solid #c5cae9';
  const TD_STAT_BL = 'border-left:2px solid #c5cae9';
  const colGrandTots = isPivot ? columns.map(c => meas.map(m => groups.reduce((sum, g) => {
    const cell = (g.subtotal || {})[c];
    return sum + (typeof cell === 'object' && cell !== null ? (cell[m.key] || 0) : (m === meas[0] ? parseFloat(cell || 0) : 0));
  }, 0))) : [];
  const hs = 'background:#1a237e;color:white;padding:7px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.04em';
  const measCols = isPivot
    ? columns.map(c=>`<th style="${hs};text-align:right" colspan="${meas.length}">${escH(stripSortPrefix(c)).split(' / ').join('<br>')}</th>`).join('')
    : meas.map(m=>`<th style="${hs};text-align:right">${escH(m.label)}</th>`).join('');
  const totColTh = showRowTot ? `<th style="${hs};text-align:right;${TD_TOT_BL}" colspan="${meas.length}">Total</th>` : '';
  const staticThs = staticMeasures.map(m => `<th style="${hs};text-align:right;${TD_STAT_BL}">${escH(m.label)}</th>`).join('');
  const thead = `<tr><th style="${hs};text-align:left">Libellé</th>${measCols}${totColTh}${showEvolCol?`<th style="${hs};text-align:right">${escH(evolLabel)}</th>`:''}${staticThs}</tr>`;
  const eStr = ev => ev===null?'—':(ev>=0?'+':'')+ev.toFixed(1)+' %';
  const eCol = ev => ev===null?'#999':ev>=0?'#2e7d32':'#c62828';
  const getPivotValsS = (src, col) => meas.map(m => {
    const cell = src[col];
    if (typeof cell === 'object' && cell !== null) return cell[m.key] || 0;
    return m === meas[0] ? parseFloat(cell || 0) : 0;
  });
  const cEvolCols = firstVals => { if(firstVals.length<2) return null; const l=firstVals[firstVals.length-1],p=firstVals[firstVals.length-2]; return p>0?(l-p)/p*100:null; };
  const cEvolRows = (curr, prev) => { if(prev==null) return null; return prev>0?(curr-prev)/prev*100:null; };
  const inlineEvolBadge = (curr, prev, fs) => {
    if (!(prev > 0)) return `<div style="font-size:${fs};color:#999;margin-top:1px">—</div>`;
    const ev = (curr - prev) / prev * 100;
    return `<div style="font-size:${fs};color:${eCol(ev)};font-weight:600;margin-top:1px">${eStr(ev)}</div>`;
  };
  const renderTdCols = (allVals, baseStyle, brd, fsBadge) => allVals.map((vs, ci) => vs.map((v, mi) => {
    const inline = (showInlineEvol && mi === 0 && ci > 0) ? inlineEvolBadge(v, allVals[ci-1][0], fsBadge) : '';
    return `<td style="${baseStyle};border-bottom:${brd}">${fmtV(v,meas[mi].format)}${inline}</td>`;
  }).join('')).join('');
  const mkStaticTds = (item, brd) => staticMeasures.map(m => {
    const v = item.staticValues?.[m.key] ?? 0;
    return `<td style="padding:6px 8px;text-align:right;font-size:12px;font-weight:600;color:#1565c0;border-bottom:${brd};${TD_STAT_BL}">${fmtV(v, m.format)}</td>`;
  }).join('');
  const BG=['#e8edf8','#eff2fb','#f4f7fd'], PD=[8,6,5], FS=['13px','12px','12px'], FW=['700','600','500'];
  function renderRows(items, lv) {
    const trs=[], ind=12+lv*18;
    let prevSibTotal = null;
    // À ce niveau, l'évolution rows s'applique soit sur les sous-totaux (lv === evolRowLevel)
    // soit sur les feuilles (lv parent immédiat des feuilles, et evolRowLevel === -1).
    const applyRowsEvolHere = isRowsMode && (lv === evolRowLevel);
    items.forEach((item,idx)=>{
      if(item.children!==undefined){
        const bg=BG[Math.min(lv,2)],pd=PD[Math.min(lv,2)],fs=FS[Math.min(lv,2)],fw=FW[Math.min(lv,2)];
        const brd=lv===0?'2px solid #c5cae9':'1px solid #d0d5e8';
        if(isPivot){
          const allVals=columns.map(c=>getPivotValsS(item.subtotal||{},c));
          let ev = null;
          if (evolMode === 'cols') ev = cEvolCols(allVals.map(vs=>vs[0]));
          else if (applyRowsEvolHere) {
            const totalFirst = allVals.reduce((a,vs)=>a+vs[0],0);
            ev = cEvolRows(totalFirst, prevSibTotal);
            prevSibTotal = totalFirst;
          }
          const baseStyle = `padding:${pd}px 8px;font-weight:${fw};font-size:${fs};text-align:right;color:#1a237e`;
          const tdCols = renderTdCols(allVals, baseStyle, brd, '10px');
          const tdTot=showRowTot?meas.map((_,mi)=>`<td style="padding:${pd}px 8px;font-weight:${fw};font-size:${fs};text-align:right;color:#1a237e;border-bottom:${brd};${TD_TOT_BL}">${fmtV(allVals.reduce((a,vs)=>a+vs[mi],0),meas[mi].format)}</td>`).join(''):'';
          trs.push(`<tr style="background:${bg}"><td style="padding:${pd}px 12px ${pd}px ${ind}px;font-weight:${fw};font-size:${fs};color:#1a237e;border-bottom:${brd}">▸ ${escH(stripSortPrefix(fmtDatesInLabel(item.label,dateFormat)))}</td>${tdCols}${tdTot}${showEvolCol?`<td style="padding:${pd}px 12px;font-weight:${fw};font-size:${fs};text-align:right;color:${eCol(ev)};border-bottom:${brd}">${eStr(ev)}</td>`:''}${mkStaticTds(item,brd)}</tr>`);
        }else{
          const tdMeas=meas.map(m=>{
            const v=typeof item.subtotal==='object'&&item.subtotal!==null?(item.subtotal[m.key]||0):item.subtotal;
            return `<td style="padding:${pd}px 12px;font-weight:${fw};font-size:${fs};text-align:right;color:#1a237e;border-bottom:${brd}">${fmtV(v,m.format)}</td>`;
          }).join('');
          trs.push(`<tr style="background:${bg}"><td style="padding:${pd}px 12px ${pd}px ${ind}px;font-weight:${fw};font-size:${fs};color:#1a237e;border-bottom:${brd}">▸ ${escH(stripSortPrefix(fmtDatesInLabel(item.label,dateFormat)))}</td>${tdMeas}${mkStaticTds(item,brd)}</tr>`);
        }
        // children explorés en sous-récursion ; le tracker prevSibTotal de CE niveau ne change pas
        // (tracker propre à chaque appel récursif)
        trs.push(...renderRows(item.children,lv+1));
      }else{
        const bg=idx%2?'#fafafa':'white';
        if(isPivot){
          const allVals=columns.map(c=>getPivotValsS(item.values||{},c));
          let ev = null;
          if (evolMode === 'cols')      ev = cEvolCols(allVals.map(vs=>vs[0]));
          else if (isRowsMode && evolRowLevel === -1) {
            // Mode rows par défaut : évolution entre feuilles
            const totalFirst = allVals.reduce((a,vs)=>a+vs[0],0);
            ev = cEvolRows(totalFirst, prevSibTotal);
            prevSibTotal = totalFirst;
          }
          const baseStyle = 'padding:5px 8px;font-size:12px;text-align:right;color:#1a237e';
          const tdCols = renderTdCols(allVals, baseStyle, '1px solid #eee', '10px');
          const tdTot=showRowTot?meas.map((_,mi)=>`<td style="padding:5px 8px;font-size:12px;text-align:right;color:#1a237e;border-bottom:1px solid #eee;${TD_TOT_BL}">${fmtV(allVals.reduce((a,vs)=>a+vs[mi],0),meas[mi].format)}</td>`).join(''):'';
          trs.push(`<tr style="background:${bg}"><td style="padding:5px 12px 5px ${ind+6}px;font-size:12px;color:#555;border-bottom:1px solid #eee">${escH(stripSortPrefix(fmtDatesInLabel(item.label,dateFormat)))}</td>${tdCols}${tdTot}${showEvolCol?`<td style="padding:5px 12px;font-size:12px;text-align:right;color:${eCol(ev)};border-bottom:1px solid #eee">${eStr(ev)}</td>`:''}${mkStaticTds(item,'1px solid #eee')}</tr>`);
        }else{
          const tdMeas=meas.map(m=>{
            const v=(item.values||{})[m.key]??item.valeur??0;
            return `<td style="padding:5px 12px;font-size:12px;text-align:right;color:#1a237e;border-bottom:1px solid #eee">${fmtV(v,m.format)}</td>`;
          }).join('');
          trs.push(`<tr style="background:${bg}"><td style="padding:5px 12px 5px ${ind+6}px;font-size:12px;color:#555;border-bottom:1px solid #eee">${escH(stripSortPrefix(fmtDatesInLabel(item.label,dateFormat)))}</td>${tdMeas}${mkStaticTds(item,'1px solid #eee')}</tr>`);
        }
      }
    });
    return trs;
  }
  const bodyRows = renderRows(groups,0).join('');
  const footTdCols = colGrandTots.map((mTots, ci) => mTots.map((v, mi) => {
    const inline = (showInlineEvol && mi === 0 && ci > 0) ? inlineEvolBadge(v, colGrandTots[ci-1][0], '10px') : '';
    return `<td style="padding:7px 8px;text-align:right;font-size:12px;font-weight:700;color:#1a237e;white-space:nowrap">${fmtV(v,meas[mi].format)}${inline}</td>`;
  }).join('')).join('');
  const footRow = showColTot && isPivot ? `<tr style="background:#e8edf8;border-top:2px solid #c5cae9">
    <td style="padding:7px 12px;font-size:12px;font-weight:700;color:#1a237e">Total</td>
    ${footTdCols}
    ${showRowTot?meas.map((m,mi)=>`<td style="padding:7px 8px;text-align:right;font-size:12px;font-weight:700;color:#1a237e;white-space:nowrap;${TD_TOT_BL}">${fmtV(colGrandTots.reduce((a,ct)=>a+ct[mi],0),m.format)}</td>`).join(''):''}
    ${showEvolCol?'<td></td>':''}
    ${staticMeasures.map(()=>`<td style="${TD_STAT_BL}"></td>`).join('')}
  </tr>` : '';
  return `<table style="width:100%;border-collapse:collapse;margin-top:4px">${thead}${bodyRows}${footRow}</table>`;
}


function escH(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const MOIS_COURT = ['jan.','fév.','mar.','avr.','mai','jun.','jul.','aoû.','sep.','oct.','nov.','déc.'];
const MOIS_LONG  = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
function fmtDate(val, fmt) {
  if (!val) return '';
  const d = new Date(typeof val === 'string' && val.length === 10 ? val + 'T00:00:00' : val);
  if (isNaN(d)) return String(val);
  const dd   = String(d.getDate()).padStart(2,'0');
  const mm   = String(d.getMonth()+1).padStart(2,'0');
  const yy   = String(d.getFullYear()).slice(2);
  const yyyy = String(d.getFullYear());
  switch (fmt || 'DD/MM/YYYY') {
    case 'DD/MM/YYYY':    return `${dd}/${mm}/${yyyy}`;
    case 'DD/MM/YY':      return `${dd}/${mm}/${yy}`;
    case 'DD-MM-YYYY':    return `${dd}-${mm}-${yyyy}`;
    case 'YYYY-MM-DD':    return `${yyyy}-${mm}-${dd}`;
    case 'DD MMM YYYY':   return `${dd} ${MOIS_COURT[d.getMonth()]} ${yyyy}`;
    case 'DD MMMM YYYY':  return `${dd} ${MOIS_LONG[d.getMonth()]} ${yyyy}`;
    default:              return `${dd}/${mm}/${yyyy}`;
  }
}
function fmtDatesInLabel(str, fmt) {
  if (!str) return str;
  return String(str).replace(/\d{4}-\d{2}-\d{2}/g, d => fmtDate(d, fmt));
}

function fmtV(val, fmt) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return escH(String(val));
  const f = (v, d=0) => new Intl.NumberFormat('fr-FR',{minimumFractionDigits:d,maximumFractionDigits:d}).format(v);
  if (fmt === 'euro')    return f(n) + '&nbsp;€';
  if (fmt === 'qty')     return f(n);
  if (fmt === 'percent') return (n >= 0 ? '+' : '') + f(n,1) + '&nbsp;%';
  if (fmt === 'integer') return f(n);
  return f(n, 2);
}

function kpiHTML(rows) {
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px">${
    rows.map(r => `<div style="background:#e8edf8;border-left:3px solid #1565c0;padding:12px 16px;border-radius:4px;min-width:140px">
      <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.04em">${escH(r.label)}</div>
      <div style="font-size:20px;font-weight:700;color:#1a237e;margin-top:4px">${fmtV(r.valeur, r.format)}</div>
    </div>`).join('')
  }</div>`;
}

function pivotHTML(data, dateFormat, widget) {
  if (!data?.rows?.length) return '<p style="color:#999;font-size:13px">Aucune donnée</p>';
  const { columns, rows, measures, staticMeasures = [] } = data;
  const meas = measures || [{key:'_v', label:'Valeur', format:'euro'}];
  const evolMode = widget?.evolMode || 'cols';   // 'cols' | 'each_col' | 'rows' | 'each_col_rows' | 'off'
  const isRowsMode = (evolMode === 'rows' || evolMode === 'each_col_rows');
  const showEvolCol = (evolMode === 'cols' && columns.length >= 2) || isRowsMode;
  const showInlineEvol = (evolMode === 'each_col' || evolMode === 'each_col_rows') && columns.length >= 2;
  const showEvol = showEvolCol;
  const evolHdrLabel = isRowsMode ? 'Évol. (vs préc.)' : 'Évol.';
  const totOpt = widget?.showTotals || false;
  const showRowTot = totOpt === 'rows' || totOpt === 'both';
  const showColTot = totOpt === 'cols' || totOpt === 'both';
  const colTots = columns.map(() => meas.map(() => 0));
  const TH = 'background:#1a237e;color:white;padding:7px 12px;text-align:right;font-size:11px';
  const TH_TOT = `${TH};border-left:2px solid rgba(255,255,255,.3)`;
  const TD_TOT_BL = 'border-left:2px solid #c5cae9';
  const thCols = columns.map(c =>
    `<th style="${TH}" colspan="${meas.length}">${escH(stripSortPrefix(c)).split(' / ').join('<br>')}</th>`
  ).join('');
  const thTot = showRowTot ? `<th style="${TH_TOT}" colspan="${meas.length}">Total</th>` : '';
  const thMeas = columns.map(() => meas.map(m =>
    `<th style="background:#283593;color:#b3c4f8;padding:4px 8px;text-align:right;font-size:10px">${escH(m.label)}</th>`
  ).join('')).join('') + (showRowTot ? meas.map(m =>
    `<th style="background:#283593;color:#b3c4f8;padding:4px 8px;text-align:right;font-size:10px;${TD_TOT_BL}">${escH(m.label)}</th>`
  ).join('') : '');
  let prevRowTotalFirst = null;
  const trs = rows.map((row, i) => {
    const allVals = columns.map((c, ci) => {
      const cell = row.values[c];
      if (cell === undefined || cell === null) return meas.map(() => null);
      const vs = meas.map(m => typeof cell === 'object' ? (cell[m.key] ?? 0) : parseFloat(cell));
      if (showColTot) vs.forEach((v, mi) => { if (v !== null) colTots[ci][mi] += v; });
      return vs;
    });
    const inlineDelta = (curr, prev) => {
      if (!(prev > 0) || curr === null) return `<div style="font-size:10px;color:#999;margin-top:1px">—</div>`;
      const ev = (curr - prev) / prev * 100;
      const col = ev>=0?'#2e7d32':'#c62828';
      return `<div style="font-size:10px;color:${col};font-weight:600;margin-top:1px">${(ev>=0?'+':'')+ev.toFixed(1)+' %'}</div>`;
    };
    const tdCols = allVals.map((vs, ci) => vs.map((v, mi) => {
      const inline = (showInlineEvol && mi === 0 && ci > 0) ? inlineDelta(v, allVals[ci-1][0]) : '';
      return v === null
        ? `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px;color:#999">—${inline}</td>`
        : `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;font-size:12px;font-weight:600;color:#1a237e">${fmtV(v, meas[mi].format)}${inline}</td>`;
    }).join('')).join('');
    const tdTot = showRowTot ? meas.map((m, mi) => {
      const tot = allVals.reduce((a, vs) => a + (vs[mi] ?? 0), 0);
      return `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;font-size:12px;font-weight:700;color:#1a237e;${TD_TOT_BL}">${fmtV(tot, m.format)}</td>`;
    }).join('') : '';
    let tdEvol = '';
    if (showEvolCol) {
      let ev = null;
      if (evolMode === 'cols') {
        const lc = row.values[columns[columns.length-1]], pc = row.values[columns[columns.length-2]];
        const l = typeof lc==='object' ? (lc[meas[0].key]||0) : parseFloat(lc||0);
        const p = typeof pc==='object' ? (pc[meas[0].key]||0) : parseFloat(pc||0);
        ev = p > 0 ? ((l-p)/p*100) : null;
      } else if (isRowsMode) {
        const tot = allVals.reduce((a, vs) => a + ((vs[0] ?? 0)), 0);
        ev = (prevRowTotalFirst != null && prevRowTotalFirst > 0) ? ((tot-prevRowTotalFirst)/prevRowTotalFirst*100) : null;
        prevRowTotalFirst = tot;
      }
      tdEvol = `<td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-size:12px;color:${ev===null?'#999':ev>=0?'#2e7d32':'#c62828'};font-weight:600">${ev===null?'—':(ev>=0?'+':'')+ev.toFixed(1)+' %'}</td>`;
    }
    const tdStatic = staticMeasures.map(m => {
      const v = row.staticValues?.[m.key] ?? 0;
      return `<td style="padding:6px 8px;border-bottom:1px solid #eee;border-left:2px solid #c5cae9;text-align:right;white-space:nowrap;font-size:12px;font-weight:600;color:#1565c0">${fmtV(v, m.format)}</td>`;
    }).join('');
    return `<tr style="background:${i%2?'#fafafa':'white'}">
      <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px">${escH(stripSortPrefix(fmtDatesInLabel(row.label,dateFormat)))}</td>
      ${tdCols}${tdTot}${tdEvol}${tdStatic}
    </tr>`;
  }).join('');
  const footTdCols = colTots.map((mTots, ci) => mTots.map((v, mi) => {
    let inline = '';
    if (showInlineEvol && mi === 0 && ci > 0) {
      const prev = colTots[ci-1][0];
      if (prev > 0) {
        const ev = (v - prev) / prev * 100;
        inline = `<div style="font-size:10px;color:${ev>=0?'#2e7d32':'#c62828'};font-weight:600;margin-top:1px">${(ev>=0?'+':'')+ev.toFixed(1)+' %'}</div>`;
      } else {
        inline = `<div style="font-size:10px;color:#999;margin-top:1px">—</div>`;
      }
    }
    return `<td style="padding:7px 8px;text-align:right;font-size:12px;font-weight:700;color:#1a237e;white-space:nowrap">${fmtV(v,meas[mi].format)}${inline}</td>`;
  }).join('')).join('');
  const footRow = showColTot ? `<tr style="background:#e8edf8;border-top:2px solid #c5cae9">
    <td style="padding:7px 12px;font-size:12px;font-weight:700;color:#1a237e">Total</td>
    ${footTdCols}
    ${showRowTot?meas.map((m,mi)=>`<td style="padding:7px 8px;text-align:right;font-size:12px;font-weight:700;color:#1a237e;white-space:nowrap;${TD_TOT_BL}">${fmtV(colTots.reduce((a,ct)=>a+ct[mi],0),m.format)}</td>`).join(''):''}
    ${showEvolCol?'<td></td>':''}
    ${staticMeasures.map(()=>'<td style="border-left:2px solid #c5cae9"></td>').join('')}
  </tr>` : '';
  const hasSubRow = meas.length > 1;
  const thStatic = staticMeasures.map(m =>
    `<th style="${TH};border-left:2px solid rgba(255,255,255,.4)" rowspan="${hasSubRow?2:1}">${escH(m.label)}</th>`
  ).join('');
  return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;margin-top:4px">
    <tr>
      <th style="background:#1a237e;color:white;padding:7px 12px;text-align:left;font-size:11px" rowspan="${hasSubRow?2:1}">Libellé</th>
      ${thCols}${thTot}${showEvolCol?`<th style="${TH}" rowspan="${hasSubRow?2:1}">${escH(evolHdrLabel)}</th>`:''}${thStatic}
    </tr>
    ${hasSubRow ? `<tr>${thMeas}</tr>` : ''}
    ${trs}${footRow}
  </table></div>`;
}

function tableHTML(data, dateFormat, widget) {
  // data: {measures:[...], rows:[{label, values:{...}}]} or old [{label,valeur,format}]
  const rows = Array.isArray(data) ? data : (data.rows || []);
  if (!rows.length) return '<p style="color:#999;font-size:13px;padding:8px 0">Aucune donnée</p>';
  const measures = Array.isArray(data) ? null : data.measures;
  if (measures && measures.length > 0) {
    const totOpt = widget?.showTotals || false;
    const showColTot = totOpt === 'cols' || totOpt === 'both';
    const measTots = measures.map(() => 0);
    const ths = measures.map(m => `<th style="background:#1a237e;color:white;padding:7px 12px;text-align:right;font-size:11px">${escH(m.label)}</th>`).join('');
    const trs = rows.map((r, i) => {
      if (showColTot) measures.forEach((m, mi) => { measTots[mi] += r.values[m.key] || 0; });
      const tds = measures.map(m => `<td style="padding:6px 12px;font-size:13px;text-align:right;font-weight:600;color:#1a237e;border-bottom:1px solid #eee;white-space:nowrap">${fmtV(r.values[m.key], m.format)}</td>`).join('');
      return `<tr style="background:${i%2?'#fafafa':'white'}"><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #eee">${escH(stripSortPrefix(fmtDatesInLabel(r.label,dateFormat)))}</td>${tds}</tr>`;
    }).join('');
    const footRow = showColTot ? `<tr style="background:#e8edf8;border-top:2px solid #c5cae9"><td style="padding:7px 12px;font-size:12px;font-weight:700;color:#1a237e">Total</td>${measTots.map((v,i)=>`<td style="padding:7px 12px;font-size:12px;font-weight:700;text-align:right;color:#1a237e;white-space:nowrap">${fmtV(v,measures[i].format)}</td>`).join('')}</tr>` : '';
    return `<table style="width:100%;border-collapse:collapse;margin-top:4px">
      <tr><th style="background:#1a237e;color:white;padding:7px 12px;text-align:left;font-size:11px">Libellé</th>${ths}</tr>${trs}${footRow}</table>`;
  }
  const max = Math.max(...rows.map(r => parseFloat(r.valeur) || 0), 1);
  const trs = rows.map((r, i) => {
    const pct = Math.round((parseFloat(r.valeur)||0) / max * 100);
    return `<tr style="background:${i%2?'#fafafa':'white'}">
      <td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #eee">${escH(stripSortPrefix(fmtDatesInLabel(r.label,dateFormat)))}</td>
      <td style="padding:6px 12px;font-size:13px;text-align:right;white-space:nowrap;border-bottom:1px solid #eee;font-weight:600;color:#1a237e">${fmtV(r.valeur, r.format)}</td>
      <td style="padding:6px 12px;width:160px;border-bottom:1px solid #eee">
        <div style="background:#e3f2fd;height:10px;border-radius:2px"><div style="background:#1565c0;height:10px;border-radius:2px;width:${pct}%"></div></div>
      </td></tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse;margin-top:4px">
    <tr><th style="background:#1a237e;color:white;padding:7px 12px;text-align:left;font-size:11px">Libellé</th>
        <th style="background:#1a237e;color:white;padding:7px 12px;text-align:right;font-size:11px">Valeur</th>
        <th style="background:#1a237e;color:white;padding:7px 12px;font-size:11px"></th></tr>
    ${trs}</table>`;
}

const CHART_COLORS = ['#2196F3','#4CAF50','#FF9800','#9C27B0','#F44336','#00BCD4','#FF5722','#607D8B'];

function buildChartConfig(data, widget) {
  const chartType     = widget.chartType || 'bar';
  const seriesBy      = widget.chartSeriesBy || 'measure';
  const chartMeasures = widget.chartMeasures?.length ? widget.chartMeasures
    : (widget.chartMeasure ? [widget.chartMeasure] : null);

  const resolveMeas = available => {
    if (chartMeasures?.length) return chartMeasures.map(k => available?.find(m => m.key === k)).filter(Boolean);
    return (available || []).filter(Boolean);
  };
  const getPivotCell = (src, col, measKey) => {
    const cell = (src || {})[col];
    if (cell == null) return 0;
    return typeof cell === 'object' ? (cell[measKey] || 0) : parseFloat(cell || 0);
  };

  let labels = [], datasets = [];

  if (data.type === 'pivot') {
    labels = data.columns || [];
    if (seriesBy === 'row') {
      const meas = resolveMeas(data.measures)[0] || data.measures?.[0];
      datasets = (data.rows || []).map(row => ({
        label: row.label || '',
        data: labels.map(col => getPivotCell(row.values, col, meas?.key))
      }));
    } else {
      const measList = resolveMeas(data.measures).length ? resolveMeas(data.measures) : [data.measures?.[0]].filter(Boolean);
      datasets = measList.map(meas => ({
        label: meas.label,
        data: labels.map(col =>
          (data.rows || []).reduce((sum, r) => sum + getPivotCell(r.values, col, meas.key), 0)
        )
      }));
    }
  } else if (data.type === 'grouped' && data.groups) {
    const measList = resolveMeas(data.measures).length ? resolveMeas(data.measures) : [{ key: 'ca', label: 'CA' }];
    if (seriesBy === 'row' && Array.isArray(data.columns) && data.columns.length) {
      labels = data.columns;
      const meas = measList[0];
      datasets = data.groups.map(g => ({
        label: g.label || '',
        data: labels.map(col => getPivotCell(g.subtotal, col, meas?.key))
      }));
    } else {
      labels = data.groups.map(g => g.label || '');
      datasets = measList.map(meas => ({
        label: meas.label,
        data: data.groups.map(g => {
          const sub = g.subtotal || {};
          if (meas.key in sub) return sub[meas.key] || 0;
          return Object.values(sub).reduce((s, v) => s + (typeof v === 'object' ? (v[meas.key] || 0) : 0), 0);
        })
      }));
    }
  } else if (data.measures && data.rows) {
    const measList = resolveMeas(data.measures).filter(Boolean);
    const activeMeas = measList.length ? measList : [data.measures[0]].filter(Boolean);
    const xAxis = widget.chartXAxis;
    const hasConcat = xAxis && data.rows.some(r => (r.label || '').includes(' / '));
    if (hasConcat) {
      const dims = [...(widget.ruptures || []), ...(widget.detailDims || []), ...(widget.pivotCols || [])];
      const xIdx = dims.indexOf(xAxis);
      const getKey = lbl => { const p = (lbl ?? '').split(' / '); return (xIdx >= 0 && xIdx < p.length) ? p[xIdx] : p[0]; };
      const grouped = new Map();
      data.rows.forEach(r => {
        const key = getKey(r.label);
        if (!grouped.has(key)) grouped.set(key, Object.fromEntries(activeMeas.map(m => [m.key, 0])));
        activeMeas.forEach(m => { grouped.get(key)[m.key] += r.values[m.key] || 0; });
      });
      labels = [...grouped.keys()];
      datasets = activeMeas.map(m => ({ label: m.label, data: [...grouped.values()].map(g => g[m.key] || 0) }));
    } else {
      labels = data.rows.map(r => r.label || (r.dimVals?.[0] ?? ''));
      datasets = activeMeas.map(meas => ({
        label: meas.label,
        data: data.rows.map(r => r.values?.[meas.key] || 0)
      }));
    }
  } else if (Array.isArray(data)) {
    labels = data.map(r => r.label || '');
    datasets = [{ label: 'Valeur', data: data.map(r => parseFloat(r.valeur) || 0) }];
  } else {
    return null;
  }

  if (!labels.length) return null;

  const isDoughnut  = chartType === 'doughnut' || chartType === 'pie';
  const effectiveType = chartType === 'area' ? 'line' : chartType;
  const useY2 = !isDoughnut && datasets.length >= 2 && (() => {
    const maxes = datasets.map(ds => Math.max(...(ds.data || []).map(Math.abs).filter(v => v > 0)));
    const valid = maxes.filter(v => v > 0);
    return valid.length >= 2 && (Math.max(...valid) / Math.min(...valid)) > 10;
  })();

  const coloredDatasets = isDoughnut
    ? [{ data: datasets[0]?.data || [], backgroundColor: labels.map((_, j) => CHART_COLORS[j % CHART_COLORS.length]) }]
    : datasets.map((ds, i) => ({
        ...ds,
        backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + (chartType === 'line' ? '33' : 'cc'),
        borderColor: CHART_COLORS[i % CHART_COLORS.length],
        borderWidth: chartType === 'line' ? 2 : 1,
        fill: chartType === 'area',
        tension: 0.3,
        yAxisID: useY2 && i > 0 ? 'y2' : 'y'
      }));

  const scaleBase = { ticks: { font: { size: 10 }, color: '#555' }, grid: { color: '#e8eaf0' } };
  return {
    type: effectiveType,
    data: { labels, datasets: coloredDatasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 14 } } },
      scales: isDoughnut ? {} : {
        x:  { ...scaleBase, ticks: { ...scaleBase.ticks, maxRotation: 45 } },
        y:  { ...scaleBase, beginAtZero: true, position: 'left' },
        ...(useY2 ? { y2: { ...scaleBase, beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } } : {})
      }
    }
  };
}

function chartHTML(data, widget) {
  const config = buildChartConfig(data, widget);
  if (!config) return '<p style="color:#999;font-size:13px">Aucune donnée</p>';
  const chartId = 'ch_' + Math.random().toString(36).slice(2, 9);
  return `<div style="position:relative;width:100%;height:300px">
    <canvas id="${chartId}"></canvas>
  </div>
  <script>(function(){var c=document.getElementById('${chartId}');if(c)new Chart(c,${JSON.stringify(config)});})()</script>`;
}

let _puppeteerBrowser = null;
async function getPuppeteer() {
  if (!_puppeteerBrowser || !_puppeteerBrowser.connected) {
    const puppeteer = require('puppeteer');
    _puppeteerBrowser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu'] });
  }
  return _puppeteerBrowser;
}

async function renderChartToImage(data, widget, widthPx = 800, heightPx = 380) {
  const config = buildChartConfig(data, widget);
  if (!config) return null;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  </head><body style="margin:0;padding:8px;background:white">
    <canvas id="c" width="${widthPx - 16}" height="${heightPx - 16}"></canvas>
    <script>new Chart(document.getElementById('c'),${JSON.stringify(config)})</script>
  </body></html>`;
  const browser = await getPuppeteer();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: widthPx, height: heightPx });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('c') !== null, { timeout: 5000 });
    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: widthPx, height: heightPx } });
    return buf;
  } finally {
    await page.close();
  }
}

async function buildHTML(report, filterParams = {}) {
  const now = new Date();
  const settingsPath = path.join(__dirname, '../../data/settings.json');
  let dateFormat = 'DD/MM/YYYY';
  try { dateFormat = JSON.parse(require('fs').readFileSync(settingsPath,'utf8'))?.app?.dateFormat || dateFormat; } catch {}
  const HTML_TIME_DIMS = new Set(['time_annee','time_mois','time_mois_lib','time_anneemois','time_semaine','time_jour','time_date']);
  // Sociétés des bases sélectionnées (mono ou multi) — affichées dans l'en-tête
  let societesLabel = '';
  try {
    const dbsForSoc = filterParams.dbs || report.dbs || undefined;
    const userInfo = { database: filterParams._userDatabase, connId: filterParams._userConnId };
    const socs = await getDbsSocietes(dbsForSoc, userInfo);
    societesLabel = socs.map(s => s.societe).filter(Boolean).join(' / ');
  } catch { societesLabel = ''; }
  const sections = [];
  for (const widget of (report.widgets || [])) {
    const src = SOURCES[widget.source];
    let rows = [];
    try {
      const wParams = { ...(report.dbs ? { ...widget.params, dbs: report.dbs } : (widget.params || {})), ...filterParams };
      if (src) {
        rows = await src.fetch(wParams);
      } else {
        const isPureChart  = widget.displayType === 'chart';
        const isChart      = isPureChart || widget.displayType === 'table-chart';
        const effectiveDims = widget.dimensions?.length > 0 ? widget.dimensions : [];
        const firstNonTime  = effectiveDims.find(d => !HTML_TIME_DIMS.has(d)) || null;
        const xAxisDim      = widget.chartXAxis || (isPureChart ? firstNonTime : null);
        const measures      = isChart && widget.chartMeasures?.length ? widget.chartMeasures : widget.measures;
        const effectivePivot = widget.pivot !== false && ((widget.pivot || false) || (widget.pivotCols?.length > 0));
        const ruptures = isPureChart && !effectivePivot
          ? (xAxisDim ? [xAxisDim] : [])
          : (() => {
              const base = widget.ruptures || [];
              if (!effectivePivot && xAxisDim && !base.includes(xAxisDim)) return [xAxisDim, ...base];
              return base;
            })();
        const overrideDims = widget.dimensions?.length > 0 ? widget.dimensions : null;
        const cs = readCSources().find(c => c.id === widget.source);
        const vcs = { id: '_auto', dimensions: [], measures: measures || ['ca'], filters: {}, limit: 500 };
        const execCs = cs || (overrideDims ? vcs : null);
        if (!execCs) continue;
        rows = await executeCustomSource(execCs, wParams, measures,
          { ruptures, pivot: effectivePivot, pivotCols: widget.pivotCols || [],
            sortDir: widget.sortDir, sortBy: widget.sortBy, topN: widget.topN },
          overrideDims);
      }
    } catch(e) { rows = []; }
    const isChart   = widget.displayType === 'chart' || widget.displayType === 'table-chart';
    const chartOnly = widget.displayType === 'chart';
    const content = rows?.type === 'grouped' && !isChart ? groupedHTML(rows, dateFormat, widget)
                  : rows?.type === 'pivot'   && !isChart ? pivotHTML(rows, dateFormat, widget)
                  : src?.displayType === 'kpi' ? kpiHTML(rows)
                  : isChart ? (
                      chartHTML(rows, widget) +
                      (chartOnly ? '' : '<div style="margin-top:16px;overflow-x:auto">' +
                        (rows?.type === 'grouped' ? groupedHTML(rows, dateFormat, widget)
                        : rows?.type === 'pivot'  ? pivotHTML(rows, dateFormat, widget)
                        : tableHTML(rows, dateFormat, widget)) + '</div>')
                    )
                  : tableHTML(rows, dateFormat, widget);
    sections.push(`<div style="padding:18px 30px;border-bottom:1px solid #e8eaf0">
      <div style="font-size:11px;font-weight:700;color:#1a237e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;padding-bottom:7px;border-bottom:1px solid #e8eaf0">${escH(widget.title || src?.label || widget.source)}</div>
      <div style="overflow-x:auto">${content}</div>
    </div>`);
  }
  const hasCharts = (report.widgets || []).some(w => w.displayType === 'chart' || w.displayType === 'table-chart');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${hasCharts ? '<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>' : ''}</head>
  <body style="margin:0;padding:20px;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:1200px;margin:0 auto;background:white;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#1a237e,#283593);padding:24px 30px">
      ${societesLabel ? `<div style="color:rgba(255,255,255,.92);font-size:13px;font-weight:600;margin-bottom:6px;letter-spacing:.02em">${escH(societesLabel)}</div>` : ''}
      <div style="color:white;font-size:20px;font-weight:700">${escH(report.name)}</div>
      ${report.description ? `<div style="color:rgba(255,255,255,.75);font-size:12px;margin-top:4px">${escH(report.description)}</div>` : ''}
      <div style="color:rgba(255,255,255,.55);font-size:11px;margin-top:8px">Généré le ${fmtDate(now, dateFormat)} à ${now.toLocaleTimeString('fr-FR')}</div>
    </div>
    ${sections.length ? sections.join('') : '<div style="padding:30px;color:#999;text-align:center;font-size:13px">Aucun widget configuré</div>'}
    <div style="padding:12px 30px;background:#f8f9fa;font-size:11px;color:#aaa;text-align:center">TB Reporting — rapport automatique</div>
  </div></body></html>`;
}

// ── Email ──────────────────────────────────────────────────────────────────────

async function sendEmail(to, subject, html, attachments) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) throw new Error('SMTP non configuré dans .env');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    family: 4
  });
  const opts = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html
  };
  if (Array.isArray(attachments) && attachments.length) opts.attachments = attachments;
  await transporter.sendMail(opts);
}

// Génère un PDF d'un rapport/dashboard custom à partir du HTML rendu
async function buildPdfForItem(item, fp = {}) {
  const html = await buildHTML(item, fp);
  const browser = await getPuppeteer();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    return await page.pdf({
      format: 'A4', landscape: false, printBackground: true,
      margin: { top:'15mm', bottom:'15mm', left:'10mm', right:'10mm' },
    });
  } finally {
    await page.close().catch(()=>{});
  }
}

// Construit un email pour un rapport custom (HTML inline / Excel PJ / PDF PJ) selon le format demandé
async function buildReportMailPayload(report, format, fp = {}) {
  const fmt = (format || 'html').toLowerCase();
  const dateStr = new Date().toISOString().slice(0,10);
  const safeName = (report.name || 'rapport').replace(/[^a-zA-Z0-9_\- ]/g,'_');
  if (fmt === 'excel') {
    const wb = await buildExcelForItem(report, fp);
    const buf = await wb.xlsx.writeBuffer();
    return {
      html: `<p>Bonjour,</p><p>Veuillez trouver ci-joint le rapport <strong>${escH(report.name||'')}</strong> au format Excel.</p>`,
      attachments: [{ filename: `${safeName}-${dateStr}.xlsx`, content: Buffer.from(buf), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    };
  }
  if (fmt === 'pdf') {
    const buf = await buildPdfForItem(report, fp);
    return {
      html: `<p>Bonjour,</p><p>Veuillez trouver ci-joint le rapport <strong>${escH(report.name||'')}</strong> au format PDF.</p>`,
      attachments: [{ filename: `${safeName}-${dateStr}.pdf`, content: buf, contentType: 'application/pdf' }],
    };
  }
  return { html: await buildHTML(report, fp), attachments: [] };
}

// ── Cron ───────────────────────────────────────────────────────────────────────

// Retourne le tableau de planifications (supporte l'ancien format schedule:{})
function getSchedules(report) {
  if (Array.isArray(report.schedules)) return report.schedules;
  if (report.schedule?.cron) return [{ id: 's0', ...report.schedule }];
  return [];
}

function stopReportJobs(reportId) {
  for (const [key, job] of activeJobs.entries()) {
    if (key === reportId || key.startsWith(reportId + ':')) { job.stop(); activeJobs.delete(key); }
  }
}

function startJobs(report) {
  stopReportJobs(report.id);
  getSchedules(report).forEach(sched => {
    if (!sched.enabled || !sched.cron) return;
    if (!cron.validate(sched.cron)) { console.warn(`[CRON] Expression invalide (${report.id}/${sched.id}): ${sched.cron}`); return; }
    const key = `${report.id}:${sched.id}`;
    const job = cron.schedule(sched.cron, async () => {
      const current = readReports().find(r => r.id === report.id);
      if (!current) return;
      const curSched = getSchedules(current).find(s => s.id === sched.id);
      if (!curSched?.enabled) return;
      try {
        const fmt = curSched.format || 'html';
        const subject = (curSched.subject && curSched.subject.trim()) || current.name;
        const payload = await buildReportMailPayload(current, fmt);
        const dest = curSched.recipients || current.recipients || [];
        if (dest.length) await sendEmail(dest, subject, payload.html, payload.attachments);
        console.log(`[CRON] Rapport "${current.name}" (${sched.id}) envoyé à ${Array.isArray(dest)?dest.join(', '):dest} | format: ${fmt}`);
      } catch(e) { console.error(`[CRON] Rapport ${report.id}/${sched.id}:`, e.message); }
    });
    activeJobs.set(key, job);
  });
}

function setupCronJobs() {
  readReports().forEach(r => startJobs(r));
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get('/sources', (req, res) => {
  const predefined = Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label, displayType: s.displayType, paramDefs: s.paramDefs }));
  const custom = readCSources().map(cs => ({
    id: cs.id, label: `⚡ ${cs.name}`, displayType: 'table', isCustom: true,
    dimensions: cs.dimensions || [], collapsible: !!cs.collapsible,
    paramDefs: [
      { key: 'annee', label: 'Année',    placeholder: cs.filters?.annee  || '{{year}}' },
      { key: 'mois',  label: 'Mois',     placeholder: cs.filters?.mois   || '' },
      { key: 'repid', label: 'ID Commercial', placeholder: cs.filters?.repid || '' }
    ]
  }));
  res.json([...predefined, ...custom]);
});

router.get('/dimensions', (req, res) => {
  const all = getActiveDimensions();
  res.json(Object.entries(all).map(([id, d]) => {
    const bm = BUILTIN_DIM_MAP[id];
    return { id, label: d.label, group: d.group, level: d.level,
      ...(bm ? { tableKey: bm.tableKey, column: bm.column, builtin: true } : {}) };
  }));
});

router.get('/schema', async (req, res) => {
  try {
    const pool = await getUserPool(req.user);
    const tables = [...new Set(Object.values(JOINABLE_TABLES).map(t => t.physTable))];
    const placeholders = tables.map((_, i) => `@t${i}`).join(',');
    const req2 = pool.request();
    tables.forEach((t, i) => req2.input(`t${i}`, t));
    // sys.columns + sys.objects retourne TOUTES les colonnes (INFORMATION_SCHEMA peut être incomplet)
    const result = await req2.query(`
      SELECT o.name AS TABLE_NAME, c.name AS COLUMN_NAME, tp.name AS DATA_TYPE
      FROM sys.columns c
      JOIN sys.objects o  ON o.object_id = c.object_id
      JOIN sys.types  tp ON tp.user_type_id = c.user_type_id
      WHERE o.name IN (${placeholders}) AND o.type = 'U'
      ORDER BY o.name, c.column_id
    `);
    const schema = {};
    for (const row of result.recordset) {
      if (!schema[row.TABLE_NAME]) schema[row.TABLE_NAME] = [];
      schema[row.TABLE_NAME].push({ column: row.COLUMN_NAME, type: row.DATA_TYPE });
    }
    res.json(schema);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/custom-dimensions', (req, res) => {
  res.json(readCustomDims());
});

router.put('/custom-dimensions', (req, res) => {
  const dims = req.body;
  if (!Array.isArray(dims)) return res.status(400).json({ error: 'Array expected' });
  writeCustomDims(dims);
  res.json({ ok: true, count: dims.length });
});

router.get('/dimension-values', async (req, res) => {
  const { dim, db } = req.query;
  const poolFn = () => (!db || db === 'default') ? getUserPool(req.user) : getConnPool(db);

  // 0. Dims temps : valeurs distinctes depuis PIECEVENTES (sans dépendre de DIM_FILTERS)
  if (dim === 'time_annee') {
    try {
      const pool = await poolFn();
      const result = await pool.request().query(
        `SELECT DISTINCT YEAR(PCVDATEEFFET) AS y FROM PIECEVENTES WITH (NOLOCK) WHERE PCVDATEEFFET IS NOT NULL ORDER BY y DESC`);
      return res.json(result.recordset.map(r => ({ id: String(r.y), libelle: String(r.y) })));
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }
  if (dim === 'time_mois') {
    const MOIS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
    return res.json(MOIS.map((nm, i) => ({ id: String(i+1), libelle: `${String(i+1).padStart(2,'0')} - ${nm}` })));
  }
  if (dim === 'time_anneemois') {
    try {
      const pool = await poolFn();
      const result = await pool.request().query(
        `SELECT DISTINCT FORMAT(PCVDATEEFFET,'yyyy-MM') AS ym FROM PIECEVENTES WITH (NOLOCK) WHERE PCVDATEEFFET IS NOT NULL ORDER BY ym DESC`);
      return res.json(result.recordset.map(r => ({ id: r.ym, libelle: r.ym })));
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }
  if (dim === 'time_trimestre') {
    try {
      const pool = await poolFn();
      const result = await pool.request().query(
        `SELECT DISTINCT CAST(YEAR(PCVDATEEFFET) AS VARCHAR(4))+'-T'+CAST(DATEPART(q,PCVDATEEFFET) AS VARCHAR(1)) AS q FROM PIECEVENTES WITH (NOLOCK) WHERE PCVDATEEFFET IS NOT NULL ORDER BY q DESC`);
      return res.json(result.recordset.map(r => ({ id: r.q, libelle: r.q })));
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // 1. DIM_FILTERS avec valueQuery définie
  const df = DIM_FILTERS[dim];
  if (df?.valueQuery) {
    try {
      const pool = await poolFn();
      const result = await pool.request().query(df.valueQuery);
      return res.json(result.recordset.map(r => ({ id: String(r.id), libelle: r.libelle })));
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // 2. BUILTIN_DIM_MAP → SELECT DISTINCT sur la table physique
  const bm = BUILTIN_DIM_MAP[dim];
  if (bm) {
    const jt = JOINABLE_TABLES[bm.tableKey];
    if (!jt) return res.status(404).json({ error: 'Table inconnue' });
    try {
      const pool = await poolFn();
      const extraWhere = jt.dimFilter ? ` AND ${jt.dimFilter}` : '';
      const sql = `SELECT DISTINCT TOP 500 RTRIM([${bm.column}]) AS val FROM [${jt.physTable}] WHERE [${bm.column}] IS NOT NULL AND LEN(RTRIM([${bm.column}]))>0${extraWhere} ORDER BY val`;
      const result = await pool.request().query(sql);
      return res.json(result.recordset.map(r => ({ id: r.val, libelle: r.val })));
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // 3. Dimensions custom avec tableKey + column
  const customDims = readCustomDims();
  const cd = customDims.find(d => d.id === dim);
  if (cd?.tableKey && cd?.column && /^[A-Za-z0-9_]+$/.test(cd.column)) {
    const jt = JOINABLE_TABLES[cd.tableKey];
    if (!jt) return res.status(404).json({ error: 'Table inconnue' });
    try {
      const pool = await poolFn();
      const sql = `SELECT DISTINCT TOP 500 RTRIM(CAST([${cd.column}] AS NVARCHAR(500))) AS val FROM [${jt.physTable}] WHERE [${cd.column}] IS NOT NULL AND LEN(RTRIM(CAST([${cd.column}] AS NVARCHAR(500))))>0 ORDER BY val`;
      const result = await pool.request().query(sql);
      return res.json(result.recordset.map(r => ({ id: r.val, libelle: r.val })));
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(404).json({ error: 'Dimension sans valeurs disponibles' });
});

router.get('/custom-sources', (req, res) => res.json(readCSources()));

router.get('/custom-sources/:id', (req, res) => {
  const cs = readCSources().find(c => c.id === req.params.id);
  if (!cs) return res.status(404).json({ error: 'Introuvable' });
  res.json(cs);
});

router.post('/custom-sources', (req, res) => {
  const list = readCSources();
  const cs   = { id: genId(), createdAt: new Date().toISOString(), ...req.body };
  list.push(cs); writeCSources(list);
  res.status(201).json(cs);
});

router.put('/custom-sources/:id', (req, res) => {
  const list = readCSources();
  const idx  = list.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  list[idx] = { ...list[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  writeCSources(list); res.json(list[idx]);
});

router.delete('/custom-sources/:id', (req, res) => {
  const list = readCSources();
  const idx  = list.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  list.splice(idx, 1); writeCSources(list); res.json({ ok: true });
});

router.post('/custom-sources/:id/test', async (req, res) => {
  // identical to execute but also accepts override params from body
  const cs = readCSources().find(c => c.id === req.params.id);
  if (!cs) return res.status(404).json({ error: 'Introuvable' });
  try { res.json(await executeCustomSource(cs, { ...(req.body || {}), _userDatabase: req.user?.database, _userConnId: req.user?.connId })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/reports', (req, res) => res.json(readReports()));

router.get('/reports/:id', (req, res) => {
  const r = readReports().find(r => r.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Introuvable' });
  res.json(r);
});

router.post('/reports', (req, res) => {
  const reports = readReports();
  const report  = { id: genId(), createdAt: new Date().toISOString(), widgets: [], ...req.body };
  reports.push(report);
  writeReports(reports);
  startJobs(report);
  res.status(201).json(report);
});

router.put('/reports/:id', (req, res) => {
  const reports = readReports();
  const idx = reports.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  reports[idx] = { ...reports[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  writeReports(reports);
  startJobs(reports[idx]);
  res.json(reports[idx]);
});

router.delete('/reports/:id', (req, res) => {
  const reports = readReports();
  const idx = reports.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  stopReportJobs(req.params.id);
  reports.splice(idx, 1);
  writeReports(reports);
  res.json({ ok: true });
});

// Clés de filtre acceptées depuis la toolbar (GET preview/html → buildHTML).
// = contrôles globaux période + multi-année + TOUS les paramKeys de filtres dim (branche,
// marque, time_annee…) pour que HTML/PDF/aperçu respectent les mêmes filtres que le live/Excel.
const FILTER_KEYS = [
  'periode_debut','periode_fin','annee','annees','mois','depot','fouid','dbs','asof','pr','mg',
  ...Object.values(DIM_FILTERS).map(df => df.paramKey),
  'time_annee','time_mois','time_anneemois','time_trimestre',
];
function extractFilterParams(query) {
  const fp = {};
  FILTER_KEYS.forEach(k => { if (query[k]) fp[k] = query[k]; });
  return fp;
}

function addPrintScript(html, autoPrint) {
  if (!autoPrint) return html;
  return html.replace('</body>', `<script>window.onload=()=>{window.print();}</script></body>`);
}

router.get('/reports/:id/preview', async (req, res) => {
  const report = readReports().find(r => r.id === req.params.id);
  if (!report) return res.status(404).send('Introuvable');
  const fp = { ...extractFilterParams(req.query), _userDatabase: req.user?.database, _userConnId: req.user?.connId };
  try { res.send(addPrintScript(await buildHTML(report, fp), req.query.print === '1')); }
  catch(e) { res.status(500).send(`Erreur : ${e.message}`); }
});

router.get('/reports/:id/html', async (req, res) => {
  const report = readReports().find(r => r.id === req.params.id);
  if (!report) return res.status(404).send('Introuvable');
  const fp = { ...extractFilterParams(req.query), _userDatabase: req.user?.database, _userConnId: req.user?.connId };
  try {
    const html = await buildHTML(report, fp);
    const safeName = (report.name||'rapport').replace(/[^a-zA-Z0-9_\- ]/g,'_');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.html"`);
    res.send(html);
  } catch(e) { res.status(500).send(`Erreur : ${e.message}`); }
});

router.get('/dashboards/:id/preview', async (req, res) => {
  const item = readDashboards().find(d => d.id === req.params.id);
  if (!item) return res.status(404).send('Introuvable');
  const fp = { ...extractFilterParams(req.query), _userDatabase: req.user?.database, _userConnId: req.user?.connId };
  try { res.send(addPrintScript(await buildHTML(item, fp), req.query.print === '1')); }
  catch(e) { res.status(500).send(`Erreur : ${e.message}`); }
});

router.get('/dashboards/:id/html', async (req, res) => {
  const item = readDashboards().find(d => d.id === req.params.id);
  if (!item) return res.status(404).send('Introuvable');
  const fp = { ...extractFilterParams(req.query), _userDatabase: req.user?.database, _userConnId: req.user?.connId };
  try {
    const html = await buildHTML(item, fp);
    const safeName = (item.name||'tableau-de-bord').replace(/[^a-zA-Z0-9_\- ]/g,'_');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.html"`);
    res.send(html);
  } catch(e) { res.status(500).send(`Erreur : ${e.message}`); }
});

router.post('/reports/:id/send', async (req, res) => {
  const report = readReports().find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Introuvable' });
  const dest = (req.body.recipients || report.recipients || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
  if (!dest.length) return res.status(400).json({ error: 'Aucun destinataire' });
  try {
    const html = await buildHTML(report, { _userDatabase: req.user?.database, _userConnId: req.user?.connId });
    await sendEmail(dest, report.name, html);
    res.json({ ok: true, sent: dest });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboards CRUD ────────────────────────────────────────────────────────────

const DASHBOARDS_FILE = path.join(__dirname, '../../data/dashboards.json');
function readDashboards() {
  try { return JSON.parse(fs.readFileSync(DASHBOARDS_FILE, 'utf8')); } catch { return []; }
}
function writeDashboards(data) {
  fs.mkdirSync(path.dirname(DASHBOARDS_FILE), { recursive: true });
  fs.writeFileSync(DASHBOARDS_FILE, JSON.stringify(data, null, 2));
}

router.get('/dashboards', (req, res) => res.json(readDashboards()));

router.get('/dashboards/:id', (req, res) => {
  const d = readDashboards().find(d => d.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Introuvable' });
  res.json(d);
});

router.post('/dashboards', (req, res) => {
  const list = readDashboards();
  const d = { id: genId(), createdAt: new Date().toISOString(), widgets: [], ...req.body };
  list.push(d); writeDashboards(list);
  res.status(201).json(d);
});

router.put('/dashboards/:id', (req, res) => {
  const list = readDashboards();
  const idx = list.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  list[idx] = { ...list[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  writeDashboards(list); res.json(list[idx]);
});

router.delete('/dashboards/:id', (req, res) => {
  const list = readDashboards();
  const idx = list.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  list.splice(idx, 1); writeDashboards(list); res.json({ ok: true });
});

// Preview a source config inline (AI generation — no need to save first)
router.post('/preview-source', async (req, res) => {
  const { source } = req.body;
  if (!source || !source.dimensions?.length) return res.status(400).json({ error: 'Source invalide' });
  try {
    const cs = { id: '_preview', ...source };
    const data = await executeCustomSource(cs, { _userDatabase: req.user?.database, _userConnId: req.user?.connId }, source.measures, {
      ruptures: source.ruptures,
      pivot: source.pivot,
      pivotCols: source.pivotCols,
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Execute any source (builtin or custom) and return JSON data for live dashboard widgets
router.post('/widget-data', async (req, res) => {
  const { source, params = {}, measures, ruptures, pivot, pivotCols, dimensions, sortDir, sortBy, topN } = req.body;
  const pUser = { ...params, _userDatabase: req.user?.database, _userConnId: req.user?.connId };
  try {
    const src = SOURCES[source];
    if (src) return res.json(await src.fetch(pUser));
    const cs = readCSources().find(c => c.id === source);
    if (cs) return res.json(await executeCustomSource(cs, pUser, measures,
      { ruptures, pivot, pivotCols, sortDir, sortBy, topN }, dimensions));
    if (dimensions?.length > 0) {
      const vcs = { id: '_auto', dimensions: [], measures: measures||['ca'], filters: {}, limit: 500 };
      return res.json(await executeCustomSource(vcs, pUser, measures,
        { ruptures, pivot: (pivotCols?.length > 0 || pivot), pivotCols, sortDir, sortBy, topN }, dimensions));
    }
    res.status(404).json({ error: 'Source inconnue : ' + source });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Excel export ──────────────────────────────────────────────────────────────

function fmtNumXl(v) { return isNaN(parseFloat(v)) ? 0 : parseFloat(v); }
// Arrondi selon le format de mesure (montants, %, qté…) — utilisé pour les
// cellules numériques Excel afin d'éviter les décimales parasites issues des
// SUM SQL (ex. subtotal de rupture à 12345.999999999).
function xlNum(v, fmt) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  if (fmt === 'percent') return Math.round(n * 10) / 10;
  if (fmt === 'euro' || fmt === 'integer' || fmt === 'qty') return Math.round(n);
  return Math.round(n * 100) / 100;
}

function fillSheet(ws, data, widget, societesLabel) {
  // Sociétés (mono/multi-base) — bandeau au-dessus du titre
  if (societesLabel) {
    const socRow = ws.addRow([societesLabel]);
    socRow.getCell(1).font = { bold:true, size:11, color:{argb:'FF555555'} };
    ws.addRow([]);
  }
  // Title row
  if (widget?.title) {
    const titleRow = ws.addRow([widget.title]);
    titleRow.getCell(1).font = { bold:true, size:13, color:{argb:'FF1F3864'} };
    ws.addRow([]);
  }

  const HEADER = { font:{bold:true, color:{argb:'FFFFFFFF'}},
    fill:{type:'pattern',pattern:'solid',fgColor:{argb:'FF1F3864'}},
    alignment:{horizontal:'center'},
    border:{bottom:{style:'thin',color:{argb:'FF1F3864'}}} };
  const GROUP  = { font:{bold:true, color:{argb:'FF1F3864'}},
    fill:{type:'pattern',pattern:'solid',fgColor:{argb:'FFD6E4F0'}} };
  const ODD    = { fill:{type:'pattern',pattern:'solid',fgColor:{argb:'FFF2F7FB'}} };

  // Totaux ligne/colonne demandés via widget.showTotals = 'rows'|'cols'|'both'
  const totOpt = widget?.showTotals || false;
  const wantRowTot = totOpt === 'rows' || totOpt === 'both';
  const wantColTot = totOpt === 'cols' || totOpt === 'both';
  // Helper : valeur numérique d'une cellule pivot (objet {meas:val} ou scalaire)
  const cellNum = (cell, mkey) => typeof cell === 'object' && cell !== null
    ? parseFloat(cell?.[mkey] || 0)
    : parseFloat(cell || 0);

  // ── Mode d'évolution (widget.evolMode) — colonnes Δ inline et/ou colonne Évolution à droite ──
  const evolMode = widget?.evolMode || 'cols';
  const isRowsMode = (evolMode === 'rows' || evolMode === 'each_col_rows');
  const PCT_FMT = '+0.0%;-0.0%;—';

  if (data.type === 'pivot' && data.rows) {
    const meas = data.measures || [];
    const cols = data.columns || [];
    const measCount = Math.max(1, meas.length);
    const isMulti = measCount > 1;
    const leafLabels = data.leafDimLabels?.length ? data.leafDimLabels : ['Libellé'];
    const leafCount = leafLabels.length;
    const showRowTot = cols.length > 0 && wantRowTot;
    const showColTot = cols.length > 0 && wantColTot;
    const showEvolCol = cols.length > 0 && (
      (evolMode === 'cols' && cols.length >= 2) || isRowsMode
    );
    const showInlineEvol = (evolMode === 'each_col' || evolMode === 'each_col_rows') && cols.length >= 2;
    const evolColLabel = isRowsMode ? 'Évol. (vs préc.)' : 'Évolution';

    // Header row 1 : dims + colonne pivot (colspan = measCount) [+ Δ inline] + [Total] + [Évolution]
    const hdr1Cells = [...leafLabels];
    cols.forEach((c, ci) => {
      hdr1Cells.push(c);
      for (let i = 1; i < measCount; i++) hdr1Cells.push('');
      if (showInlineEvol && ci > 0) hdr1Cells.push('Δ %');
    });
    if (showRowTot) { hdr1Cells.push('Total'); for (let i = 1; i < measCount; i++) hdr1Cells.push(''); }
    if (showEvolCol) hdr1Cells.push(evolColLabel);
    const hdr1 = ws.addRow(hdr1Cells);
    hdr1.eachCell(c => Object.assign(c, HEADER));
    const r1 = hdr1.number;

    if (isMulti) {
      // Merge en-têtes pivot (1 cellule par groupe de measCount colonnes), avec Δ intercalés (cellule unique)
      let pos = leafCount + 1;
      cols.forEach((_, ci) => {
        ws.mergeCells(r1, pos, r1, pos + measCount - 1);
        ws.getCell(r1, pos).alignment = { horizontal: 'center' };
        pos += measCount;
        if (showInlineEvol && ci > 0) { ws.mergeCells(r1, pos, r1 + 1, pos); pos += 1; }
      });
      if (showRowTot) {
        ws.mergeCells(r1, pos, r1, pos + measCount - 1);
        ws.getCell(r1, pos).alignment = { horizontal: 'center' };
        pos += measCount;
      }
      if (showEvolCol) { ws.mergeCells(r1, pos, r1 + 1, pos); pos += 1; }
      // Header row 2 : sous-en-têtes mesures (Δ déjà mergés sur 2 lignes)
      const hdr2Cells = new Array(leafCount).fill('');
      cols.forEach((_, ci) => {
        meas.forEach(m => hdr2Cells.push(m.label));
        if (showInlineEvol && ci > 0) hdr2Cells.push('');
      });
      if (showRowTot) meas.forEach(m => hdr2Cells.push(m.label));
      if (showEvolCol) hdr2Cells.push('');
      const hdr2 = ws.addRow(hdr2Cells);
      hdr2.eachCell(c => Object.assign(c, HEADER));
      for (let ci = 0; ci < leafCount; ci++) ws.mergeCells(r1, ci + 1, r1 + 1, ci + 1);
    }

    const colTots = cols.map(() => meas.map(() => 0));
    const grandTot = meas.map(() => 0);
    let prevRowTotalFirst = null;
    data.rows.forEach((row, ri) => {
      const dimCells = row.dimVals?.length ? row.dimVals.slice() : [row.label];
      while (dimCells.length < leafCount) dimCells.push('');
      const valCells = [];
      const rowTots = meas.map(() => 0);
      const firstMeasVals = [];
      cols.forEach((c, ci) => {
        const cell = row.values[c];
        meas.forEach((m, mi) => {
          const v = cellNum(cell, m.key);
          valCells.push(xlNum(v, m.format));
          colTots[ci][mi] += v;
          rowTots[mi] += v;
          if (mi === 0) firstMeasVals[ci] = v;
        });
        if (showInlineEvol && ci > 0) {
          const prev = firstMeasVals[ci - 1], curr = firstMeasVals[ci];
          valCells.push(prev > 0 ? (curr - prev) / prev : null);
        }
      });
      if (showRowTot) meas.forEach((m, mi) => { valCells.push(xlNum(rowTots[mi], m.format)); grandTot[mi] += rowTots[mi]; });
      if (showEvolCol) {
        let ev = null;
        if (evolMode === 'cols' && cols.length >= 2) {
          const l = firstMeasVals[firstMeasVals.length - 1], p = firstMeasVals[firstMeasVals.length - 2];
          ev = p > 0 ? (l - p) / p : null;
        } else if (isRowsMode) {
          const tot = rowTots[0];
          ev = (prevRowTotalFirst != null && prevRowTotalFirst > 0) ? (tot - prevRowTotalFirst) / prevRowTotalFirst : null;
          prevRowTotalFirst = tot;
        }
        valCells.push(ev);
      }
      const r = ws.addRow([...dimCells.slice(0, leafCount), ...valCells]);
      if (ri % 2) r.eachCell(c => { c.fill = ODD.fill; });
      // Format % sur les cellules Δ inline et Évolution
      if (showInlineEvol || showEvolCol) {
        let pos = leafCount + 1;
        cols.forEach((_, ci) => {
          pos += measCount;
          if (showInlineEvol && ci > 0) { r.getCell(pos).numFmt = PCT_FMT; pos += 1; }
        });
        if (showRowTot) pos += measCount;
        if (showEvolCol) r.getCell(pos).numFmt = PCT_FMT;
      }
    });

    if (showColTot) {
      const totCells = new Array(leafCount).fill('');
      totCells[0] = 'Total';
      const colFirstTotals = [];
      cols.forEach((_, ci) => {
        meas.forEach((m, mi) => {
          totCells.push(xlNum(colTots[ci][mi], m.format));
          if (mi === 0) colFirstTotals[ci] = colTots[ci][0];
        });
        if (showInlineEvol && ci > 0) {
          const prev = colFirstTotals[ci - 1], curr = colFirstTotals[ci];
          totCells.push(prev > 0 ? (curr - prev) / prev : null);
        }
      });
      if (showRowTot) meas.forEach((m, mi) => totCells.push(xlNum(grandTot[mi], m.format)));
      if (showEvolCol) {
        let ev = null;
        if (evolMode === 'cols' && cols.length >= 2) {
          const l = colFirstTotals[colFirstTotals.length - 1], p = colFirstTotals[colFirstTotals.length - 2];
          ev = p > 0 ? (l - p) / p : null;
        }
        // En mode rows : pas d'évolution en pied de tableau (rien à comparer)
        totCells.push(ev);
      }
      const r = ws.addRow(totCells);
      r.eachCell(c => Object.assign(c, GROUP));
      if (showInlineEvol || showEvolCol) {
        let pos = leafCount + 1;
        cols.forEach((_, ci) => {
          pos += measCount;
          if (showInlineEvol && ci > 0) { r.getCell(pos).numFmt = PCT_FMT; pos += 1; }
        });
        if (showRowTot) pos += measCount;
        if (showEvolCol) r.getCell(pos).numFmt = PCT_FMT;
      }
    }
  } else if (data.type === 'grouped' && data.groups) {
    const meas = data.measures || [];
    const cols = data.columns;
    const isPivot = Array.isArray(cols) && cols.length > 0;
    const measCount = Math.max(1, meas.length);
    const isMulti = isPivot && measCount > 1;
    const rupLabels = data.ruptureLabels || [];
    const ruptureIds = data.ruptureIds || [];
    const leafLabels = data.leafDimLabels?.length ? data.leafDimLabels : ['Libellé'];
    const rupCount = rupLabels.length;
    const leafCount = leafLabels.length;
    const showRowTot = isPivot && wantRowTot;
    const showColTot = isPivot && wantColTot;
    const showEvolCol = isPivot && (
      (evolMode === 'cols' && cols.length >= 2) || isRowsMode
    );
    const showInlineEvol = isPivot && (evolMode === 'each_col' || evolMode === 'each_col_rows') && cols.length >= 2;
    const evolColLabel = isRowsMode ? 'Évol. (vs préc.)' : 'Évolution';
    const evolRowDim = widget?.evolRowDim || 'leaf';
    const evolRowLevel = (evolRowDim === 'leaf') ? -1 : ruptureIds.indexOf(evolRowDim);
    const dimsBase = rupCount + leafCount;

    // Header row 1
    let hdr1Cells;
    if (isPivot) {
      hdr1Cells = [...rupLabels, ...leafLabels];
      cols.forEach((c, ci) => {
        hdr1Cells.push(c);
        for (let i = 1; i < measCount; i++) hdr1Cells.push('');
        if (showInlineEvol && ci > 0) hdr1Cells.push('Δ %');
      });
      if (showRowTot) { hdr1Cells.push('Total'); for (let i = 1; i < measCount; i++) hdr1Cells.push(''); }
      if (showEvolCol) hdr1Cells.push(evolColLabel);
    } else {
      hdr1Cells = [...rupLabels, ...leafLabels, ...meas.map(m => m.label)];
    }
    const hdr1 = ws.addRow(hdr1Cells);
    hdr1.eachCell(c => Object.assign(c, HEADER));
    const r1 = hdr1.number;

    if (isMulti) {
      let pos = dimsBase + 1;
      cols.forEach((_, ci) => {
        ws.mergeCells(r1, pos, r1, pos + measCount - 1);
        ws.getCell(r1, pos).alignment = { horizontal: 'center' };
        pos += measCount;
        if (showInlineEvol && ci > 0) { ws.mergeCells(r1, pos, r1 + 1, pos); pos += 1; }
      });
      if (showRowTot) {
        ws.mergeCells(r1, pos, r1, pos + measCount - 1);
        ws.getCell(r1, pos).alignment = { horizontal: 'center' };
        pos += measCount;
      }
      if (showEvolCol) { ws.mergeCells(r1, pos, r1 + 1, pos); pos += 1; }
      const hdr2Cells = new Array(dimsBase).fill('');
      cols.forEach((_, ci) => {
        meas.forEach(m => hdr2Cells.push(m.label));
        if (showInlineEvol && ci > 0) hdr2Cells.push('');
      });
      if (showRowTot) meas.forEach(m => hdr2Cells.push(m.label));
      if (showEvolCol) hdr2Cells.push('');
      const hdr2 = ws.addRow(hdr2Cells);
      hdr2.eachCell(c => Object.assign(c, HEADER));
      for (let ci = 0; ci < dimsBase; ci++) ws.mergeCells(r1, ci + 1, r1 + 1, ci + 1);
    }

    function applyPctFormats(r) {
      if (!isPivot) return;
      let pos = dimsBase + 1;
      cols.forEach((_, ci) => {
        pos += measCount;
        if (showInlineEvol && ci > 0) { r.getCell(pos).numFmt = PCT_FMT; pos += 1; }
      });
      if (showRowTot) pos += measCount;
      if (showEvolCol) r.getCell(pos).numFmt = PCT_FMT;
    }

    function writeItems(items, lv) {
      let prevSibTotal = null;
      const applyRowsEvolHere = isRowsMode && (lv === evolRowLevel);
      items.forEach(item => {
        if (item.children !== undefined) {
          let vals;
          const firstMeasVals = [];
          if (isPivot) {
            vals = [];
            const rowTots = meas.map(() => 0);
            cols.forEach((c, ci) => {
              const cell = (item.subtotal || {})[c];
              meas.forEach((m, mi) => {
                const v = cellNum(cell, m.key);
                vals.push(xlNum(v, m.format));
                rowTots[mi] += v;
                if (mi === 0) firstMeasVals[ci] = v;
              });
              if (showInlineEvol && ci > 0) {
                const prev = firstMeasVals[ci - 1], curr = firstMeasVals[ci];
                vals.push(prev > 0 ? (curr - prev) / prev : null);
              }
            });
            if (showRowTot) meas.forEach((m, mi) => vals.push(xlNum(rowTots[mi], m.format)));
            if (showEvolCol) {
              let ev = null;
              if (evolMode === 'cols' && cols.length >= 2) {
                const l = firstMeasVals[firstMeasVals.length - 1], p = firstMeasVals[firstMeasVals.length - 2];
                ev = p > 0 ? (l - p) / p : null;
              } else if (applyRowsEvolHere) {
                const totalFirst = firstMeasVals.reduce((a,b)=>a+b,0);
                ev = (prevSibTotal != null && prevSibTotal > 0) ? (totalFirst - prevSibTotal) / prevSibTotal : null;
                prevSibTotal = totalFirst;
              }
              vals.push(ev);
            }
          } else {
            vals = meas.map(m => xlNum((item.subtotal || {})[m.key], m.format));
          }
          const dimCells = new Array(dimsBase).fill('');
          if (lv < rupCount) dimCells[lv] = item.label;
          else dimCells[rupCount] = item.label;
          const r = ws.addRow([...dimCells, ...vals]);
          r.eachCell(c => { c.font = GROUP.font; c.fill = GROUP.fill; });
          if (isPivot) applyPctFormats(r);
          writeItems(item.children, lv + 1);
        } else {
          let vals;
          const firstMeasVals = [];
          if (isPivot) {
            vals = [];
            const rowTots = meas.map(() => 0);
            cols.forEach((c, ci) => {
              const cell = (item.values || {})[c];
              meas.forEach((m, mi) => {
                const v = cellNum(cell, m.key);
                vals.push(xlNum(v, m.format));
                rowTots[mi] += v;
                if (mi === 0) firstMeasVals[ci] = v;
              });
              if (showInlineEvol && ci > 0) {
                const prev = firstMeasVals[ci - 1], curr = firstMeasVals[ci];
                vals.push(prev > 0 ? (curr - prev) / prev : null);
              }
            });
            if (showRowTot) meas.forEach((m, mi) => vals.push(xlNum(rowTots[mi], m.format)));
            if (showEvolCol) {
              let ev = null;
              if (evolMode === 'cols' && cols.length >= 2) {
                const l = firstMeasVals[firstMeasVals.length - 1], p = firstMeasVals[firstMeasVals.length - 2];
                ev = p > 0 ? (l - p) / p : null;
              } else if (isRowsMode && evolRowLevel === -1) {
                // Mode rows par défaut sur les feuilles
                const tot = rowTots[0];
                ev = (prevSibTotal != null && prevSibTotal > 0) ? (tot - prevSibTotal) / prevSibTotal : null;
                prevSibTotal = tot;
              }
              vals.push(ev);
            }
          } else {
            vals = meas.map(m => xlNum((item.values || {})[m.key], m.format));
          }
          const leafCells = item.dimVals?.length ? item.dimVals.slice() : [item.label];
          while (leafCells.length < leafCount) leafCells.push('');
          const dimCells = [...new Array(rupCount).fill(''), ...leafCells.slice(0, leafCount)];
          const r = ws.addRow([...dimCells, ...vals]);
          if (isPivot) applyPctFormats(r);
        }
      });
    }
    writeItems(data.groups, 0);

    if (showColTot) {
      const colTots = cols.map(() => meas.map(() => 0));
      data.groups.forEach(g => {
        cols.forEach((c, ci) => meas.forEach((m, mi) => {
          colTots[ci][mi] += cellNum((g.subtotal || {})[c], m.key);
        }));
      });
      const totCells = new Array(dimsBase).fill('');
      totCells[0] = 'Total';
      const colFirstTotals = [];
      cols.forEach((_, ci) => {
        meas.forEach((m, mi) => {
          totCells.push(xlNum(colTots[ci][mi], m.format));
          if (mi === 0) colFirstTotals[ci] = colTots[ci][0];
        });
        if (showInlineEvol && ci > 0) {
          const prev = colFirstTotals[ci - 1], curr = colFirstTotals[ci];
          totCells.push(prev > 0 ? (curr - prev) / prev : null);
        }
      });
      if (showRowTot) meas.forEach((m, mi) => {
        const grand = colTots.reduce((s, ct) => s + ct[mi], 0);
        totCells.push(xlNum(grand, m.format));
      });
      if (showEvolCol) {
        let ev = null;
        if (evolMode === 'cols' && cols.length >= 2) {
          const l = colFirstTotals[colFirstTotals.length - 1], p = colFirstTotals[colFirstTotals.length - 2];
          ev = p > 0 ? (l - p) / p : null;
        }
        totCells.push(ev);
      }
      const r = ws.addRow(totCells);
      r.eachCell(c => Object.assign(c, GROUP));
      applyPctFormats(r);
    }
  } else if (data.measures && data.rows) {
    const meas = data.measures;
    const dimLabels = data.dimLabels?.length > 0 ? data.dimLabels : ['Libellé'];
    const hdr = ws.addRow([...dimLabels, ...meas.map(m => m.label)]);
    hdr.eachCell(c => Object.assign(c, HEADER));
    const colTots = meas.map(() => 0);
    data.rows.forEach((row, ri) => {
      const dimCols = row.dimVals?.length > 0 ? row.dimVals : [row.label];
      const vals = meas.map(m => xlNum(row.values[m.key], m.format));
      vals.forEach((v, mi) => { colTots[mi] += v; });
      const r = ws.addRow([...dimCols, ...vals]);
      if (ri % 2) r.eachCell(c => { c.fill = ODD.fill; });
    });
    if (wantColTot && meas.length) {
      const totCells = new Array(dimLabels.length).fill('');
      totCells[0] = 'Total';
      meas.forEach((m, mi) => totCells.push(xlNum(colTots[mi], m.format)));
      const r = ws.addRow(totCells);
      r.eachCell(c => Object.assign(c, GROUP));
    }
  } else if (Array.isArray(data) && data.length && data[0].label !== undefined) {
    const hdr = ws.addRow(['Libellé', 'Valeur']);
    hdr.eachCell(c => Object.assign(c, HEADER));
    data.forEach((row, ri) => {
      const r = ws.addRow([row.label, fmtNumXl(row.valeur)]);
      if (ri % 2) r.eachCell(c => { c.fill = ODD.fill; });
    });
  }

  // Auto-width columns
  ws.columns.forEach(col => {
    let max = 10;
    col.eachCell({ includeEmpty:true }, cell => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 60);
  });
}

async function buildExcelForItem(item, filterParams = {}) {
  console.log('[Excel export] item:', item?.name || item?.id, '| filterParams:', JSON.stringify(filterParams));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TB Reporting';
  wb.created = new Date();

  const TIME_DIMS = new Set(['time_annee','time_mois','time_mois_lib','time_anneemois','time_semaine','time_jour','time_date']);
  const csources = readCSources();

  // Sociétés des bases sélectionnées — bandeau ajouté en tête de chaque feuille
  let societesLabel = '';
  try {
    const dbsForSoc = filterParams.dbs || item.dbs || undefined;
    const userInfo = { database: filterParams._userDatabase, connId: filterParams._userConnId };
    const socs = await getDbsSocietes(dbsForSoc, userInfo);
    societesLabel = socs.map(s => s.societe).filter(Boolean).join(' / ');
  } catch { societesLabel = ''; }

  for (const w of (item.widgets || [])) {
    console.log('[Excel export] widget:', w.title, '| source:', w.source, '| w.params:', JSON.stringify(w.params));
    if (!w.source) { console.log('[Excel export] skip: no source'); continue; }
    let data;
    try {
      const src = SOURCES[w.source];
      if (src) {
        const mergedP = { ...(w.params || {}), ...filterParams };
        console.log('[Excel export] builtin source, mergedParams:', JSON.stringify(mergedP));
        data = await src.fetch(mergedP);
      } else {
        let cs = csources.find(c => c.id === w.source);
        if (!cs) {
          // Widgets auto-générés (source='_auto') : virtual custom source basé sur w.dimensions
          if (w.dimensions?.length > 0) {
            cs = { id: '_auto', dimensions: [], measures: w.measures || ['ca'], filters: {}, limit: 500 };
          } else {
            console.log('[Excel export] skip: csource not found and no dimensions', w.source); continue;
          }
        }
        const isPureChart = (w.displayType || 'table') === 'chart';
        const effectiveDims = w.dimensions?.length > 0 ? w.dimensions : (cs.dimensions || []);
        const firstNonTimeDim = effectiveDims.find(d => !TIME_DIMS.has(d)) || null;
        const xAxisDim = w.chartXAxis || (isPureChart ? firstNonTimeDim : null);
        const measures = isPureChart && w.chartMeasures?.length ? w.chartMeasures : w.measures;
        const ruptures = isPureChart && !w.pivot
          ? (xAxisDim ? [xAxisDim] : [])
          : (() => {
              const base = w.ruptures || [];
              if (!w.pivot && xAxisDim && !base.includes(xAxisDim)) return [xAxisDim, ...base];
              return base;
            })();
        const overrideDims = w.dimensions?.length > 0 ? w.dimensions : null;
        const mergedP = { ...(w.params || {}), ...filterParams };
        const effectivePivot = w.pivot !== false && ((w.pivot || false) || (w.pivotCols?.length > 0));
        console.log('[Excel export] custom source "%s", dims:', overrideDims, '| mergedParams:', JSON.stringify(mergedP));
        data = await executeCustomSource(cs, mergedP, measures,
          { ruptures, pivot: effectivePivot, pivotCols: w.pivotCols || [],
            sortDir: w.sortDir, sortBy: w.sortBy, topN: w.topN }, overrideDims);
      }
    } catch(e) {
      console.error('[Excel export] widget "%s" error:', w.title, e.message, e.stack);
      data = null;
    }
    if (!data) { console.log('[Excel export] data is null/undefined, skipping widget'); continue; }
    console.log('[Excel export] data type:', data?.type, '| rows/groups count:', data?.rows?.length ?? data?.groups?.length ?? (Array.isArray(data) ? data.length : '?'));

    let baseName = (w.title || 'Widget').replace(/[\\/?*\[\]:]/g, ' ').trim().slice(0, 28) || 'Widget';
    let sheetName = baseName.slice(0, 31);
    let suffix = 2;
    const nameExists = n => wb.worksheets.some(ws => ws.name.toLowerCase() === n.toLowerCase());
    while (nameExists(sheetName)) sheetName = `${baseName} ${suffix++}`.slice(0, 31);
    const ws = wb.addWorksheet(sheetName);
    const isChartWidget = w.displayType === 'chart' || w.displayType === 'table-chart';
    let skipTable = false;
    if (isChartWidget) {
      try {
        const imgBuf = await renderChartToImage(data, w);
        if (imgBuf) {
          // Décalage pour laisser place au bandeau sociétés (1 ligne + 1 vide)
          const chartTopRow = societesLabel ? 2 : 0;
          if (societesLabel) {
            const socRow = ws.addRow([societesLabel]);
            socRow.getCell(1).font = { bold:true, size:11, color:{argb:'FF555555'} };
            ws.addRow([]);
          }
          const imgId = wb.addImage({ buffer: imgBuf, extension: 'png' });
          ws.addImage(imgId, { tl: { col: 0, row: chartTopRow }, ext: { width: 800, height: 380 } });
          for (let r = 0; r < 20; r++) ws.addRow([]);
        }
      } catch(imgErr) {
        console.error('[Excel chart image]', imgErr.message);
      }
      if (w.displayType === 'chart') skipTable = true;
    }
    // Pour les widgets table+chart : sociétés déjà ajoutées avec le chart, on ne les répète pas dans fillSheet
    const socForFillSheet = (isChartWidget && !skipTable) ? '' : societesLabel;
    if (!skipTable) fillSheet(ws, data, w, socForFillSheet);
  }

  if (wb.worksheets.length === 0) wb.addWorksheet('Vide');
  return wb;
}

router.post('/dashboards/:id/export', async (req, res) => {
  const item = readDashboards().find(d => d.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Introuvable' });
  try {
    const wb = await buildExcelForItem(item, { ...(req.body?.filterParams || {}), _userDatabase: req.user?.database, _userConnId: req.user?.connId });
    const safeName = (item.name||'tableau-de-bord').replace(/[^a-zA-Z0-9_\- ]/g,'_');
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/reports/:id/export', async (req, res) => {
  const item = readReports().find(r => r.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Introuvable' });
  try {
    const wb = await buildExcelForItem(item, { ...(req.body?.filterParams || {}), _userDatabase: req.user?.database, _userConnId: req.user?.connId });
    const safeName = (item.name||'rapport').replace(/[^a-zA-Z0-9_\- ]/g,'_');
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, setupCronJobs };

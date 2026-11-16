// ── Stat Wavesoft par groupe de clients (demande Michel) ──────────────────────
// Reproduit les tableaux croisés Wavesoft « Groupe XXX au <date> PAR CLASSE DETAIL ARTICLES » :
//   lignes   : Classe article > Code article > Désignation (+ sous-totaux classe, total général)
//   colonnes : Client > Année (N-1, N) > Trimestre > Mois, du 1er janvier au dernier mois clos
//   mesure   : CA HT (même calcul que le moteur de rapports : _CA_LINE de backoffice.js)
// Planifié (config/stat-groupes.json, défaut : le 1er du mois à 7h, heure locale serveur) :
// 1 classeur Excel par groupe, écrit dans outputDir ET envoyé en PJ d'un seul mail.
// Lancement manuel : node scripts/stat-groupes.js [--date AAAA-MM-JJ] [--no-mail] [--no-write] [--out DIR]
const fs       = require('fs');
const path     = require('path');
const ExcelJS  = require('exceljs');
const nodemailer = require('nodemailer');
const cron     = require('node-cron');
const { getConnPool, sql } = require('../../config/database');

const CONFIG_FILE   = process.env.STAT_GROUPES_CONFIG || path.join(__dirname, '../../config/stat-groupes.json');
const SETTINGS_FILE = path.join(__dirname, '../../data/settings.json');

const MOIS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
const CA_LINE = `(pl.PLVMNTNETHT - pv.PCVREMISEPIED*pl.PLVMNTNETHT)*pn.PINSENSSTATISTIQUE`;

const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const norm = s => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toUpperCase();
const pad2 = n => String(n).padStart(2, '0');
const moisLib = m => `${pad2(m)} - ${MOIS[m - 1]}`;

// Période : du 1er janvier N-1 au dernier jour du mois précédant `runDate`, mois 1..M sur les deux années.
// Ex. lancé le 2026-10-01 → arrêté au 30/09/2026, années 2025 et 2026, mois 01→09.
//     lancé le 2027-01-01 → arrêté au 31/12/2026, années 2025 et 2026, mois 01→12.
function computePeriod(runDate = new Date()) {
  const ref = new Date(runDate.getFullYear(), runDate.getMonth(), 0); // dernier jour du mois précédent
  const Y = ref.getFullYear(), M = ref.getMonth() + 1;
  return {
    ref, Y, M, years: [Y - 1, Y],
    dateLabel: `${pad2(ref.getDate())} ${MOIS[M - 1].toUpperCase()} ${Y}`,  // « 30 SEPTEMBRE 2026 »
    dateFr: ref.toLocaleDateString('fr-FR'),
    d0: `${Y - 1}-01-01`,
    d1: `${Y}-${pad2(M)}-${pad2(ref.getDate())}`,
  };
}

// ── Données ───────────────────────────────────────────────────────────────────

// Résout chaque groupe en ensemble de TIRID (comparaisons insensibles à la casse et aux espaces multiples) :
//   - "clients"    : raisons sociales (liste figée)
//   - "categories" : catégories client Wavesoft (TIRCATEGORIE) — les nouveaux magasins entrent automatiquement
// Les deux peuvent être combinés (union) ; "exclude" retire ensuite des raisons sociales précises.
async function resolveClients(pool, groups) {
  const r = await pool.request().query(`SELECT TIRID, RTRIM(TIRSOCIETE) AS nom, RTRIM(TIRCATEGORIE) AS cat FROM TIERS WHERE TIRSOCIETE IS NOT NULL`);
  const byName = new Map(), byCat = new Map();
  const push = (m, k, id) => { if (!m.has(k)) m.set(k, []); m.get(k).push(id); };
  for (const t of r.recordset) {
    push(byName, norm(t.nom), t.TIRID);
    if (t.cat) push(byCat, norm(t.cat), t.TIRID);
  }
  const missing = [];
  const groupIds = new Map();   // nom du groupe → Set(TIRID)
  for (const g of groups) {
    const ids = new Set();
    for (const c of g.clients || []) {
      const found = byName.get(norm(c));
      if (!found) { missing.push(`${g.name} : ${c}`); continue; }
      found.forEach(id => ids.add(id));
    }
    for (const c of g.categories || []) {
      const found = byCat.get(norm(c));
      if (!found) { missing.push(`${g.name} : catégorie « ${c} »`); continue; }
      found.forEach(id => ids.add(id));
    }
    // "exclude" : raisons sociales à retirer (ex. magasin de la catégorie suivi dans un autre groupe)
    for (const c of g.exclude || []) {
      const found = byName.get(norm(c));
      if (!found) { missing.push(`${g.name} : exclusion « ${c} »`); continue; }
      found.forEach(id => ids.delete(id));
    }
    groupIds.set(g.name, ids);
  }
  return { groupIds, missing };
}

// Une seule requête pour tous les groupes : CA HT par client × article × année × mois.
async function fetchRows(pool, tirids, period) {
  if (!tirids.length) return [];
  const req = pool.request();
  req.input('d0', sql.Date, period.d0);
  req.input('d1', sql.Date, period.d1);
  req.input('M',  sql.Int,  period.M);
  // TIRID entiers issus de la base : injection sûre, évite la limite de 2100 paramètres
  const idList = tirids.map(n => parseInt(n, 10)).filter(Number.isFinite).join(',');
  const q = `
SELECT pv.TIRID AS tirid, RTRIM(tc.TIRSOCIETE) AS client,
       ISNULL(NULLIF(RTRIM(a.ARTCLASSE),''),'Non défini') AS classe,
       RTRIM(a.ARTCODE) AS code, RTRIM(a.ARTDESIGNATION) AS des,
       YEAR(pv.PCVDATEEFFET) AS y, MONTH(pv.PCVDATEEFFET) AS m,
       SUM(${CA_LINE}) AS ca
FROM PIECEVENTELIGNES pl
JOIN PIECEVENTES pv ON pv.PCVID=pl.PCVID
JOIN PIECE_NATURE pn WITH (NOLOCK) ON pn.PINID=pv.PINID
JOIN ARTICLES a WITH (NOLOCK) ON a.ARTID=pl.ARTID
JOIN TIERS tc ON tc.TIRID=pv.TIRID
WHERE pn.PITCODE='F' AND pn.PINSENSSTATISTIQUE<>0 AND a.ARTISSTATISTIQUE='O'
  AND pv.PCVDATEEFFET >= @d0 AND pv.PCVDATEEFFET < DATEADD(day,1,@d1)
  AND MONTH(pv.PCVDATEEFFET) <= @M
  AND pv.TIRID IN (${idList})
GROUP BY pv.TIRID, tc.TIRSOCIETE, a.ARTCLASSE, a.ARTCODE, a.ARTDESIGNATION, YEAR(pv.PCVDATEEFFET), MONTH(pv.PCVDATEEFFET)`;
  req.timeout = 600000;
  const r = await req.query(q);
  return r.recordset;
}

// ── Excel ─────────────────────────────────────────────────────────────────────
// Mise en forme calquée sur les exports Wavesoft fournis par Michel (docs/michel/*.xlsx) :
// Arial, en-têtes mauve clair, totaux mauve, sous-totaux classe mauve foncé + mois en jaune,
// total général gris à texte bleu, quadrillage pointillé bleu.
const C = {
  head:    'FFE4DFEC',   // en-têtes + libellés article
  tot:     'FFCCC0DA',   // colonnes Total Tn / Total AAAA
  sub:     'FFB1A0C7',   // ligne « Total <classe> »
  subMois: 'FFFFF800',   // cellules mois de la ligne « Total <classe> »
  grand:   'FFF2F2F2',   // total général (ligne et colonnes finales)
  blue:    'FF0071B8',   // bordures + texte du total général
  txt:     'FF0D0D0D',
  white:   'FFFFFFFF',
};
const FILL = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb }, bgColor: { indexed: 64 } });
const FONT = (size, bold, argb = 'FF000000') => ({ name: 'Arial', family: 2, size, bold: !!bold, color: { argb } });
const B = style => ({ style, color: { argb: C.blue } });
const NUM_FMT = '#,##0.00';

// Colonnes d'un bloc année : mois du trimestre, « Total Tq », …, « Total AAAA »
function yearColumns(M) {
  const cols = [];
  for (let q = 1; q <= 4; q++) {
    const months = [1, 2, 3].map(i => (q - 1) * 3 + i).filter(m => m <= M);
    if (!months.length) break;
    months.forEach(m => cols.push({ kind: 'm', q, m, label: moisLib(m) }));
    cols.push({ kind: 'q', q, label: `Total T${q}` });
  }
  cols.push({ kind: 'y', label: null });
  return cols;
}

async function buildWorkbook(group, rows, period) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TB Reporting';
  wb.created = new Date();
  const H = { client: 4, year: 5, trim: 6, month: 7, meas: 8 };
  const ws = wb.addWorksheet('Feuil1', {
    views: [{ state: 'frozen', xSplit: 3, ySplit: H.meas }],
    properties: { outlineLevelRow: 1 },
  });
  ws.properties.outlineProperties = { summaryBelow: true, summaryRight: true };

  // Clients présents (ordre alphabétique, comme Wavesoft — un client sans vente n'apparaît pas)
  const clients = [...new Set(rows.map(r => r.client))].sort((a, b) => a.localeCompare(b, 'fr'));
  const ycols = yearColumns(period.M);

  // Index des valeurs : article → { "client|année|mois": CA }
  const arts = new Map();
  for (const r of rows) {
    const k = `${r.classe}\u0001${r.code}`;
    if (!arts.has(k)) arts.set(k, { classe: r.classe, code: r.code, des: r.des, v: {} });
    const a = arts.get(k);
    const key = `${r.client}|${r.y}|${r.m}`;
    a.v[key] = (a.v[key] || 0) + (Number(r.ca) || 0);
  }
  const sorted = [...arts.values()].sort((a, b) =>
    a.classe.localeCompare(b.classe, 'fr') || a.code.localeCompare(b.code, 'fr'));

  // Plan des colonnes (à partir de la colonne 4) ; first = 1re colonne d'un bloc client (bordure pleine)
  const plan = [];
  for (const cl of clients) period.years.forEach((y, yi) => ycols.forEach((c, ci) =>
    plan.push({ client: cl, y, ...c, first: yi === 0 && ci === 0, label: c.kind === 'y' ? `Total ${y}` : c.label })));
  period.years.forEach((y, yi) => plan.push({ kind: 'gy', y, first: yi === 0, label: `Total ${y}` }));
  plan.push({ kind: 'evol', label: `Évol. ${period.years[1]}/${period.years[0]}` });

  const cellVal = (vals, p) => {
    const sum = pred => { let s = 0, hit = false;
      for (const [k, v] of Object.entries(vals)) { const [c, y, m] = k.split('|'); if (pred(c, +y, +m)) { s += v; hit = true; } }
      return hit ? s : null; };
    switch (p.kind) {
      case 'm':  return vals[`${p.client}|${p.y}|${p.m}`] ?? null;
      case 'q':  return sum((c, y, m) => c === p.client && y === p.y && Math.ceil(m / 3) === p.q);
      case 'y':  return sum((c, y) => c === p.client && y === p.y);
      case 'gy': return sum((c, y) => y === p.y);
      default:   return null;
    }
  };
  const isGrand = p => p.kind === 'gy' || p.kind === 'evol';
  const isTot   = p => p.kind === 'q' || p.kind === 'y';

  // Lignes 1-3 : filtre « Mois » comme dans l'export Wavesoft + mention de génération
  const calibri = { name: 'Calibri', family: 2, size: 11, scheme: 'minor', color: { theme: 1 } };
  ws.getCell(1, 1).value = 'Mois';
  ws.getCell(2, 1).value = Array.from({ length: period.M }, (_, i) => moisLib(i + 1)).join(';');
  ws.getCell(2, 1).numFmt = '@';
  [1, 2].forEach(r => { ws.getCell(r, 1).font = calibri; });
  ws.getCell(3, 1).value = `${group.name} — CA HT au ${period.dateLabel} — généré le ${new Date().toLocaleString('fr-FR')}`;
  ws.getCell(3, 1).font = { ...calibri, size: 9, italic: true, color: { argb: 'FF808080' } };

  // En-têtes de colonnes (lignes 4 à 8)
  plan.forEach((p, i) => {
    const col = 4 + i;
    ws.getCell(H.client, col).value = p.client || 'Total';
    ws.getCell(H.year, col).value   = p.kind === 'evol' ? '' : (p.kind === 'y' || p.kind === 'gy') ? `Total ${p.y}` : String(p.y);
    ws.getCell(H.trim, col).value   = p.kind === 'm' ? `T${p.q}` : p.kind === 'q' ? `Total T${p.q}` : (p.kind === 'y' || p.kind === 'gy') ? `Total ${p.y}` : '';
    ws.getCell(H.month, col).value  = p.label;
    ws.getCell(H.meas, col).value   = p.kind === 'evol' ? '%' : 'CA HT';
  });
  ['Classe article', 'Code article', 'Désignation article'].forEach((t, i) => { ws.getCell(H.meas, i + 1).value = t; });
  for (let r = H.client; r <= H.meas; r++) {
    for (let c = 1; c <= 3; c++) {
      const cell = ws.getCell(r, c);
      cell.font = FONT(8, true); cell.fill = FILL(C.head);
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
      cell.border = { right: c === 3 ? B('thin') : undefined, bottom: r === H.meas ? B('thin') : undefined };
    }
    plan.forEach((p, i) => {
      const cell = ws.getCell(r, 4 + i);
      if (isGrand(p))     { cell.font = FONT(10, true, C.blue); cell.fill = FILL(C.grand); cell.alignment = { horizontal: 'center', vertical: 'middle' }; }
      else if (isTot(p))  { cell.font = FONT(10, true);         cell.fill = FILL(C.tot);   cell.alignment = { horizontal: 'center', vertical: 'middle' }; }
      else                { cell.font = FONT(8, true);          cell.fill = FILL(C.head);  cell.alignment = { horizontal: 'left',   vertical: 'middle' }; }
      cell.numFmt = '@';
      cell.border = { left: p.first ? B('thin') : B('dotted'), right: isTot(p) || isGrand(p) ? B('thin') : B('dotted'),
                      top: r === H.client ? undefined : B('thin'), bottom: r === H.meas ? B('thin') : undefined };
    });
  }

  // Corps — type : 'art' (ligne article) | 'sub' (Total classe) | 'grand' (Total)
  let r = H.meas + 1;
  const writeLine = (labels, vals, type) => {
    // Plier/déplier par classe, comme les exports Wavesoft : articles au niveau de plan 1,
    // repliés par défaut sous leur ligne « Total <classe> » (synthèse en dessous du détail).
    if (type === 'art') { const row = ws.getRow(r); row.outlineLevel = 1; row.hidden = true; }
    labels.forEach((t, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = t;
      cell.numFmt = '@';
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
      if (type === 'art')   { cell.font = FONT(8, true);          cell.fill = FILL(C.head); }
      if (type === 'sub')   { cell.font = FONT(10, true);         cell.fill = FILL(C.sub); }
      if (type === 'grand') { cell.font = FONT(10, true, C.blue); cell.fill = FILL(C.grand); }
      cell.border = { right: i === 2 ? B('thin') : undefined, top: type === 'grand' ? B('thin') : B('dotted'),
                      bottom: type === 'sub' ? B('thin') : B('dotted') };
    });
    const ys = [];
    plan.forEach((p, i) => {
      const cell = ws.getCell(r, 4 + i);
      let v;
      if (p.kind === 'evol') {
        const [a, b] = ys;
        v = a ? (b || 0) / a - 1 : null;
        cell.numFmt = '+0.0%;[Red]-0.0%';
      } else {
        v = cellVal(vals, p);
        if (v != null) v = Math.round(v * 100) / 100;
        cell.numFmt = NUM_FMT;
        if (p.kind === 'gy') ys.push(v);
      }
      if (v != null) cell.value = v;
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      if (type === 'grand' || isGrand(p)) { cell.font = FONT(10, true, C.blue); cell.fill = FILL(C.grand); }
      else if (type === 'sub')            { cell.font = FONT(10, true, isTot(p) ? 'FF000000' : C.txt); cell.fill = FILL(isTot(p) ? C.sub : C.subMois); }
      else if (isTot(p))                  { cell.font = FONT(10, true, C.txt); cell.fill = FILL(C.tot); }
      else                                { cell.font = FONT(8, false, C.txt); cell.fill = FILL(C.white); }
      cell.border = { left: p.first ? B('thin') : B('dotted'), right: isTot(p) || isGrand(p) ? B('thin') : B('dotted'),
                      top: type === 'grand' ? B('thin') : B('dotted'), bottom: type === 'sub' ? B('thin') : B('dotted') };
    });
    r++;
  };
  const addVals = (acc, v) => { for (const [k, x] of Object.entries(v)) acc[k] = (acc[k] || 0) + x; return acc; };

  const total = {};
  let i = 0;
  while (i < sorted.length) {
    const classe = sorted[i].classe, sub = {};
    for (; i < sorted.length && sorted[i].classe === classe; i++) {
      const a = sorted[i];
      writeLine([a.classe, a.code, a.des], a.v, 'art');
      addVals(sub, a.v);
    }
    writeLine([`Total ${classe}`, '', ''], sub, 'sub');
    addVals(total, sub);
  }
  writeLine(['Total', '', ''], total, 'grand');
  if (!sorted.length) ws.getCell(r, 1).value = 'Aucune vente sur la période pour les clients de ce groupe.';

  ws.getColumn(1).width = 18; ws.getColumn(2).width = 10; ws.getColumn(3).width = 51;
  plan.forEach((p, k) => { ws.getColumn(4 + k).width = isTot(p) || isGrand(p) ? 12 : 10; });

  const sumYear = y => Object.entries(total).reduce((s, [k, v]) => s + (+k.split('|')[1] === y ? v : 0), 0);
  return { wb, stats: { clients: clients.length, articles: sorted.length, caN1: sumYear(period.years[0]), caN: sumYear(period.years[1]) } };
}


// ── Mail ──────────────────────────────────────────────────────────────────────

// Même logique SMTP que backoffice.js : Paramètres > Email (data/settings.json) puis repli .env
async function sendMail(to, subject, html, attachments) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))?.smtp || {}; } catch {}
  const useSettings = !!(st.host && st.user && st.password);
  const cfg = useSettings
    ? { host: st.host, port: parseInt(st.port) || 587, secure: st.secure === true || st.secure === 'true', user: st.user, pass: st.password, from: st.from || st.user }
    : { host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT) || 587, secure: process.env.SMTP_SECURE === 'true', user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, from: process.env.SMTP_FROM || process.env.SMTP_USER };
  if (!cfg.host || !cfg.user) throw new Error('SMTP non configuré — Paramètres > Email');
  const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass }, family: 4 });
  await t.sendMail({ from: cfg.from, to: to.join(', '), subject, html, attachments });
}

const escH = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtE = n => (Math.round(n * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

function mailHTML(results, period, notes) {
  const [y0, y1] = period.years;
  const rows = results.map(x => {
    const ev = x.stats.caN1 ? (x.stats.caN / x.stats.caN1 - 1) * 100 : null;
    const evS = ev == null ? '—' : `<span style="color:${ev < 0 ? '#c62828' : '#2e7d32'}">${ev >= 0 ? '+' : ''}${ev.toFixed(1)} %</span>`;
    return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${escH(x.group.name)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${x.stats.clients}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${fmtE(x.stats.caN1)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${fmtE(x.stats.caN)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${evS}</td></tr>`;
  }).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#222">
  <p>Bonjour,</p>
  <p>Veuillez trouver ci-joint les statistiques Wavesoft par groupe de clients : <strong>CA HT cumulé du 1er janvier au ${escH(period.dateFr)}</strong>,
  comparé à la même période ${y0} (détail par classe et par article, mois par mois).</p>
  <table style="border-collapse:collapse;font-size:12px">
    <tr style="background:#1a237e;color:#fff"><th style="padding:6px 8px;text-align:left">Groupe</th><th style="padding:6px 8px">Clients actifs</th>
    <th style="padding:6px 8px">CA HT ${y0}</th><th style="padding:6px 8px">CA HT ${y1}</th><th style="padding:6px 8px">Évol.</th></tr>
    ${rows}
  </table>
  ${notes.length ? `<p style="color:#b26a00;font-size:12px"><strong>À noter :</strong><br>${notes.map(escH).join('<br>')}</p>` : ''}
  <p style="color:#999;font-size:11px">TB Reporting — envoi automatique du 1er du mois</p></div>`;
}

// ── Exécution ─────────────────────────────────────────────────────────────────

async function runStatGroupes(opts = {}) {
  const cfg = readConfig();
  const period = computePeriod(opts.runDate || new Date());
  const t0 = Date.now();
  const pool = await getConnPool(cfg.dbs || 'default');
  const { groupIds, missing } = await resolveClients(pool, cfg.groups);
  const allIds = new Set();
  for (const ids of groupIds.values()) ids.forEach(id => allIds.add(id));
  const rows = await fetchRows(pool, [...allIds], period);

  const results = [];
  for (const group of cfg.groups) {
    const ids = groupIds.get(group.name);
    const gRows = rows.filter(r => ids.has(r.tirid));
    const { wb, stats } = await buildWorkbook(group, gRows, period);
    const filename = `${group.name} au ${period.dateLabel} PAR CLASSE DETAIL ARTICLES.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
    results.push({ group, stats, filename, buffer: Buffer.from(await wb.xlsx.writeBuffer()) });
  }

  const notes = [];
  if (missing.length) notes.push(`Clients introuvables dans Wavesoft (raison sociale modifiée ?) : ${missing.join(' ; ')}`);

  // Écriture sur le partage NAS. On n'utilise PAS mkdir -p : si le partage n'est pas monté,
  // le dossier n'existe pas et on le signale au lieu d'écrire sur le disque local.
  const outDir = opts.outDir || cfg.outputDir;
  if (opts.write !== false && outDir) {
    try {
      if (!fs.existsSync(outDir)) throw new Error(`dossier introuvable « ${outDir} » (partage NAS non monté ?)`);
      for (const x of results) fs.writeFileSync(path.join(outDir, x.filename), x.buffer);
      console.log(`[STAT-GROUPES] ${results.length} fichiers écrits dans ${outDir}`);
    } catch (e) {
      console.error('[STAT-GROUPES] Écriture NAS :', e.message);
      notes.push(`Les fichiers n'ont pas pu être déposés sur le NAS : ${e.message}`);
    }
  }

  const dest = (cfg.recipients || []).filter(Boolean);
  if (opts.mail !== false && dest.length) {
    const subject = (cfg.subject || 'Stat Wavesoft groupes clients — {date}').replace('{date}', period.dateFr);
    await sendMail(dest, subject, mailHTML(results, period, notes),
      results.map(x => ({ filename: x.filename, content: x.buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })));
    console.log(`[STAT-GROUPES] Mail envoyé à ${dest.join(', ')}`);
  }
  missing.forEach(m => console.warn('[STAT-GROUPES] Client introuvable :', m));
  console.log(`[STAT-GROUPES] Terminé : arrêté au ${period.dateFr}, ${rows.length} lignes SQL, ${Math.round((Date.now() - t0) / 1000)}s`);
  return { period, results, notes };
}

function setupStatGroupesCron() {
  let cfg;
  try { cfg = readConfig(); } catch (e) { console.warn('[STAT-GROUPES] config illisible :', e.message); return; }
  if (!cfg.enabled || !cron.validate(cfg.cron || '')) { console.log('[STAT-GROUPES] Planification désactivée'); return; }
  cron.schedule(cfg.cron, () => {
    console.log(`[STAT-GROUPES] Déclenchement ${new Date().toISOString()}`);
    runStatGroupes().catch(e => console.error('[STAT-GROUPES] Erreur :', e.message));
  });
  console.log(`[STAT-GROUPES] Planification : ${cfg.cron} (timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
}

module.exports = { runStatGroupes, setupStatGroupesCron, computePeriod, buildWorkbook };

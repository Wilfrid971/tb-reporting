// Lancement manuel des stats Wavesoft par groupe de clients (même traitement que le cron du 1er du mois).
//   node scripts/stat-groupes.js                     → arrêté au dernier mois clos, écrit sur le NAS + mail
//   node scripts/stat-groupes.js --date 2026-10-01   → simule un lancement à cette date (arrêté au 30/09/2026)
//   node scripts/stat-groupes.js --no-mail           → n'envoie pas le mail
//   node scripts/stat-groupes.js --no-write          → n'écrit pas sur le NAS
//   node scripts/stat-groupes.js --out ./tmp         → écrit dans un autre dossier (doit exister)
//   node scripts/stat-groupes.js --find GOURBEYRE    → cherche un client (raison sociale ou code) : code, nom, catégorie, dernière vente
require('dotenv').config({ path: require('path').join(__dirname, '../.env'), quiet: true });
require('dns').setDefaultResultOrder('ipv4first');
const { runStatGroupes } = require('../server/jobs/stat-groupes');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

// Recherche d'un client renommé / introuvable, sans avoir à taper de SQL dans PuTTY
if (args.includes('--find')) {
  const txt = opt('--find');
  if (!txt) { console.error('Usage : --find TEXTE'); process.exit(1); }
  const { getConnPool, sql } = require('../config/database');
  const cfg = JSON.parse(require('fs').readFileSync(process.env.STAT_GROUPES_CONFIG || require('path').join(__dirname, '../config/stat-groupes.json'), 'utf8'));
  getConnPool(cfg.dbs || 'default').then(pool => pool.request()
    .input('t', sql.NVarChar(200), `%${txt}%`)
    .query(`SELECT t.TIRCODE AS code, RTRIM(t.TIRSOCIETE) AS nom, RTRIM(t.TIRCATEGORIE) AS categorie,
              CONVERT(VARCHAR(10), MAX(pv.PCVDATEEFFET), 103) AS derniere_piece
            FROM TIERS t LEFT JOIN PIECEVENTES pv ON pv.TIRID=t.TIRID
            WHERE t.TIRSOCIETE LIKE @t OR t.TIRCODE LIKE @t
            GROUP BY t.TIRID, t.TIRCODE, t.TIRSOCIETE, t.TIRCATEGORIE
            ORDER BY t.TIRSOCIETE`))
    .then(r => { console.table(r.recordset.map(x => ({ ...x, nom: `«${x.nom}»` }))); process.exit(0); })
    .catch(e => { console.error('Erreur :', e.message); process.exit(1); });
  return;
}
const date = opt('--date');
const runDate = date ? new Date(`${date}T12:00:00`) : new Date();
if (isNaN(runDate)) { console.error('Date invalide :', date); process.exit(1); }

runStatGroupes({
  runDate,
  mail:  !args.includes('--no-mail'),
  write: !args.includes('--no-write'),
  outDir: opt('--out'),
}).then(({ period, results, notes }) => {
  console.log(`\nArrêté au ${period.dateFr} — années ${period.years.join(', ')}, mois 1→${period.M}`);
  results.forEach(x => console.log(`  ${x.filename}  | ${x.stats.clients} clients, ${x.stats.articles} articles, CA ${period.years[0]} = ${x.stats.caN1.toFixed(2)}, CA ${period.years[1]} = ${x.stats.caN.toFixed(2)}`));
  notes.forEach(n => console.log('  ⚠', n));
  process.exit(0);
}).catch(e => { console.error('Erreur :', e.message); process.exit(1); });

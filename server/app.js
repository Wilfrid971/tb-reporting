require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getUserPool, sql } = require('../config/database');
const kpisConfig = require('../config/kpis.json');
const commercialRouter = require('./routes/commercial');
const { router: backofficeRouter, setupCronJobs } = require('./routes/backoffice');
const settingsRouter = require('./routes/settings');
const aiRouter    = require('./routes/ai');
const stockRouter = require('./routes/stock');
const prixRouter  = require('./routes/prix');
const authRouter  = require('./routes/auth');
const { authMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Auth routes — public (no JWT required)
app.use('/api/auth', authRouter);

// All other API routes — require valid JWT
app.use('/api/commercial', authMiddleware, commercialRouter);
app.use('/api/backoffice', authMiddleware, backofficeRouter);
app.use('/api/settings',  authMiddleware, settingsRouter);
app.use('/api/ai',        authMiddleware, aiRouter);
app.use('/api/stock',     authMiddleware, stockRouter);
app.use('/api/prix',      authMiddleware, prixRouter);

async function executeKpi(kpi, user) {
  const pool = await getUserPool(user);
  const result = await pool.request().query(kpi.query);
  return result.recordset;
}

// Liste de tous les KPIs (metadata seulement)
app.get('/api/kpis', authMiddleware, (req, res) => {
  const meta = kpisConfig.kpis.map(({ id, label, type, unit, format, color }) => ({
    id, label, type, unit, format, color,
  }));
  res.json({ source: kpisConfig.source, kpis: meta });
});

// Données d'un KPI par son id
app.get('/api/kpi/:id', authMiddleware, async (req, res) => {
  const kpi = kpisConfig.kpis.find(k => k.id === req.params.id);
  if (!kpi) return res.status(404).json({ error: 'KPI introuvable' });
  try {
    const rows = await executeKpi(kpi, req.user);
    res.json({ id: kpi.id, label: kpi.label, type: kpi.type, unit: kpi.unit, format: kpi.format, color: kpi.color, data: rows });
  } catch (err) {
    console.error(`[KPI:${kpi.id}]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Toutes les données du dashboard en un seul appel
app.get('/api/dashboard', authMiddleware, async (req, res) => {
  const results = await Promise.allSettled(
    kpisConfig.kpis.map(async kpi => {
      const rows = await executeKpi(kpi, req.user);
      return { id: kpi.id, label: kpi.label, type: kpi.type, unit: kpi.unit, format: kpi.format, color: kpi.color, data: rows };
    })
  );

  const kpis = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.error(`[KPI:${kpisConfig.kpis[i].id}]`, r.reason?.message);
    return { ...kpisConfig.kpis[i], data: null, error: r.reason?.message };
  });

  res.json({ source: kpisConfig.source, refreshInterval: kpisConfig.refresh_interval_seconds, generatedAt: new Date().toISOString(), kpis });
});

// Health check
app.get('/api/health', authMiddleware, async (req, res) => {
  try {
    const pool = await getUserPool(req.user);
    await pool.request().query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: err.message });
  }
});

app.listen(PORT, () => {
  setupCronJobs();
  console.log(`[SERVER] Dashboard disponible sur http://localhost:${PORT}`);
  console.log(`[SERVER] API disponible sur http://localhost:${PORT}/api/dashboard`);
});

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config/env');
const orderRoutes = require('./routes/orderRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const recommendationRoutes = require('./routes/recommendationRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const scoringRoutes = require('./routes/scoringRoutes');
const importRoutes = require('./routes/importRoutes');
const performanceRoutes = require('./routes/performanceRoutes');
const dailySyncRoutes = require('./routes/dailySyncRoutes');
const kiteRoutes   = require('./routes/kiteRoutes');
const breezeRoutes = require('./routes/breezeRoutes');
const brokerSetupRoutes    = require('./routes/brokerSetupRoutes');
const askDataRoutes = require('./routes/askDataRoutes');
const brokerTipsRoutes = require('./routes/brokerTipsRoutes');
const externalRecsRoutes = require('./routes/externalRecsRoutes');
const equityAdviceRoutes = require('./routes/equityAdviceRoutes');

const app = express();
const clientDistPath = path.resolve(__dirname, '..', '..', 'client', 'dist');

// Client-side imports serialize entire files into JSON payloads, so we need
// a larger request limit than Express's 100kb default.
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'ZTA-Codex', port: config.port });
});

app.use('/api/orders', orderRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/recommendations', recommendationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/scoring', scoringRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/daily-sync', dailySyncRoutes);
app.use('/api/kite',   kiteRoutes);
app.use('/api/breeze', breezeRoutes);
app.use('/api/broker-setup', brokerSetupRoutes);

// Who this instance belongs to. The app itself has no user table — it serves one person — so the
// name comes from the environment the hub started it with. Used for the sidebar, so a
// participant sees their own name rather than the developer's.
app.get('/api/whoami', (_req, res) => {
  const config = require('./config/env');
  const PF = require('./config/portfolios');
  res.json({ owner: config.instanceOwner, portfolios: PF.ALL });
});

app.use('/api/ask-data', askDataRoutes);
app.use('/api/broker-tips', brokerTipsRoutes);
app.use('/api/external-recs', externalRecsRoutes);
app.use('/api/equity-advice', equityAdviceRoutes);

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));

  app.get(/^(?!\/api\/|\/health$).*/, (_req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;

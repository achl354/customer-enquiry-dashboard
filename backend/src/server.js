require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const enquiriesRouter = require('./routes/enquiries');
const statsRouter = require('./routes/stats');
const ingestRouter = require('./routes/ingest');
const { startScheduledPolling } = require('./graph/poller');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/enquiries', enquiriesRouter);
app.use('/api/stats', statsRouter);
app.use('/api/ingest', ingestRouter);

// Serve the built frontend (frontend/dist) when present, so a single-service
// deploy (e.g. Render) works with one origin and no CORS to manage. Absent
// in local dev, where the frontend runs as its own Vite server instead — so
// this is skipped there rather than erroring on a missing folder.
const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Customer enquiry dashboard API listening on port ${PORT}`);
  startScheduledPolling();
});

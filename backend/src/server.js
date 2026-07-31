require('dotenv').config();
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

app.listen(PORT, () => {
  console.log(`Customer enquiry dashboard API listening on port ${PORT}`);
  startScheduledPolling();
});

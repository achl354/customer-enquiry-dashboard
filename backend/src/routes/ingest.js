const express = require('express');
const { runPollOnce, isGraphConfigured } = require('../graph/poller');
const aiClassifier = require('../ai/classifier');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({
    graphConfigured: isGraphConfigured(),
    aiConfigured: aiClassifier.isConfigured(),
    mailbox: process.env.MAILBOX || null,
  });
});

router.post('/run', async (req, res) => {
  if (!isGraphConfigured()) {
    return res.status(400).json({ error: 'Microsoft Graph is not configured. Set TENANT_ID, CLIENT_ID, CLIENT_SECRET, MAILBOX in .env' });
  }
  try {
    const result = await runPollOnce();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

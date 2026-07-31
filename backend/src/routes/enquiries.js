const express = require('express');
const repo = require('../db/repository');

const router = express.Router();

const VALID_STATUSES = ['NEW', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'IGNORED'];

router.get('/', (req, res) => {
  const { category, priority, status, search, sort, order, limit, offset } = req.query;
  const result = repo.listEnquiries({
    category: category || undefined,
    priority: priority || undefined,
    status: status || undefined,
    search: search || undefined,
    sort: sort || undefined,
    order: order || undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(result);
});

router.get('/:id', (req, res) => {
  const enquiry = repo.getEnquiry(req.params.id);
  if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });
  res.json(enquiry);
});

router.patch('/:id', (req, res) => {
  const { status, assignedTo } = req.body || {};
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  const existing = repo.getEnquiry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  const updated = repo.updateEnquiry(req.params.id, { status, assignedTo });
  res.json(updated);
});

module.exports = router;

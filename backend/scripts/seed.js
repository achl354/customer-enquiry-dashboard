const fs = require('fs');
const path = require('path');
const repo = require('../src/db/repository');
const db = require('../src/db');

const emails = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed-data', 'sample-emails.json'), 'utf8'));

db.exec('DELETE FROM enquiries');

let ingested = 0;
for (const email of emails) {
  const id = repo.ingestEmail(email);
  if (id) ingested += 1;
}

// Give a handful of enquiries varied statuses/assignees so the dashboard demos
// realistically instead of everything sitting in NEW.
const demoUpdates = [
  { graphMessageId: 'seed-11', status: 'RESOLVED', assignedTo: 'Paula Perdomo' },
  { graphMessageId: 'seed-14', status: 'RESOLVED', assignedTo: 'Paula Perdomo' },
  { graphMessageId: 'seed-8', status: 'IN_PROGRESS', assignedTo: 'Paula Perdomo' },
  { graphMessageId: 'seed-13', status: 'IN_PROGRESS', assignedTo: 'Scott Borresen' },
  { graphMessageId: 'seed-20', status: 'IN_PROGRESS', assignedTo: 'Paula Perdomo' },
  { graphMessageId: 'seed-24', status: 'IN_PROGRESS', assignedTo: 'Scott Borresen' },
  { graphMessageId: 'seed-12', status: 'WAITING_ON_CUSTOMER', assignedTo: 'Paula Perdomo' },
  { graphMessageId: 'seed-1', status: 'IGNORED', assignedTo: null },
  { graphMessageId: 'seed-2', status: 'IGNORED', assignedTo: null },
  { graphMessageId: 'seed-9', status: 'IGNORED', assignedTo: null },
  { graphMessageId: 'seed-6', status: 'IGNORED', assignedTo: null },
  { graphMessageId: 'seed-7', status: 'IGNORED', assignedTo: null },
];

for (const u of demoUpdates) {
  repo.updateEnquiry(u.graphMessageId, { status: u.status, assignedTo: u.assignedTo });
}

console.log(`Seeded ${ingested} of ${emails.length} sample enquiries (some already present were skipped).`);

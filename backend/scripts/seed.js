require('dotenv').config();
const fs = require('fs');
const path = require('path');
const repo = require('../src/db/repository');
const db = require('../src/db');

const emails = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed-data', 'sample-emails.json'), 'utf8'));

/**
 * @param {object} opts
 * @param {boolean} opts.force - Wipe and reseed even if data already exists.
 *   Defaults to false so a background/boot-time call is a safe no-op on an
 *   already-seeded database — without this, every server restart (every
 *   redeploy, or the free tier waking from its idle spin-down) would
 *   silently wipe the table and re-run all 114 emails through the AI
 *   classifier again, re-spending real API cost for zero new data. `npm run
 *   seed` (direct CLI use) always forces, since that's someone deliberately
 *   asking to reset the demo data.
 *
 *   Checked against emails.length, not just "any rows at all": this table
 *   is wiped (DELETE) before the insert loop below, which is sequential and
 *   can take minutes with AI classification configured — if the process is
 *   killed mid-loop (very plausible for a SEED_ON_BOOT run on Render's free
 *   tier, whose whole premise is idle spin-down/restarts), a naive ">0"
 *   check would see that partial count next boot and treat it as "already
 *   fully seeded" forever, with no automatic way to recover. ">= expected
 *   count" instead only skips once the seed genuinely completed (and still
 *   correctly skips if live-polled data has since grown the table beyond
 *   the seed file's own size).
 */
async function main({ force = false } = {}) {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM enquiries').get().c;
  if (existingCount >= emails.length && !force) {
    console.log(`Skipping seed — ${existingCount} enquiries already present (>= the ${emails.length} in seed data). Run "npm run seed" directly (which always reseeds) if you want to reset the demo data.`);
    return;
  }
  if (existingCount > 0 && existingCount < emails.length) {
    console.log(`Found ${existingCount} enquiries, fewer than the ${emails.length} in seed data — treating as an incomplete previous seed and reseeding fully.`);
  }

  db.exec('DELETE FROM enquiries');

  let ingested = 0;
  for (const email of emails) {
    // Sequential on purpose: keeps AI classification calls (when configured)
    // easy to reason about and avoids bursting rate limits on a cold seed.
    const id = await repo.ingestEmail(email);
    if (id) ingested += 1;
  }

  // Give a handful of enquiries varied statuses so the dashboard demos
  // realistically instead of everything sitting in NEW.
  const demoUpdates = [
    { graphMessageId: 'seed-11', status: 'RESOLVED' },
    { graphMessageId: 'seed-14', status: 'RESOLVED' },
    { graphMessageId: 'seed-8', status: 'IN_PROGRESS' },
    { graphMessageId: 'seed-13', status: 'IN_PROGRESS' },
    { graphMessageId: 'seed-20', status: 'IN_PROGRESS' },
    { graphMessageId: 'seed-24', status: 'IN_PROGRESS' },
    { graphMessageId: 'seed-12', status: 'WAITING_ON_CUSTOMER' },
    { graphMessageId: 'seed-1', status: 'IGNORED' },
    { graphMessageId: 'seed-2', status: 'IGNORED' },
    { graphMessageId: 'seed-9', status: 'IGNORED' },
    { graphMessageId: 'seed-6', status: 'IGNORED' },
    { graphMessageId: 'seed-7', status: 'IGNORED' },
  ];

  for (const u of demoUpdates) {
    repo.updateEnquiry(u.graphMessageId, { status: u.status });
  }

  console.log(`Seeded ${ingested} of ${emails.length} sample enquiries (some already present were skipped).`);
}

// Runs immediately when invoked as a CLI script (`npm run seed`), but not
// when required as a module (e.g. server.js firing this in the background
// after boot) — the caller decides when to actually run it.
if (require.main === module) {
  main({ force: true }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };

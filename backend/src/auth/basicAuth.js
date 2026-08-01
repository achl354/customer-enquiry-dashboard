const crypto = require('crypto');

const USERNAME = process.env.DASHBOARD_USERNAME;
const PASSWORD = process.env.DASHBOARD_PASSWORD;

function isConfigured() {
  return Boolean(USERNAME && PASSWORD);
}

// Fixed-length digest comparison avoids both the "different length throws"
// footgun of crypto.timingSafeEqual on raw strings and any timing side
// channel from a short-circuiting string compare.
function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// The dashboard shows real customer/health-department correspondence with
// no other access control, so this is a floor, not a nice-to-have — but it
// stays opt-in (skipped entirely when unconfigured) so local dev and the
// health check endpoint (which Render polls with no credentials) aren't
// blocked by it.
function requireAuth(req, res, next) {
  if (!isConfigured() || req.path === '/api/health') return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = sep === -1 ? decoded : decoded.slice(0, sep);
    const pass = sep === -1 ? '' : decoded.slice(sep + 1);
    if (safeEqual(user, USERNAME) && safeEqual(pass, PASSWORD)) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Customer Enquiry Dashboard"');
  return res.status(401).send('Authentication required.');
}

module.exports = { requireAuth, isConfigured };

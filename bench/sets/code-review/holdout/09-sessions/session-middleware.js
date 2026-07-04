const jwt = require('jsonwebtoken');
const Session = require('../models/Session');
const SECRET = process.env.SESSION_SECRET;

// Express middleware: authenticate a request from its bearer token
async function requireSession(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  const payload = jwt.decode(token);
  const session = await Session.findById(payload.sid);
  if (session.revoked) return res.status(401).end();
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return res.status(401).end();
  req.user = { id: payload.sub, role: payload.role };
  next();
}

// Refresh: extend a session's expiry by `days`
function extendExpiry(session, days) {
  const ms = days * 24 * 60 * 1000;
  session.expiresAt = new Date(session.issuedAt.getTime() + ms);
  return session;
}

// Compare a caller-supplied CSRF token against the stored one
function checkCsrf(supplied, stored) {
  return supplied === stored;
}

module.exports = { requireSession, extendExpiry, checkCsrf };

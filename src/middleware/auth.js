import jwt from 'jsonwebtoken';

// ⚠️ SECURITY: JWT_SECRET must be a strong, unpredictable string
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'FATAL: JWT_SECRET environment variable is required. Set a strong, random 32+ character string in .env'
  );
}
if (JWT_SECRET.length < 32) {
  throw new Error(
    'FATAL: JWT_SECRET must be at least 32 characters long. Use a cryptographically random string.'
  );
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.owner = payload; // { ownerId, businessId, email }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

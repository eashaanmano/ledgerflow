import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createAuth({ apiKeys, jwtSecret, jwtTtlSec }) {
  // Keys are held only as hashes, so a heap dump or log line never reveals a usable key.
  const byKeyHash = new Map(apiKeys.map((k) => [sha256(k.key), k]));
  const limitsByClient = new Map(apiKeys.map((k) => [k.clientId, { rate: k.rate, burst: k.burst }]));
  const defaultLimits = { rate: 20, burst: 40 };

  function fromApiKey(key) {
    const entry = byKeyHash.get(sha256(key));
    return entry ? { clientId: entry.clientId, rate: entry.rate, burst: entry.burst, via: 'api_key' } : null;
  }

  function fromJwt(token) {
    try {
      const claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'], issuer: 'ledgerflow-gateway' });
      return { clientId: claims.sub, ...(limitsByClient.get(claims.sub) ?? defaultLimits), via: 'jwt' };
    } catch {
      return null;
    }
  }

  function resolve(req, { allowQueryToken = false } = {}) {
    const apiKey = req.get('x-api-key');
    if (apiKey) return fromApiKey(apiKey);
    const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) return bearer.startsWith('sk_') ? fromApiKey(bearer) : fromJwt(bearer);
    // EventSource cannot set headers. Only short-lived JWTs are accepted in the URL, never API keys.
    if (allowQueryToken && typeof req.query.access_token === 'string') return fromJwt(req.query.access_token);
    return null;
  }

  const middleware = (opts) => (req, res, next) => {
    const client = resolve(req, opts);
    if (!client) {
      return res.status(401).json({ error: { code: 'unauthenticated', message: 'Provide a valid API key or bearer token' } });
    }
    req.client = client;
    return next();
  };

  function issueToken(clientId) {
    return jwt.sign({}, jwtSecret, { algorithm: 'HS256', subject: clientId, expiresIn: jwtTtlSec, issuer: 'ledgerflow-gateway' });
  }

  return { middleware, issueToken };
}

import { readFileSync } from 'node:fs';

const lua = readFileSync(new URL('./tokenBucket.lua', import.meta.url), 'utf8');

export function createRateLimiter(redis, { log }) {
  redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua });

  /** Express middleware; expects req.client = { clientId, rate, burst } from the auth step. */
  return async function rateLimit(req, res, next) {
    const { clientId, rate, burst } = req.client;
    try {
      const [allowed, remaining, retryAfterMs] = await redis.tokenBucket(`ratelimit:${clientId}`, burst, rate, 1);
      res.set('RateLimit-Limit', String(burst));
      res.set('RateLimit-Remaining', String(remaining));
      if (allowed === 1) return next();
      res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return res.status(429).json({ error: { code: 'rate_limited', message: `Rate limit of ${rate}/s exceeded`, retryAfterMs } });
    } catch (err) {
      // Fail open: if Redis is down we would rather serve traffic than reject every payment.
      log.warn('rate limiter unavailable, allowing request', { error: err.message, requestId: req.id });
      return next();
    }
  };
}

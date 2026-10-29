import express from 'express';
import Redis from 'ioredis';
import { verify } from './verify.js';

/*
 * A stand-in for a customer's webhook endpoint. State lives in Redis so that killing and
 * restarting this container (the chaos test) does not lose the record of what was received.
 */
const PORT = Number(process.env.PORT ?? 4000);
const SECRET = process.env.MOCK_RECEIVER_SECRET ?? 'whsec_demo_receiver_secret';
const MODES = ['ok', 'fail', 'flaky', 'timeout'];
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const K = { mode: 'mock:mode', ids: 'mock:received_ids', transfers: 'mock:received_transfer_ids', posts: 'mock:posts', dups: 'mock:duplicates', recent: 'mock:recent', badSig: 'mock:bad_signatures' };

const app = express();

app.post('/hooks', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  const problem = verify(SECRET, raw, req.get('ledgerflow-signature'));
  if (problem) {
    await redis.incr(K.badSig);
    return res.status(400).json({ error: problem });
  }

  const mode = (await redis.get(K.mode)) ?? 'ok';
  if (mode === 'fail' || (mode === 'flaky' && Math.random() < 0.5)) {
    return res.status(500).json({ error: `mock receiver in ${mode} mode` });
  }
  if (mode === 'timeout') {
    await new Promise((r) => setTimeout(r, 15_000));
  }

  // Dedupe on event id, exactly as the docs tell receivers to do.
  const eventId = req.get('ledgerflow-event-id');
  if (req.get('ledgerflow-event-type') === 'transfer.completed') {
    await redis.sadd(K.transfers, JSON.parse(raw).data.id);
  }
  const isNew = (await redis.sadd(K.ids, eventId)) === 1;
  await redis.incr(K.posts);
  if (!isNew) await redis.incr(K.dups);
  await redis
    .multi()
    .lpush(K.recent, JSON.stringify({ eventId, type: req.get('ledgerflow-event-type'), attempt: Number(req.get('ledgerflow-attempt')), duplicate: !isNew, at: new Date().toISOString() }))
    .ltrim(K.recent, 0, 49)
    .exec();
  return res.status(200).json({ received: true, duplicate: !isNew });
});

app.get('/config', async (_req, res) => {
  res.json({ mode: (await redis.get(K.mode)) ?? 'ok', modes: MODES });
});

app.put('/config', express.json(), async (req, res) => {
  const mode = req.body?.mode;
  if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
  await redis.set(K.mode, mode);
  return res.json({ mode });
});

app.get('/received', async (_req, res) => {
  const [unique, posts, duplicates, badSignatures, recent] = await Promise.all([
    redis.scard(K.ids), redis.get(K.posts), redis.get(K.dups), redis.get(K.badSig), redis.lrange(K.recent, 0, 49),
  ]);
  res.json({
    uniqueEvents: unique,
    totalPosts: Number(posts ?? 0),
    duplicates: Number(duplicates ?? 0),
    badSignatures: Number(badSignatures ?? 0),
    recent: recent.map((r) => JSON.parse(r)),
  });
});

// Used by the chaos test: which of these transfers has the receiver NOT seen a webhook for?
app.post('/received/check', express.json({ limit: '2mb' }), async (req, res) => {
  const ids = Array.isArray(req.body?.transferIds) ? req.body.transferIds : [];
  const flags = ids.length ? await redis.smismember(K.transfers, ...ids) : [];
  res.json({ checked: ids.length, missing: ids.filter((_, i) => flags[i] === 0) });
});

app.delete('/received', async (_req, res) => {
  await redis.del(K.ids, K.transfers, K.posts, K.dups, K.recent, K.badSig);
  res.status(204).end();
});

app.get('/health', (_req, res) => res.json({ status: 'UP' }));

app.listen(PORT, () => console.log(JSON.stringify({ service: 'mock-receiver', msg: 'listening', port: PORT })));

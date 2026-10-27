import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { config } from '../src/config.js';
import { deliverOnce } from '../src/delivery.js';
import { verifySignature } from '../src/signing.js';

let server;
let baseUrl;
const received = [];
let mode = 'ok';

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, raw });
      if (mode === 'hang') return; // never respond
      res.writeHead(mode === 'ok' ? 200 : 503, { 'content-type': 'text/plain' }).end(mode === 'ok' ? 'thanks' : 'down');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.closeAllConnections() || server.close());

const delivery = (url) => ({
  id: 'd1', event_id: 'e1', event_type: 'transfer.completed', attempts: 0, request_id: 'req-123',
  url, secret: 'whsec_receiver_secret_1', payload: { id: 'e1', type: 'transfer.completed', data: { amount: 42 } },
});

test('successful delivery is signed and carries tracing headers', async () => {
  mode = 'ok';
  const result = await deliverOnce(delivery(`${baseUrl}/hook`));
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.snippet, 'thanks');

  const { headers, raw } = received.at(-1);
  assert.equal(headers['ledgerflow-event-id'], 'e1');
  assert.equal(headers['x-request-id'], 'req-123');
  assert.equal(verifySignature('whsec_receiver_secret_1', raw, headers['ledgerflow-signature']).ok, true);
});

test('5xx is a failed attempt', async () => {
  mode = 'fail';
  const result = await deliverOnce(delivery(`${baseUrl}/hook`));
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
});

test('connection refused is a failed attempt, not a crash', async () => {
  const result = await deliverOnce(delivery('http://127.0.0.1:1/hook'));
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, null);
  assert.ok(result.error);
});

test('a hanging receiver times out', async () => {
  config.deliveryTimeoutMs = 300;
  mode = 'hang';
  const result = await deliverOnce(delivery(`${baseUrl}/hook`));
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout/);
});

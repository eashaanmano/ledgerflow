import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSignature, signatureHeader, verifySignature } from '../src/signing.js';

const secret = 'whsec_test_secret_value';
const body = JSON.stringify({ id: 'evt_1', type: 'transfer.completed', data: { amount: 500 } });

test('a freshly signed payload verifies', () => {
  const header = signatureHeader(secret, body);
  assert.deepEqual(verifySignature(secret, body, header), { ok: true });
});

test('tampered body is rejected', () => {
  const header = signatureHeader(secret, body);
  const tampered = body.replace('500', '50000');
  assert.equal(verifySignature(secret, tampered, header).reason, 'signature_mismatch');
});

test('wrong secret is rejected', () => {
  const header = signatureHeader(secret, body);
  assert.equal(verifySignature('whsec_attacker_guess_123', body, header).reason, 'signature_mismatch');
});

test('replay outside the tolerance window is rejected', () => {
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
  const header = signatureHeader(secret, body, tenMinutesAgo);
  assert.equal(verifySignature(secret, body, header).reason, 'timestamp_out_of_tolerance');
});

test('moving the timestamp forward breaks the signature', () => {
  const old = Math.floor(Date.now() / 1000) - 600;
  const v1 = computeSignature(secret, old, body);
  const forged = `t=${Math.floor(Date.now() / 1000)},v1=${v1}`;
  assert.equal(verifySignature(secret, body, forged).reason, 'signature_mismatch');
});

test('malformed headers are rejected without throwing', () => {
  for (const h of [undefined, '', 'garbage', 't=abc,v1=zz', 'v1=deadbeef']) {
    assert.equal(verifySignature(secret, body, h).ok, false);
  }
});

test('any matching v1 is accepted, which allows secret rotation', () => {
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${computeSignature('old_secret_value_1234', t, body)},v1=${computeSignature(secret, t, body)}`;
  assert.equal(verifySignature(secret, body, header).ok, true);
});

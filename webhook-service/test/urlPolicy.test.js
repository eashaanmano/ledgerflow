import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEndpointUrl, isPrivateAddress } from '../src/urlPolicy.js';

test('private and reserved addresses are detected', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

const resolveTo = (address) => async () => [{ address }];

test('cloud metadata endpoint is refused', async () => {
  assert.match(await checkEndpointUrl('https://169.254.169.254/latest', {}), /private/);
});

test('hostnames resolving to internal IPs are refused', async () => {
  assert.match(await checkEndpointUrl('https://evil.example.com/hook', { resolve: resolveTo('10.0.0.5') }), /private/);
});

test('public https endpoint is accepted', async () => {
  assert.equal(await checkEndpointUrl('https://hooks.example.com/x', { resolve: resolveTo('93.184.216.34') }), null);
});

test('plain http and embedded credentials are refused', async () => {
  assert.match(await checkEndpointUrl('http://hooks.example.com/x', { resolve: resolveTo('93.184.216.34') }), /https/);
  assert.match(await checkEndpointUrl('https://u:p@hooks.example.com/x', {}), /credentials/);
  assert.match(await checkEndpointUrl('ftp://x.com', {}), /http/);
});

test('demo mode allows docker-network receivers', async () => {
  assert.equal(await checkEndpointUrl('http://mock-receiver:4000/hooks', { allowPrivate: true }), null);
});

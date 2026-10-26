import { lookup } from 'node:dns/promises';
import net from 'node:net';

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const n = ipv4ToInt(address);
    return PRIVATE_V4.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd') || /^fe[89ab]/.test(a);
  }
  return true;
}

/**
 * Returns an error message, or null if the URL is acceptable.
 * Blocks endpoints that resolve to internal addresses (SSRF). This is a registration-time check;
 * a hardened version would also pin the resolved IP at delivery time to defeat DNS rebinding.
 */
export async function checkEndpointUrl(raw, { allowPrivate, resolve = lookup } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'url is not a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url must use http or https';
  if (url.username || url.password) return 'url must not contain credentials';
  if (allowPrivate) return null;
  if (url.protocol !== 'https:') return 'url must use https';

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await resolve(host, { all: true }).catch(() => null);
  if (!addresses || addresses.length === 0) return 'url host does not resolve';
  if (addresses.some(({ address }) => isPrivateAddress(address))) return 'url resolves to a private or reserved address';
  return null;
}

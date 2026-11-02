export function money(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}${major}.${String(abs % 100).padStart(2, '0')} ${currency}`;
}

/** Parses "12.5" into 1250 minor units without going through floating point. */
export function parseMoney(input: string): number | null {
  const m = input.trim().match(/^(\d{1,10})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return minor > 0 ? minor : null;
}

export const shortId = (id: string) => id.slice(0, 8);

export function time(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}

export function relative(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (Math.abs(s) < 1) return 'now';
  return s > 0 ? `in ${s}s` : `${-s}s ago`;
}

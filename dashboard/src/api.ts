const KEY_STORAGE = 'ledgerflow.apiKey';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string | null,
  ) {
    super(message);
  }
}

let apiKey: string | null = safeGet(KEY_STORAGE);
let token: { value: string; expiresAt: number; clientId: string } | null = null;

function safeGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}

function decodeSub(jwt: string): string {
  try {
    return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub ?? '';
  } catch {
    return '';
  }
}

async function readError(res: Response): Promise<ApiError> {
  const requestId = res.headers.get('x-request-id');
  try {
    const body = await res.json();
    return new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText, requestId);
  } catch {
    return new ApiError(res.status, 'error', res.statusText, requestId);
  }
}

/** The API key never leaves this tab except to mint a short-lived JWT; every other call uses the JWT. */
export async function getToken(force = false): Promise<string> {
  if (!apiKey) throw new ApiError(401, 'unauthenticated', 'No API key', null);
  if (!force && token && token.expiresAt - Date.now() > 30_000) return token.value;
  const res = await fetch('/v1/auth/token', { method: 'POST', headers: { 'x-api-key': apiKey } });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { accessToken: string; expiresIn: number };
  token = { value: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000, clientId: decodeSub(body.accessToken) };
  return token.value;
}

export async function login(key: string): Promise<string> {
  apiKey = key.trim();
  token = null;
  await getToken(true);
  try {
    sessionStorage.setItem(KEY_STORAGE, apiKey);
  } catch {
    /* storage unavailable; stay logged in for this page only */
  }
  return token!.clientId;
}

export function logout() {
  apiKey = null;
  token = null;
  try {
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

export const hasStoredKey = () => apiKey !== null;

export async function restoreSession(): Promise<string> {
  await getToken(true);
  return token!.clientId;
}

interface Options {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
}

export interface Meta {
  status: number;
  requestId: string | null;
  replayed: boolean;
}

export async function apiWithMeta<T>(path: string, opts: Options = {}, retried = false): Promise<{ data: T; meta: Meta }> {
  const headers: Record<string, string> = { authorization: `Bearer ${await getToken()}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  const res = await fetch(`/v1${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && !retried) {
    await getToken(true);
    return apiWithMeta<T>(path, opts, true);
  }
  if (!res.ok) throw await readError(res);
  const meta = {
    status: res.status,
    requestId: res.headers.get('x-request-id'),
    replayed: res.headers.get('idempotent-replayed') === 'true',
  };
  const text = res.status === 204 ? '' : await res.text();
  return { data: (text ? JSON.parse(text) : undefined) as T, meta };
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  return (await apiWithMeta<T>(path, opts)).data;
}

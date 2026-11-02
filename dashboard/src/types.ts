export interface Account {
  id: string;
  clientId: string;
  name: string;
  currency: string;
  type: 'USER' | 'SYSTEM';
  balance: number;
  createdAt: string;
}

export interface Transfer {
  id: string;
  clientId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency: string;
  kind: 'TRANSFER' | 'DEPOSIT';
  status: string;
  description?: string;
  requestId?: string;
  createdAt: string;
}

export interface LedgerEvent<T = unknown> {
  id: string;
  type: string;
  createdAt: string;
  requestId?: string;
  clientIds: string[];
  data: T;
}

export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'dead';

export interface Delivery {
  id: string;
  eventId: string;
  eventType: string;
  endpointId: string;
  url: string;
  status: DeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  deliveredAt: string | null;
  requestId: string | null;
}

export interface DeliveryAttempt {
  attempt: number;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  responseSnippet: string | null;
  createdAt: string;
}

export interface DeliveryDetail extends Delivery {
  payload: LedgerEvent;
  attemptLog: DeliveryAttempt[];
}

export interface Endpoint {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  secretHint: string;
  createdAt: string;
}

export interface ReceiverState {
  uniqueEvents: number;
  totalPosts: number;
  duplicates: number;
  badSignatures: number;
  recent: { eventId: string; type: string; attempt: number; duplicate: boolean; at: string }[];
}

export interface ReconciliationRun {
  ok: boolean;
  total_sum: number;
  unbalanced_transfers: number;
  mismatched_accounts: number;
  finished_at: string;
}

export interface BreakerSnapshot {
  name: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  total: number;
  failures: number;
}

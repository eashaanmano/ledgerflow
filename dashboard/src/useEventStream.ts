import { useEffect, useRef, useState } from 'react';
import { getToken } from './api';
import type { LedgerEvent } from './types';

const EVENT_TYPES = ['transfer.completed', 'account.created'];

/**
 * Subscribes to the gateway's SSE stream. EventSource cannot send headers, so it authenticates
 * with a short-lived JWT in the URL. When the token expires the stream is rebuilt with a fresh
 * token and the last seen id, so nothing is missed across the reconnect.
 */
export function useEventStream(onEvent: (e: LedgerEvent) => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let source: EventSource | null = null;
    let lastId = '';
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      try {
        const token = await getToken();
        if (cancelled) return;
        const params = new URLSearchParams({ access_token: token });
        if (lastId) params.set('last_event_id', lastId);
        source = new EventSource(`/v1/events/stream?${params}`);
        source.onopen = () => setConnected(true);
        source.onerror = () => {
          setConnected(false);
          if (source?.readyState === EventSource.CLOSED) {
            source = null;
            retryTimer = setTimeout(connect, 2000);
          }
        };
        for (const type of EVENT_TYPES) {
          source.addEventListener(type, (msg) => {
            const m = msg as MessageEvent<string>;
            lastId = m.lastEventId || lastId;
            handler.current(JSON.parse(m.data) as LedgerEvent);
          });
        }
      } catch {
        retryTimer = setTimeout(connect, 3000);
      }
    };

    connect();
    // Rebuild before the 15-minute token expires; the server-side backfill covers the gap.
    const rotate = setInterval(() => {
      source?.close();
      source = null;
      connect();
    }, 10 * 60_000);

    return () => {
      cancelled = true;
      clearInterval(rotate);
      clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  return connected;
}

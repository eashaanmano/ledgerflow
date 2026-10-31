/*
 * One Redis XREAD loop feeds every connected SSE client, filtered by client id, instead of
 * one blocking Redis connection per browser tab.
 */
export class EventHub {
  constructor(redis, stream, { log }) {
    this.redis = redis;
    this.stream = stream;
    this.log = log;
    this.subscribers = new Set();
    this.lastId = '$';
    this.stopped = false;
  }

  async start() {
    while (!this.stopped) {
      try {
        const res = await this.redis.xread('COUNT', 200, 'BLOCK', 5000, 'STREAMS', this.stream, this.lastId);
        for (const [, entries] of res ?? []) {
          for (const [id, fields] of entries) {
            this.lastId = id;
            this.#broadcast(id, fields);
          }
        }
      } catch (err) {
        this.log.warn('event hub read failed', { error: err.message });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  stop() {
    this.stopped = true;
  }

  /** Replays entries after `lastEventId` so a reconnecting EventSource does not miss anything. */
  async backfill(sub, lastEventId) {
    if (!/^\d+-\d+$/.test(lastEventId ?? '')) return;
    const entries = await this.redis.xrange(this.stream, `(${lastEventId}`, '+', 'COUNT', 500);
    for (const [id, fields] of entries) this.#send(sub, id, fields);
  }

  subscribe(sub) {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  #broadcast(id, fields) {
    for (const sub of this.subscribers) this.#send(sub, id, fields);
  }

  #send(sub, id, fields) {
    const msg = {};
    for (let i = 0; i < fields.length; i += 2) msg[fields[i]] = fields[i + 1];
    let event;
    try {
      event = JSON.parse(msg.payload);
    } catch {
      return;
    }
    if (!event.clientIds?.includes(sub.clientId)) return;
    sub.res.write(`id: ${id}\nevent: ${event.type}\ndata: ${msg.payload}\n\n`);
  }
}

CREATE TABLE IF NOT EXISTS endpoints (
    id           UUID PRIMARY KEY,
    client_id    TEXT        NOT NULL,
    url          TEXT        NOT NULL,
    secret       TEXT        NOT NULL,
    events       TEXT[]      NOT NULL,
    description  TEXT,
    active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS endpoints_client_idx ON endpoints (client_id) WHERE active;

-- One row per (event, endpoint). The unique constraint is what turns at-least-once input from
-- the stream into exactly-one delivery job per endpoint, even when the ledger republishes.
-- status = 'dead' rows are the dead-letter queue.
CREATE TABLE IF NOT EXISTS deliveries (
    id                UUID PRIMARY KEY,
    event_id          UUID        NOT NULL,
    event_type        TEXT        NOT NULL,
    endpoint_id       UUID        NOT NULL REFERENCES endpoints (id),
    client_id         TEXT        NOT NULL,
    payload           JSONB       NOT NULL,
    request_id        TEXT,
    status            TEXT        NOT NULL CHECK (status IN ('pending', 'delivering', 'succeeded', 'dead')),
    attempts          INT         NOT NULL DEFAULT 0,
    next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_expires_at  TIMESTAMPTZ,
    last_status_code  INT,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at      TIMESTAMPTZ,
    UNIQUE (event_id, endpoint_id)
);
CREATE INDEX IF NOT EXISTS deliveries_due_idx ON deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS deliveries_lease_idx ON deliveries (lease_expires_at) WHERE status = 'delivering';
CREATE INDEX IF NOT EXISTS deliveries_client_idx ON deliveries (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS delivery_attempts (
    id                BIGSERIAL PRIMARY KEY,
    delivery_id       UUID        NOT NULL REFERENCES deliveries (id),
    attempt           INT         NOT NULL,
    status_code       INT,
    error             TEXT,
    duration_ms       INT         NOT NULL,
    response_snippet  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_attempts_delivery_idx ON delivery_attempts (delivery_id, attempt);

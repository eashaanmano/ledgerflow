CREATE TABLE accounts (
    id          UUID PRIMARY KEY,
    client_id   TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    currency    CHAR(3)     NOT NULL,
    type        TEXT        NOT NULL CHECK (type IN ('USER', 'SYSTEM')),
    -- Cached running balance in minor units. The journal is the source of truth;
    -- reconciliation verifies this column against SUM(journal_entries.amount).
    balance     BIGINT      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Last line of defence: even if application logic regresses, a user account cannot go negative.
    CONSTRAINT user_balance_non_negative CHECK (type = 'SYSTEM' OR balance >= 0)
);
CREATE INDEX accounts_client_idx ON accounts (client_id, created_at DESC);

CREATE TABLE transfers (
    id               UUID PRIMARY KEY,
    client_id        TEXT        NOT NULL,
    from_account_id  UUID        NOT NULL REFERENCES accounts (id),
    to_account_id    UUID        NOT NULL REFERENCES accounts (id),
    amount           BIGINT      NOT NULL CHECK (amount > 0),
    currency         CHAR(3)     NOT NULL,
    kind             TEXT        NOT NULL CHECK (kind IN ('TRANSFER', 'DEPOSIT')),
    status           TEXT        NOT NULL,
    description      TEXT,
    request_id       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (from_account_id <> to_account_id)
);
CREATE INDEX transfers_client_idx ON transfers (client_id, created_at DESC);

-- Signed amounts: debit is negative, credit is positive. Every transfer writes exactly
-- two rows that sum to zero, so SUM(amount) over the whole table must always be 0.
CREATE TABLE journal_entries (
    id             BIGSERIAL PRIMARY KEY,
    transfer_id    UUID        NOT NULL REFERENCES transfers (id),
    account_id     UUID        NOT NULL REFERENCES accounts (id),
    amount         BIGINT      NOT NULL CHECK (amount <> 0),
    balance_after  BIGINT      NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_account_idx ON journal_entries (account_id, id DESC);
CREATE INDEX journal_entries_transfer_idx ON journal_entries (transfer_id);

CREATE TABLE idempotency_keys (
    client_id        TEXT        NOT NULL,
    idempotency_key  TEXT        NOT NULL,
    request_hash     TEXT        NOT NULL,
    response_status  INT,
    response_body    JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, idempotency_key)
);

CREATE TABLE outbox_events (
    seq           BIGSERIAL PRIMARY KEY,
    id            UUID        NOT NULL UNIQUE,
    event_type    TEXT        NOT NULL,
    aggregate_id  UUID        NOT NULL,
    payload       JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (seq) WHERE published_at IS NULL;

CREATE TABLE reconciliation_runs (
    id            BIGSERIAL PRIMARY KEY,
    started_at    TIMESTAMPTZ NOT NULL,
    finished_at   TIMESTAMPTZ NOT NULL,
    ok            BOOLEAN     NOT NULL,
    total_sum     BIGINT      NOT NULL,
    unbalanced_transfers   INT NOT NULL,
    mismatched_accounts    INT NOT NULL,
    details       JSONB       NOT NULL
);

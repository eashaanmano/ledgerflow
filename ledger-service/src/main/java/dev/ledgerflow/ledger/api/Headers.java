package dev.ledgerflow.ledger.api;

public final class Headers {
    /** Set by the gateway after authentication; the ledger is only reachable on the internal network. */
    public static final String CLIENT_ID = "X-Client-Id";
    public static final String IDEMPOTENCY_KEY = "Idempotency-Key";
    public static final String IDEMPOTENT_REPLAYED = "Idempotent-Replayed";

    private Headers() {
    }
}

package dev.ledgerflow.ledger.domain;

import java.time.Instant;
import java.util.UUID;

public record Transfer(
        UUID id,
        String clientId,
        UUID fromAccountId,
        UUID toAccountId,
        long amount,
        String currency,
        Kind kind,
        String status,
        String description,
        String requestId,
        Instant createdAt) {

    public enum Kind { TRANSFER, DEPOSIT }

    public static final String STATUS_COMPLETED = "COMPLETED";
}

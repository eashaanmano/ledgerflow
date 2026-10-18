package dev.ledgerflow.ledger.domain;

import java.time.Instant;
import java.util.UUID;

/** One journal entry as seen from its account: signed amount plus the other side of the transfer. */
public record LedgerLine(
        long entryId,
        UUID transferId,
        long amount,
        long balanceAfter,
        UUID counterpartyAccountId,
        Transfer.Kind kind,
        String description,
        Instant createdAt) {
}

package dev.ledgerflow.ledger.domain;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.time.Instant;
import java.util.UUID;

public record Account(
        UUID id,
        String clientId,
        String name,
        String currency,
        AccountType type,
        long balance,
        Instant createdAt) {

    public enum AccountType { USER, SYSTEM }

    @JsonIgnore
    public boolean isSystem() {
        return type == AccountType.SYSTEM;
    }
}

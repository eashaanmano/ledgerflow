package dev.ledgerflow.ledger.api;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

import java.util.UUID;

/** Request bodies. Amounts are integers in minor units (cents/paise) to avoid floating point. */
public final class Requests {

    public static final long MAX_AMOUNT = 1_000_000_000_000L;

    private Requests() {
    }

    public record CreateAccount(
            @NotBlank @Size(max = 100) String name,
            @NotBlank @Pattern(regexp = "[A-Z]{3}") String currency) {
    }

    public record CreateTransfer(
            @NotNull UUID fromAccountId,
            @NotNull UUID toAccountId,
            @NotNull @Positive @Max(MAX_AMOUNT) Long amount,
            @NotBlank @Pattern(regexp = "[A-Z]{3}") String currency,
            @Size(max = 255) String description) {
    }

    public record CreateDeposit(
            @NotNull UUID accountId,
            @NotNull @Positive @Max(MAX_AMOUNT) Long amount,
            @Size(max = 255) String description) {
    }
}

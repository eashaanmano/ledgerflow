package dev.ledgerflow.ledger.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.ledgerflow.ledger.api.ApiException;
import dev.ledgerflow.ledger.domain.Account;
import dev.ledgerflow.ledger.domain.Transfer;
import dev.ledgerflow.ledger.repo.AccountRepository;
import dev.ledgerflow.ledger.repo.IdempotencyRepository;
import dev.ledgerflow.ledger.repo.TransferRepository;
import dev.ledgerflow.ledger.web.RequestIdFilter;
import org.slf4j.MDC;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

@Service
public class TransferService {

    /** What the controller sends back; body is raw JSON so a replay is byte-identical to the original. */
    public record Outcome(int status, String body, boolean replayed) {
    }

    public record Command(String clientId, String idempotencyKey, Transfer.Kind kind,
                          UUID fromAccountId, UUID toAccountId, long amount, String currency, String description) {
    }

    private final AccountRepository accounts;
    private final TransferRepository transfers;
    private final IdempotencyRepository idempotency;
    private final OutboxWriter outbox;
    private final ObjectMapper json;

    public TransferService(AccountRepository accounts, TransferRepository transfers,
                           IdempotencyRepository idempotency, OutboxWriter outbox, ObjectMapper json) {
        this.accounts = accounts;
        this.transfers = transfers;
        this.idempotency = idempotency;
        this.outbox = outbox;
        this.json = json;
    }

    @Transactional
    public Outcome transfer(String clientId, String key, UUID from, UUID to, long amount, String currency, String description) {
        return execute(new Command(clientId, key, Transfer.Kind.TRANSFER, from, to, amount, currency, description));
    }

    @Transactional
    public Outcome deposit(String clientId, String key, UUID accountId, long amount, String description) {
        Account target = accounts.findById(accountId)
                .filter(a -> a.clientId().equals(clientId))
                .orElseThrow(() -> ApiException.notFound("account"));
        UUID source = accounts.ensureSystemAccount(target.currency());
        return execute(new Command(clientId, key, Transfer.Kind.DEPOSIT, source, accountId, amount, target.currency(), description));
    }

    @Transactional(readOnly = true)
    public Transfer get(String clientId, UUID id) {
        Transfer t = transfers.findById(id).orElseThrow(() -> ApiException.notFound("transfer"));
        boolean visible = t.clientId().equals(clientId)
                || accounts.findById(t.toAccountId()).map(a -> a.clientId().equals(clientId)).orElse(false);
        if (!visible) {
            throw ApiException.notFound("transfer");
        }
        return t;
    }

    @Transactional(readOnly = true)
    public List<Transfer> recent(String clientId, int limit) {
        return transfers.listVisibleTo(clientId, limit);
    }

    /*
     * Order of operations matters for deadlock freedom:
     *   1. claim the idempotency key (may block on a concurrent retry of the SAME key, while holding no row locks)
     *   2. lock both accounts in a global order
     *   3. write transfer, two journal entries, balances, outbox event and the stored response
     * Everything commits or rolls back together.
     */
    private Outcome execute(Command cmd) {
        String requestHash = hash(cmd);
        if (!idempotency.tryClaim(cmd.clientId(), cmd.idempotencyKey(), requestHash)) {
            return replay(cmd, requestHash);
        }

        if (cmd.fromAccountId().equals(cmd.toAccountId())) {
            throw ApiException.unprocessable("same_account", "Source and destination accounts must differ");
        }

        Map<UUID, Account> locked = lockInOrder(cmd.fromAccountId(), cmd.toAccountId());
        Account from = locked.get(cmd.fromAccountId());
        Account to = locked.get(cmd.toAccountId());
        validate(cmd, from, to);

        long fromAfter = from.balance() - cmd.amount();
        long toAfter = to.balance() + cmd.amount();

        Transfer transfer = transfers.insert(cmd.clientId(), from.id(), to.id(), cmd.amount(), cmd.currency(),
                cmd.kind(), cmd.description(), MDC.get(RequestIdFilter.MDC_KEY));
        transfers.insertEntry(transfer.id(), from.id(), -cmd.amount(), fromAfter);
        transfers.insertEntry(transfer.id(), to.id(), cmd.amount(), toAfter);
        accounts.updateBalance(from.id(), fromAfter);
        accounts.updateBalance(to.id(), toAfter);

        var notify = new LinkedHashSet<String>();
        notify.add(cmd.clientId());
        if (!to.isSystem()) {
            notify.add(to.clientId());
        }
        outbox.record("transfer.completed", transfer.id(), notify, transfer);

        String body = toJson(transfer);
        idempotency.saveResponse(cmd.clientId(), cmd.idempotencyKey(), HttpStatus.CREATED.value(), body);
        return new Outcome(HttpStatus.CREATED.value(), body, false);
    }

    private Outcome replay(Command cmd, String requestHash) {
        var stored = idempotency.find(cmd.clientId(), cmd.idempotencyKey())
                .orElseThrow(() -> new IllegalStateException("Idempotency key vanished after conflict"));
        if (!stored.requestHash().equals(requestHash)) {
            throw ApiException.unprocessable("idempotency_key_reused",
                    "This Idempotency-Key was already used with a different request body");
        }
        return new Outcome(stored.status(), stored.body(), true);
    }

    /*
     * Two transfers A->B and B->A that each lock "source first" can deadlock. Locking by a single
     * global order (string form of the UUID) means every transaction acquires locks in the same
     * sequence, so a wait-for cycle cannot form.
     */
    private Map<UUID, Account> lockInOrder(UUID a, UUID b) {
        UUID first = a.toString().compareTo(b.toString()) < 0 ? a : b;
        UUID second = first.equals(a) ? b : a;
        Account firstAccount = accounts.lockById(first).orElseThrow(() -> ApiException.notFound("account"));
        Account secondAccount = accounts.lockById(second).orElseThrow(() -> ApiException.notFound("account"));
        return Map.of(first, firstAccount, second, secondAccount);
    }

    private void validate(Command cmd, Account from, Account to) {
        if (cmd.kind() == Transfer.Kind.TRANSFER) {
            if (!from.clientId().equals(cmd.clientId()) || from.isSystem()) {
                throw ApiException.notFound("account");
            }
            if (to.isSystem()) {
                throw ApiException.unprocessable("invalid_destination", "Cannot transfer into a system account");
            }
        }
        if (!from.currency().equals(cmd.currency()) || !to.currency().equals(cmd.currency())) {
            throw ApiException.unprocessable("currency_mismatch",
                    "Both accounts must be in " + cmd.currency());
        }
        if (!from.isSystem() && from.balance() < cmd.amount()) {
            throw ApiException.unprocessable("insufficient_funds",
                    "Account %s has %d, transfer needs %d".formatted(from.id(), from.balance(), cmd.amount()));
        }
    }

    private static String hash(Command cmd) {
        String canonical = String.join("|", cmd.kind().name(), String.valueOf(cmd.fromAccountId()),
                String.valueOf(cmd.toAccountId()), Long.toString(cmd.amount()), cmd.currency(),
                Objects.toString(cmd.description(), ""));
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private String toJson(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}

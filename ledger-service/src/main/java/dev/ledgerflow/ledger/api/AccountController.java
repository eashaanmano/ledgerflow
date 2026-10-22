package dev.ledgerflow.ledger.api;

import dev.ledgerflow.ledger.domain.Account;
import dev.ledgerflow.ledger.domain.LedgerLine;
import dev.ledgerflow.ledger.service.AccountService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static dev.ledgerflow.ledger.api.Headers.CLIENT_ID;

@RestController
@RequestMapping("/accounts")
public class AccountController {

    private final AccountService accounts;

    public AccountController(AccountService accounts) {
        this.accounts = accounts;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Account create(@RequestHeader(CLIENT_ID) String clientId, @Valid @RequestBody Requests.CreateAccount body) {
        return accounts.create(clientId, body.name().trim(), body.currency());
    }

    @GetMapping
    public Map<String, List<Account>> list(@RequestHeader(CLIENT_ID) String clientId,
                                           @RequestParam(defaultValue = "100") int limit) {
        return Map.of("data", accounts.list(clientId, clamp(limit)));
    }

    @GetMapping("/{id}")
    public Account get(@RequestHeader(CLIENT_ID) String clientId, @PathVariable UUID id) {
        return accounts.getOwned(clientId, id);
    }

    @GetMapping("/{id}/balance")
    public Map<String, Object> balance(@RequestHeader(CLIENT_ID) String clientId, @PathVariable UUID id) {
        Account a = accounts.getOwned(clientId, id);
        return Map.of("accountId", a.id(), "balance", a.balance(), "currency", a.currency());
    }

    @GetMapping("/{id}/transactions")
    public Map<String, Object> history(@RequestHeader(CLIENT_ID) String clientId, @PathVariable UUID id,
                                       @RequestParam(defaultValue = "50") int limit,
                                       @RequestParam(required = false) Long before) {
        List<LedgerLine> lines = accounts.history(clientId, id, clamp(limit), before);
        Long next = lines.size() == clamp(limit) ? lines.get(lines.size() - 1).entryId() : null;
        return next == null ? Map.of("data", lines) : Map.of("data", lines, "nextCursor", next);
    }

    static int clamp(int limit) {
        return Math.max(1, Math.min(limit, 500));
    }
}

package dev.ledgerflow.ledger.service;

import dev.ledgerflow.ledger.api.ApiException;
import dev.ledgerflow.ledger.domain.Account;
import dev.ledgerflow.ledger.domain.LedgerLine;
import dev.ledgerflow.ledger.repo.AccountRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
public class AccountService {

    private final AccountRepository accounts;
    private final OutboxWriter outbox;

    public AccountService(AccountRepository accounts, OutboxWriter outbox) {
        this.accounts = accounts;
        this.outbox = outbox;
    }

    @Transactional
    public Account create(String clientId, String name, String currency) {
        Account account = accounts.insert(clientId, name, currency, Account.AccountType.USER);
        outbox.record("account.created", account.id(), List.of(clientId), account);
        return account;
    }

    @Transactional(readOnly = true)
    public Account getOwned(String clientId, UUID id) {
        return accounts.findById(id)
                .filter(a -> a.clientId().equals(clientId))
                .orElseThrow(() -> ApiException.notFound("account"));
    }

    @Transactional(readOnly = true)
    public List<Account> list(String clientId, int limit) {
        return accounts.listByClient(clientId, limit);
    }

    @Transactional(readOnly = true)
    public List<LedgerLine> history(String clientId, UUID id, int limit, Long before) {
        getOwned(clientId, id);
        return accounts.ledgerLines(id, limit, before);
    }
}

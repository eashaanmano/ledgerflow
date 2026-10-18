package dev.ledgerflow.ledger.repo;

import dev.ledgerflow.ledger.domain.Account;
import dev.ledgerflow.ledger.domain.Account.AccountType;
import dev.ledgerflow.ledger.domain.LedgerLine;
import dev.ledgerflow.ledger.domain.Transfer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public class AccountRepository {

    public static final String SYSTEM_CLIENT = "__system__";

    private static final String COLUMNS = "id, client_id, name, currency, type, balance, created_at";

    private static final RowMapper<Account> MAPPER = (rs, i) -> new Account(
            rs.getObject("id", UUID.class),
            rs.getString("client_id"),
            rs.getString("name"),
            rs.getString("currency"),
            AccountType.valueOf(rs.getString("type")),
            rs.getLong("balance"),
            rs.getObject("created_at", OffsetDateTime.class).toInstant());

    private final JdbcTemplate jdbc;

    public AccountRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Account insert(String clientId, String name, String currency, AccountType type) {
        return jdbc.queryForObject(
                "INSERT INTO accounts (id, client_id, name, currency, type) VALUES (?, ?, ?, ?, ?) RETURNING " + COLUMNS,
                MAPPER, UUID.randomUUID(), clientId, name, currency, type.name());
    }

    public Optional<Account> findById(UUID id) {
        return jdbc.query("SELECT " + COLUMNS + " FROM accounts WHERE id = ?", MAPPER, id).stream().findFirst();
    }

    /** Row-level exclusive lock held until the surrounding transaction ends. */
    public Optional<Account> lockById(UUID id) {
        return jdbc.query("SELECT " + COLUMNS + " FROM accounts WHERE id = ? FOR UPDATE", MAPPER, id)
                .stream().findFirst();
    }

    public void updateBalance(UUID id, long newBalance) {
        jdbc.update("UPDATE accounts SET balance = ? WHERE id = ?", newBalance, id);
    }

    public List<Account> listByClient(String clientId, int limit) {
        return jdbc.query("SELECT " + COLUMNS + " FROM accounts WHERE client_id = ? ORDER BY created_at DESC LIMIT ?",
                MAPPER, clientId, limit);
    }

    /**
     * Money enters the system from a per-currency SYSTEM account that is allowed to go negative,
     * which keeps the global invariant SUM(entries) = 0 true for deposits too.
     */
    public UUID ensureSystemAccount(String currency) {
        UUID id = UUID.nameUUIDFromBytes(("system:" + currency).getBytes(StandardCharsets.UTF_8));
        jdbc.update("""
                INSERT INTO accounts (id, client_id, name, currency, type)
                VALUES (?, ?, ?, ?, 'SYSTEM') ON CONFLICT (id) DO NOTHING
                """, id, SYSTEM_CLIENT, "External funding " + currency, currency);
        return id;
    }

    public List<LedgerLine> ledgerLines(UUID accountId, int limit, Long beforeEntryId) {
        String base = """
                SELECT e.id, e.transfer_id, e.amount, e.balance_after, e.created_at, t.kind, t.description,
                       CASE WHEN t.from_account_id = e.account_id THEN t.to_account_id ELSE t.from_account_id END AS counterparty
                FROM journal_entries e
                JOIN transfers t ON t.id = e.transfer_id
                WHERE e.account_id = ?
                """;
        RowMapper<LedgerLine> mapper = (rs, i) -> new LedgerLine(
                rs.getLong("id"),
                rs.getObject("transfer_id", UUID.class),
                rs.getLong("amount"),
                rs.getLong("balance_after"),
                rs.getObject("counterparty", UUID.class),
                Transfer.Kind.valueOf(rs.getString("kind")),
                rs.getString("description"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant());
        if (beforeEntryId == null) {
            return jdbc.query(base + " ORDER BY e.id DESC LIMIT ?", mapper, accountId, limit);
        }
        return jdbc.query(base + " AND e.id < ? ORDER BY e.id DESC LIMIT ?", mapper, accountId, beforeEntryId, limit);
    }
}

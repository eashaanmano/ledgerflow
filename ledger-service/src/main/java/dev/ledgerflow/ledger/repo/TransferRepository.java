package dev.ledgerflow.ledger.repo;

import dev.ledgerflow.ledger.domain.Transfer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public class TransferRepository {

    private static final String COLUMNS =
            "id, client_id, from_account_id, to_account_id, amount, currency, kind, status, description, request_id, created_at";
    private static final String INSERT_COLUMNS =
            "id, client_id, from_account_id, to_account_id, amount, currency, kind, status, description, request_id";

    private static final RowMapper<Transfer> MAPPER = (rs, i) -> new Transfer(
            rs.getObject("id", UUID.class),
            rs.getString("client_id"),
            rs.getObject("from_account_id", UUID.class),
            rs.getObject("to_account_id", UUID.class),
            rs.getLong("amount"),
            rs.getString("currency"),
            Transfer.Kind.valueOf(rs.getString("kind")),
            rs.getString("status"),
            rs.getString("description"),
            rs.getString("request_id"),
            rs.getObject("created_at", OffsetDateTime.class).toInstant());

    private final JdbcTemplate jdbc;

    public TransferRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Transfer insert(String clientId, UUID from, UUID to, long amount, String currency,
                           Transfer.Kind kind, String description, String requestId) {
        return jdbc.queryForObject("""
                        INSERT INTO transfers (%s)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING %s
                        """.formatted(INSERT_COLUMNS, COLUMNS),
                MAPPER, UUID.randomUUID(), clientId, from, to, amount, currency, kind.name(),
                Transfer.STATUS_COMPLETED, description, requestId);
    }

    public void insertEntry(UUID transferId, UUID accountId, long signedAmount, long balanceAfter) {
        jdbc.update("INSERT INTO journal_entries (transfer_id, account_id, amount, balance_after) VALUES (?, ?, ?, ?)",
                transferId, accountId, signedAmount, balanceAfter);
    }

    public Optional<Transfer> findById(UUID id) {
        return jdbc.query("SELECT " + COLUMNS + " FROM transfers WHERE id = ?", MAPPER, id).stream().findFirst();
    }

    /** Transfers the client initiated, plus ones paid into accounts it owns. */
    public List<Transfer> listVisibleTo(String clientId, int limit) {
        return jdbc.query("""
                SELECT %s FROM transfers t
                WHERE t.client_id = ?
                   OR t.to_account_id IN (SELECT id FROM accounts WHERE client_id = ?)
                ORDER BY t.created_at DESC LIMIT ?
                """.formatted(COLUMNS), MAPPER, clientId, clientId, limit);
    }
}

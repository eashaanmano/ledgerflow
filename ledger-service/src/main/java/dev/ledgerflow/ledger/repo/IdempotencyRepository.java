package dev.ledgerflow.ledger.repo;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public class IdempotencyRepository {

    public record StoredResponse(String requestHash, Integer status, String body) {
    }

    private final JdbcTemplate jdbc;

    public IdempotencyRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Claims the key for the current transaction. If another in-flight transaction already
     * inserted the same key, Postgres blocks this INSERT until that transaction commits or rolls
     * back, so two concurrent retries can never both proceed.
     *
     * @return true if this transaction now owns the key
     */
    public boolean tryClaim(String clientId, String key, String requestHash) {
        int rows = jdbc.update("""
                INSERT INTO idempotency_keys (client_id, idempotency_key, request_hash)
                VALUES (?, ?, ?) ON CONFLICT DO NOTHING
                """, clientId, key, requestHash);
        return rows == 1;
    }

    public Optional<StoredResponse> find(String clientId, String key) {
        return jdbc.query("""
                        SELECT request_hash, response_status, response_body::text AS body
                        FROM idempotency_keys WHERE client_id = ? AND idempotency_key = ?
                        """,
                (rs, i) -> new StoredResponse(rs.getString("request_hash"),
                        (Integer) rs.getObject("response_status"), rs.getString("body")),
                clientId, key).stream().findFirst();
    }

    public void saveResponse(String clientId, String key, int status, String body) {
        jdbc.update("""
                UPDATE idempotency_keys SET response_status = ?, response_body = ?::jsonb
                WHERE client_id = ? AND idempotency_key = ?
                """, status, body, clientId, key);
    }
}

package dev.ledgerflow.ledger;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.util.Map;
import java.util.UUID;

/**
 * Integration tests run against a real Postgres (row locks, SKIP LOCKED and ON CONFLICT
 * semantics are the whole point, so an in-memory DB would prove nothing).
 * `make test-ledger` starts one via docker compose.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
public abstract class LedgerTestBase {

    protected static final String CLIENT = "test-client";

    @Autowired
    protected TestRestTemplate http;
    @Autowired
    protected JdbcTemplate jdbc;
    @Autowired
    protected ObjectMapper json;

    @BeforeEach
    void cleanDatabase() {
        jdbc.execute("TRUNCATE journal_entries, transfers, idempotency_keys, outbox_events, reconciliation_runs, accounts");
    }

    protected HttpHeaders headers(String idempotencyKey) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.set("X-Client-Id", CLIENT);
        if (idempotencyKey != null) {
            h.set("Idempotency-Key", idempotencyKey);
        }
        return h;
    }

    protected ResponseEntity<String> post(String path, Object body, String idempotencyKey) {
        return http.exchange(path, HttpMethod.POST, new HttpEntity<>(body, headers(idempotencyKey)), String.class);
    }

    protected JsonNode read(ResponseEntity<String> response) {
        try {
            return json.readTree(response.getBody());
        } catch (Exception e) {
            throw new AssertionError("Not JSON: " + response.getBody(), e);
        }
    }

    protected UUID createAccount(String name) {
        var res = post("/accounts", Map.of("name", name, "currency", "USD"), null);
        if (!res.getStatusCode().is2xxSuccessful()) {
            throw new AssertionError("create account failed: " + res);
        }
        return UUID.fromString(read(res).get("id").asText());
    }

    protected void deposit(UUID account, long amount) {
        var res = post("/deposits", Map.of("accountId", account, "amount", amount), UUID.randomUUID().toString());
        if (res.getStatusCode().value() != 201) {
            throw new AssertionError("deposit failed: " + res);
        }
    }

    protected ResponseEntity<String> transfer(UUID from, UUID to, long amount, String key) {
        return post("/transfers", Map.of("fromAccountId", from, "toAccountId", to, "amount", amount, "currency", "USD"), key);
    }

    protected long balance(UUID account) {
        Long b = jdbc.queryForObject("SELECT balance FROM accounts WHERE id = ?", Long.class, account);
        return b == null ? 0 : b;
    }

    protected JsonNode reconcile() {
        return read(post("/admin/reconciliation/run", Map.of(), null));
    }
}

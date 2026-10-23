package dev.ledgerflow.ledger.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
public class ReconciliationService {

    public record Report(Instant startedAt, Instant finishedAt, boolean ok, long totalSum,
                         int unbalancedTransfers, int mismatchedAccounts,
                         List<Map<String, Object>> unbalancedSample, List<Map<String, Object>> mismatchedSample) {
    }

    private static final Logger log = LoggerFactory.getLogger(ReconciliationService.class);
    private static final int SAMPLE = 20;

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final TransactionTemplate snapshotTx;

    public ReconciliationService(JdbcTemplate jdbc, ObjectMapper json, PlatformTransactionManager txManager) {
        this.jdbc = jdbc;
        this.json = json;
        this.snapshotTx = new TransactionTemplate(txManager);
        // All three checks must see the same snapshot; under READ COMMITTED a transfer committing
        // between queries would show up as a false mismatch.
        this.snapshotTx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        this.snapshotTx.setReadOnly(true);
    }

    public Report run() {
        Instant started = Instant.now();
        Report report = snapshotTx.execute(status -> {
            Long total = jdbc.queryForObject("SELECT COALESCE(SUM(amount), 0) FROM journal_entries", Long.class);

            List<Map<String, Object>> unbalanced = jdbc.queryForList("""
                    SELECT t.id AS transfer_id, COUNT(e.id) AS entries, COALESCE(SUM(e.amount), 0) AS sum
                    FROM transfers t LEFT JOIN journal_entries e ON e.transfer_id = t.id
                    GROUP BY t.id
                    HAVING COUNT(e.id) <> 2 OR COALESCE(SUM(e.amount), 0) <> 0
                    """);

            List<Map<String, Object>> mismatched = jdbc.queryForList("""
                    SELECT a.id AS account_id, a.balance AS cached_balance, COALESCE(SUM(e.amount), 0) AS journal_balance
                    FROM accounts a LEFT JOIN journal_entries e ON e.account_id = a.id
                    GROUP BY a.id, a.balance
                    HAVING a.balance <> COALESCE(SUM(e.amount), 0)
                    """);

            long sum = total == null ? 0 : total;
            boolean ok = sum == 0 && unbalanced.isEmpty() && mismatched.isEmpty();
            return new Report(started, Instant.now(), ok, sum, unbalanced.size(), mismatched.size(),
                    unbalanced.stream().limit(SAMPLE).toList(), mismatched.stream().limit(SAMPLE).toList());
        });

        persist(report);
        if (report.ok()) {
            log.info("Reconciliation OK in {} ms", report.finishedAt().toEpochMilli() - started.toEpochMilli());
        } else {
            log.error("RECONCILIATION MISMATCH: sum={} unbalancedTransfers={} mismatchedAccounts={}",
                    report.totalSum(), report.unbalancedTransfers(), report.mismatchedAccounts());
        }
        return report;
    }

    public Optional<Map<String, Object>> latest() {
        return jdbc.queryForList("""
                SELECT id, started_at, finished_at, ok, total_sum, unbalanced_transfers, mismatched_accounts, details::text AS details
                FROM reconciliation_runs ORDER BY id DESC LIMIT 1
                """).stream().findFirst().map(row -> {
            Map<String, Object> out = new LinkedHashMap<>(row);
            out.put("started_at", toInstant(row.get("started_at")));
            out.put("finished_at", toInstant(row.get("finished_at")));
            try {
                out.put("details", json.readTree((String) row.get("details")));
            } catch (JsonProcessingException e) {
                out.put("details", row.get("details"));
            }
            return out;
        });
    }

    private void persist(Report r) {
        try {
            String details = json.writeValueAsString(Map.of(
                    "unbalancedSample", r.unbalancedSample(), "mismatchedSample", r.mismatchedSample()));
            jdbc.update("""
                            INSERT INTO reconciliation_runs (started_at, finished_at, ok, total_sum, unbalanced_transfers, mismatched_accounts, details)
                            VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)
                            """,
                    Timestamp.from(r.startedAt()), Timestamp.from(r.finishedAt()), r.ok(), r.totalSum(),
                    r.unbalancedTransfers(), r.mismatchedAccounts(), details);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Object toInstant(Object v) {
        if (v instanceof Timestamp ts) return ts.toInstant();
        if (v instanceof OffsetDateTime odt) return odt.toInstant();
        return v;
    }
}

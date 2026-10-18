package dev.ledgerflow.ledger.repo;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public class OutboxRepository {

    public record OutboxEvent(long seq, UUID id, String eventType, String payload) {
    }

    private final JdbcTemplate jdbc;

    public OutboxRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(UUID eventId, String eventType, UUID aggregateId, String payloadJson) {
        jdbc.update("INSERT INTO outbox_events (id, event_type, aggregate_id, payload) VALUES (?, ?, ?, ?::jsonb)",
                eventId, eventType, aggregateId, payloadJson);
    }

    /** SKIP LOCKED lets several ledger replicas run the relay without publishing the same row twice concurrently. */
    public List<OutboxEvent> lockUnpublished(int limit) {
        return jdbc.query("""
                        SELECT seq, id, event_type, payload::text AS payload FROM outbox_events
                        WHERE published_at IS NULL ORDER BY seq LIMIT ? FOR UPDATE SKIP LOCKED
                        """,
                (rs, i) -> new OutboxEvent(rs.getLong("seq"), rs.getObject("id", UUID.class),
                        rs.getString("event_type"), rs.getString("payload")),
                limit);
    }

    public void markPublished(List<Long> seqs) {
        if (seqs.isEmpty()) {
            return;
        }
        jdbc.update(con -> {
            var ps = con.prepareStatement("UPDATE outbox_events SET published_at = now() WHERE seq = ANY (?)");
            ps.setArray(1, con.createArrayOf("bigint", seqs.toArray()));
            return ps;
        });
    }

    public long countUnpublished() {
        Long n = jdbc.queryForObject("SELECT count(*) FROM outbox_events WHERE published_at IS NULL", Long.class);
        return n == null ? 0 : n;
    }
}

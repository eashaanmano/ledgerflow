package dev.ledgerflow.ledger.service;

import dev.ledgerflow.ledger.repo.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Polls the outbox and appends events to a Redis Stream.
 *
 * Guarantee: at-least-once. If the process dies after XADD but before the commit that sets
 * published_at, the event is published again on the next poll. Consumers dedupe on event id.
 */
@Component
@ConditionalOnProperty(name = "ledgerflow.outbox.relay-enabled", havingValue = "true", matchIfMissing = true)
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

    private final OutboxRepository outbox;
    private final StringRedisTemplate redis;
    private final TransactionTemplate tx;
    private final String stream;
    private final int batchSize;

    public OutboxRelay(OutboxRepository outbox, StringRedisTemplate redis, PlatformTransactionManager txManager,
                       @Value("${ledgerflow.outbox.stream}") String stream,
                       @Value("${ledgerflow.outbox.batch-size}") int batchSize) {
        this.outbox = outbox;
        this.redis = redis;
        this.tx = new TransactionTemplate(txManager);
        this.stream = stream;
        this.batchSize = batchSize;
    }

    @Scheduled(fixedDelayString = "${ledgerflow.outbox.poll-interval-ms}")
    public void relay() {
        try {
            int published;
            do {
                published = publishBatch();
            } while (published == batchSize);
        } catch (Exception e) {
            // Redis or DB unavailable: rows stay unpublished and are retried on the next tick.
            log.warn("Outbox relay failed, will retry: {}", e.getMessage());
        }
    }

    int publishBatch() {
        Integer n = tx.execute(status -> {
            var events = outbox.lockUnpublished(batchSize);
            List<Long> done = new ArrayList<>(events.size());
            for (var e : events) {
                redis.opsForStream().add(StreamRecords.string(Map.of(
                        "eventId", e.id().toString(),
                        "type", e.eventType(),
                        "payload", e.payload())).withStreamKey(stream));
                done.add(e.seq());
            }
            outbox.markPublished(done);
            return done.size();
        });
        return n == null ? 0 : n;
    }
}

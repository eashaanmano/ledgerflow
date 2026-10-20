package dev.ledgerflow.ledger.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.ledgerflow.ledger.repo.OutboxRepository;
import dev.ledgerflow.ledger.web.RequestIdFilter;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Writes domain events into the outbox table. MANDATORY propagation makes it impossible to
 * record an event outside the transaction that changes the ledger.
 */
@Component
public class OutboxWriter {

    private final OutboxRepository outbox;
    private final ObjectMapper json;

    public OutboxWriter(OutboxRepository outbox, ObjectMapper json) {
        this.outbox = outbox;
        this.json = json;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public UUID record(String type, UUID aggregateId, Collection<String> clientIds, Object data) {
        UUID eventId = UUID.randomUUID();
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("id", eventId);
        envelope.put("type", type);
        envelope.put("createdAt", Instant.now());
        envelope.put("requestId", MDC.get(RequestIdFilter.MDC_KEY));
        envelope.put("clientIds", clientIds);
        envelope.put("data", data);
        try {
            outbox.insert(eventId, type, aggregateId, json.writeValueAsString(envelope));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialize event " + type, e);
        }
        return eventId;
    }
}

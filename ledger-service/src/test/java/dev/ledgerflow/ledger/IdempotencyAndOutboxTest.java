package dev.ledgerflow.ledger;

import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class IdempotencyAndOutboxTest extends LedgerTestBase {

    @Test
    void retryWithSameKeyReturnsOriginalResponseAndMovesMoneyOnce() {
        UUID a = createAccount("a");
        UUID b = createAccount("b");
        deposit(a, 1_000);

        ResponseEntity<String> first = transfer(a, b, 250, "pay-1");
        ResponseEntity<String> retry = transfer(a, b, 250, "pay-1");

        assertThat(first.getStatusCode().value()).isEqualTo(201);
        assertThat(retry.getStatusCode().value()).isEqualTo(201);
        assertThat(retry.getBody()).isEqualTo(first.getBody());
        assertThat(retry.getHeaders().getFirst("Idempotent-Replayed")).isEqualTo("true");
        assertThat(balance(a)).isEqualTo(750);
        assertThat(balance(b)).isEqualTo(250);
    }

    @Test
    void sameKeyWithDifferentBodyIsRejected() {
        UUID a = createAccount("a");
        UUID b = createAccount("b");
        deposit(a, 1_000);

        transfer(a, b, 100, "pay-2");
        ResponseEntity<String> conflicting = transfer(a, b, 999, "pay-2");

        assertThat(conflicting.getStatusCode().value()).isEqualTo(422);
        assertThat(conflicting.getBody()).contains("idempotency_key_reused");
        assertThat(balance(a)).isEqualTo(900);
    }

    @Test
    void fiftyConcurrentRetriesOfOneKeyCreateOneTransfer() throws Exception {
        UUID a = createAccount("a");
        UUID b = createAccount("b");
        deposit(a, 1_000);

        ExecutorService pool = Executors.newFixedThreadPool(16);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<ResponseEntity<String>>> futures = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            futures.add(pool.submit(() -> {
                start.await();
                return transfer(a, b, 10, "storm");
            }));
        }
        start.countDown();
        Set<String> bodies = new HashSet<>();
        for (var f : futures) {
            ResponseEntity<String> res = f.get(1, TimeUnit.MINUTES);
            assertThat(res.getStatusCode().value()).isEqualTo(201);
            bodies.add(res.getBody());
        }
        pool.shutdown();

        assertThat(bodies).hasSize(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM transfers WHERE kind = 'TRANSFER'", Long.class)).isEqualTo(1);
        assertThat(balance(a)).isEqualTo(990);
    }

    @Test
    void overdraftIsRejectedAndLeavesNoTrace() {
        UUID a = createAccount("a");
        UUID b = createAccount("b");
        deposit(a, 100);
        long eventsBefore = countEvents("transfer.completed");

        ResponseEntity<String> res = transfer(a, b, 101, "too-much");

        assertThat(res.getStatusCode().value()).isEqualTo(422);
        assertThat(res.getBody()).contains("insufficient_funds");
        assertThat(balance(a)).isEqualTo(100);
        assertThat(countEvents("transfer.completed")).isEqualTo(eventsBefore);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM idempotency_keys WHERE idempotency_key = 'too-much'", Long.class))
                .as("a failed request does not burn its key").isZero();
    }

    @Test
    void everyCommittedTransferHasExactlyOneOutboxEvent() {
        UUID a = createAccount("a");
        UUID b = createAccount("b");
        deposit(a, 1_000);
        for (int i = 0; i < 5; i++) {
            transfer(a, b, 10, "evt-" + i);
            transfer(a, b, 10, "evt-" + i);
        }

        Long orphans = jdbc.queryForObject("""
                SELECT count(*) FROM transfers t
                WHERE (SELECT count(*) FROM outbox_events o WHERE o.aggregate_id = t.id AND o.event_type = 'transfer.completed') <> 1
                """, Long.class);
        assertThat(orphans).isZero();
        assertThat(countEvents("transfer.completed")).isEqualTo(6);
    }

    @Test
    void cannotSpendFromAnotherClientsAccount() {
        UUID a = createAccount("a");
        UUID b = createAccount("b");
        deposit(a, 1_000);
        jdbc.update("UPDATE accounts SET client_id = 'someone-else' WHERE id = ?", a);

        assertThat(transfer(a, b, 10, "steal").getStatusCode().value()).isEqualTo(404);
    }

    private long countEvents(String type) {
        Long n = jdbc.queryForObject("SELECT count(*) FROM outbox_events WHERE event_type = ?", Long.class, type);
        return n == null ? 0 : n;
    }
}

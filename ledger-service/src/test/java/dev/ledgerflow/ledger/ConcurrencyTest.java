package dev.ledgerflow.ledger;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class ConcurrencyTest extends LedgerTestBase {

    private static final int ACCOUNTS = 20;
    private static final long INITIAL = 50_000;
    private static final int TRANSFERS = 1_200;
    private static final int THREADS = 32;

    record Attempt(String key, UUID from, UUID to, long amount) {
    }

    /**
     * 1,200 random transfers, each fired twice at the same time with the same Idempotency-Key
     * (2,400 requests on 32 threads). Amounts are large enough that many requests hit the
     * overdraft check while other transfers are moving money in and out of the same accounts.
     */
    @Test
    void concurrentRandomTransfersKeepLedgerConsistent() throws Exception {
        List<UUID> accounts = new ArrayList<>();
        for (int i = 0; i < ACCOUNTS; i++) {
            UUID id = createAccount("acct-" + i);
            deposit(id, INITIAL);
            accounts.add(id);
        }

        Random rnd = new Random(42);
        List<Attempt> attempts = new ArrayList<>();
        for (int i = 0; i < TRANSFERS; i++) {
            UUID from = accounts.get(rnd.nextInt(ACCOUNTS));
            UUID to;
            do {
                to = accounts.get(rnd.nextInt(ACCOUNTS));
            } while (to.equals(from));
            attempts.add(new Attempt("k-" + i, from, to, 1 + rnd.nextInt(20_000)));
        }

        Map<String, Set<String>> transferIdsByKey = new ConcurrentHashMap<>();
        Map<String, Attempt> attemptByKey = new HashMap<>();
        attempts.forEach(a -> attemptByKey.put(a.key(), a));
        ConcurrentLinkedQueue<String> unexpected = new ConcurrentLinkedQueue<>();
        AtomicInteger replays = new AtomicInteger();
        AtomicInteger rejectedForFunds = new AtomicInteger();

        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<?>> futures = new ArrayList<>();
        for (Attempt a : attempts) {
            for (int copy = 0; copy < 2; copy++) {
                futures.add(pool.submit(() -> {
                    start.await();
                    ResponseEntity<String> res = transfer(a.from(), a.to(), a.amount(), a.key());
                    int code = res.getStatusCode().value();
                    if (code == 201) {
                        transferIdsByKey.computeIfAbsent(a.key(), k -> ConcurrentHashMap.newKeySet())
                                .add(read(res).get("id").asText());
                        if ("true".equals(res.getHeaders().getFirst("Idempotent-Replayed"))) {
                            replays.incrementAndGet();
                        }
                    } else if (code == 422 && res.getBody().contains("insufficient_funds")) {
                        rejectedForFunds.incrementAndGet();
                    } else {
                        unexpected.add(code + " " + res.getBody());
                    }
                    return null;
                }));
            }
        }
        start.countDown();
        for (Future<?> f : futures) {
            f.get(2, TimeUnit.MINUTES);
        }
        pool.shutdown();

        assertThat(unexpected).as("no 5xx, deadlocks or unexpected errors").isEmpty();

        // Idempotency: a key maps to at most one transfer, and the DB holds exactly one row per successful key.
        transferIdsByKey.forEach((key, ids) -> assertThat(ids).as("transfer ids for " + key).hasSize(1));
        long rows = jdbc.queryForObject("SELECT count(*) FROM transfers WHERE kind = 'TRANSFER'", Long.class);
        assertThat(rows).isEqualTo(transferIdsByKey.size());

        // Balances match a client-side model built only from successful responses.
        Map<UUID, Long> expected = new HashMap<>();
        accounts.forEach(id -> expected.put(id, INITIAL));
        for (String key : transferIdsByKey.keySet()) {
            Attempt a = attemptByKey.get(key);
            expected.merge(a.from(), -a.amount(), Long::sum);
            expected.merge(a.to(), a.amount(), Long::sum);
        }
        long total = 0;
        for (UUID id : accounts) {
            long actual = balance(id);
            assertThat(actual).as("balance of " + id).isEqualTo(expected.get(id));
            assertThat(actual).as("no overdraft on " + id).isGreaterThanOrEqualTo(0);
            total += actual;
        }
        assertThat(total).as("money is conserved").isEqualTo(INITIAL * ACCOUNTS);

        JsonNode report = reconcile();
        assertThat(report.get("ok").asBoolean()).as(report.toString()).isTrue();

        System.out.printf("transfers committed=%d, replayed responses=%d, insufficient-funds rejections=%d%n",
                transferIdsByKey.size(), replays.get(), rejectedForFunds.get());
    }

    /**
     * Opposing transfers between the same two accounts are the classic deadlock. With locks taken
     * in a global order, Postgres never has to abort one of them, so every request succeeds.
     */
    @Test
    void opposingTransfersDoNotDeadlock() throws Exception {
        UUID a = createAccount("a");
        UUID b = createAccount("b");
        deposit(a, 1_000_000);
        deposit(b, 1_000_000);

        int perDirection = 500;
        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Integer>> results = new ArrayList<>();
        for (int i = 0; i < perDirection; i++) {
            String n = Integer.toString(i);
            results.add(pool.submit(() -> {
                start.await();
                return transfer(a, b, 7, "ab-" + n).getStatusCode().value();
            }));
            results.add(pool.submit(() -> {
                start.await();
                return transfer(b, a, 3, "ba-" + n).getStatusCode().value();
            }));
        }
        start.countDown();
        Set<Integer> codes = new HashSet<>();
        for (Future<Integer> f : results) {
            codes.add(f.get(2, TimeUnit.MINUTES));
        }
        pool.shutdown();

        assertThat(codes).containsOnly(201);
        assertThat(balance(a)).isEqualTo(1_000_000 - perDirection * 7L + perDirection * 3L);
        assertThat(balance(b)).isEqualTo(1_000_000 + perDirection * 7L - perDirection * 3L);
        assertThat(reconcile().get("ok").asBoolean()).isTrue();
    }
}

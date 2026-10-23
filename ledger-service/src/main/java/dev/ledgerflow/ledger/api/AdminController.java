package dev.ledgerflow.ledger.api;

import dev.ledgerflow.ledger.repo.OutboxRepository;
import dev.ledgerflow.ledger.service.ReconciliationService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/admin")
public class AdminController {

    private final ReconciliationService reconciliation;
    private final OutboxRepository outbox;

    public AdminController(ReconciliationService reconciliation, OutboxRepository outbox) {
        this.reconciliation = reconciliation;
        this.outbox = outbox;
    }

    @PostMapping("/reconciliation/run")
    public ReconciliationService.Report runReconciliation() {
        return reconciliation.run();
    }

    @GetMapping("/reconciliation/latest")
    public ResponseEntity<Map<String, Object>> latest() {
        return reconciliation.latest().map(ResponseEntity::ok).orElse(ResponseEntity.noContent().build());
    }

    @GetMapping("/outbox")
    public Map<String, Long> outboxLag() {
        return Map.of("unpublished", outbox.countUnpublished());
    }
}

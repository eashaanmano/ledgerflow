package dev.ledgerflow.ledger.api;

import dev.ledgerflow.ledger.domain.Transfer;
import dev.ledgerflow.ledger.service.TransferService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static dev.ledgerflow.ledger.api.Headers.CLIENT_ID;
import static dev.ledgerflow.ledger.api.Headers.IDEMPOTENCY_KEY;
import static dev.ledgerflow.ledger.api.Headers.IDEMPOTENT_REPLAYED;

@RestController
public class TransferController {

    private final TransferService transfers;

    public TransferController(TransferService transfers) {
        this.transfers = transfers;
    }

    @PostMapping("/transfers")
    public ResponseEntity<String> create(@RequestHeader(CLIENT_ID) String clientId,
                                         @RequestHeader(IDEMPOTENCY_KEY) String key,
                                         @Valid @RequestBody Requests.CreateTransfer body) {
        checkKey(key);
        return respond(transfers.transfer(clientId, key, body.fromAccountId(), body.toAccountId(),
                body.amount(), body.currency(), body.description()));
    }

    @PostMapping("/deposits")
    public ResponseEntity<String> deposit(@RequestHeader(CLIENT_ID) String clientId,
                                          @RequestHeader(IDEMPOTENCY_KEY) String key,
                                          @Valid @RequestBody Requests.CreateDeposit body) {
        checkKey(key);
        return respond(transfers.deposit(clientId, key, body.accountId(), body.amount(), body.description()));
    }

    @GetMapping("/transfers/{id}")
    public Transfer get(@RequestHeader(CLIENT_ID) String clientId, @PathVariable UUID id) {
        return transfers.get(clientId, id);
    }

    @GetMapping("/transfers")
    public Map<String, List<Transfer>> recent(@RequestHeader(CLIENT_ID) String clientId,
                                              @RequestParam(defaultValue = "50") int limit) {
        return Map.of("data", transfers.recent(clientId, AccountController.clamp(limit)));
    }

    private static ResponseEntity<String> respond(TransferService.Outcome outcome) {
        return ResponseEntity.status(outcome.status())
                .contentType(MediaType.APPLICATION_JSON)
                .header(IDEMPOTENT_REPLAYED, Boolean.toString(outcome.replayed()))
                .body(outcome.body());
    }

    private static void checkKey(String key) {
        if (key.isBlank() || key.length() > 255) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_idempotency_key",
                    "Idempotency-Key must be 1-255 characters");
        }
    }
}

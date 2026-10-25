-- jsonb normalises whitespace and key order, so a replayed response would not be byte-identical
-- to the original. Store the exact response text instead.
ALTER TABLE idempotency_keys ALTER COLUMN response_body TYPE TEXT USING response_body::text;

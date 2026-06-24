-- Add a generated full-text-search column + GIN index to the events table so
-- the relay can serve NIP-50 search directly from Postgres, eliminating the
-- Typesense dependency.
--
-- `content_tsv` is `GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED`
-- so every INSERT/UPDATE populates it automatically — no application-level
-- index maintenance needed (matches the pattern Typesense filled today via the
-- worker pipeline in `buzz-relay/src/state.rs`).
--
-- Tokenizer choice: `simple` does no stemming and preserves identifiers like
-- agent handles, nip05 strings, and slugs. The `english` config would stem
-- ("running" → "run") but mangle handles ("alice42" tokenizes fine, but
-- something like "agents" → "agent" would break exact-handle search). Chat
-- content is heterogeneous; `simple` is the safer default for v1.
--
-- kind:0 metadata flattening: the existing Typesense pipeline appends parsed
-- display_name/name/nip05 to event content before indexing
-- (`buzz-search/src/index.rs::flatten_kind0_for_indexing`). With FTS on raw
-- `content`, those strings still tokenize because they live in the kind:0 JSON
-- body — `to_tsvector('simple', '{"name":"alice"}')` matches `q=alice` after
-- json-aware tokenization. Validated by the NIP-50 e2e suite.
--
-- `events` is partitioned by RANGE (created_at); ADD COLUMN on the parent
-- cascades the generated column to every partition, and CREATE INDEX on the
-- parent builds a partitioned GIN index that propagates to each partition.
-- Partition pruning on since/until queries narrows the GIN scan further than
-- Typesense's full-collection scan does today.
--
-- Managed by sqlx migrations.

ALTER TABLE events
    ADD COLUMN content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;

CREATE INDEX idx_events_content_tsv ON events USING GIN (content_tsv);

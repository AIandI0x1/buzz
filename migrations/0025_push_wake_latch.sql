-- NIP-PL durable wake latch: one row per lease address replaces row-per-event
-- wake fanout in push_wake_outbox. Content-free pushes make per-event rows
-- redundant: a wake means "sync now", so an endpoint owed a wake needs at most
-- one durable pending cycle plus a record of work that arrived mid-send.
--
-- State machine (crates/buzz-db/src/push_latch.rs is the single writer):
--   idle -> pending    first matched event; leading wake due at
--                      GREATEST(now(), cooldown_until) so a genuinely idle
--                      address wakes immediately while a just-woken one defers
--                      to the cooldown boundary.
--   pending -> pending matched events fold write-free unless the lease
--                      generation changed or the current cycle expired.
--   pending -> sending worker claim (fenced by claim_id/lease_until).
--   sending            claimed identity is IMMUTABLE; a matched event may only
--                      set the owed_* triple (first-owed wins; generation
--                      change refreshes it).
--   sending -> pending accepted delivery with owed work: promote owed_* to the
--                      current cycle, mint a new request_id, due at the new
--                      cooldown boundary. Suppressed/terminal exits promote
--                      immediately (no wake reached the device, no cooldown).
--   sending -> idle    exit with no owed work. cooldown_until persists on the
--                      idle row: it is what bounds accepted wakes to one per
--                      address per cooldown window regardless of gateway speed.
--
-- cooldown_until is NOT NULL with epoch-zero default so arming logic never
-- branches on NULL. request_id is the stable gateway/APNs replay-fence id for
-- one wake cycle: constant across retries, minted per cycle.
CREATE TABLE push_wake_latch (
    community_id UUID NOT NULL REFERENCES communities(id),
    author BYTEA NOT NULL CHECK (length(author) = 32),
    installation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('idle', 'pending', 'sending')),
    generation BIGINT NOT NULL CHECK (generation > 0),
    event_id BYTEA NOT NULL CHECK (length(event_id) = 32),
    expires_at BIGINT NOT NULL,
    request_id UUID NOT NULL,
    owed_event_id BYTEA CHECK (owed_event_id IS NULL OR length(owed_event_id) = 32),
    owed_generation BIGINT,
    owed_expires_at BIGINT,
    cooldown_until TIMESTAMPTZ NOT NULL DEFAULT to_timestamp(0),
    next_attempt_at TIMESTAMPTZ,
    lease_until TIMESTAMPTZ,
    claim_id UUID,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, author, installation_id),
    FOREIGN KEY (community_id, author, installation_id)
        REFERENCES push_leases (community_id, author, installation_id),
    -- The owed triple is all-present or all-absent.
    CHECK ((owed_event_id IS NULL) = (owed_generation IS NULL)
       AND (owed_event_id IS NULL) = (owed_expires_at IS NULL)),
    -- A pending cycle is always due at some point; a claim always carries its
    -- fence. Idle rows carry neither.
    CHECK (state <> 'pending' OR next_attempt_at IS NOT NULL),
    CHECK ((state = 'sending') = (claim_id IS NOT NULL)),
    CHECK ((state = 'sending') = (lease_until IS NOT NULL))
);

-- Global (not community-prefixed) partial indexes: the delivery worker claims
-- across all communities in one statement. Two arms, two indexes — the claim
-- query is shaped as UNION ALL so each arm is independently indexable.
CREATE INDEX push_wake_latch_due_global
    ON push_wake_latch (next_attempt_at) WHERE state = 'pending';
CREATE INDEX push_wake_latch_recovery_global
    ON push_wake_latch (lease_until) WHERE state = 'sending';

-- Brownfield seed: any address that currently has live legacy outbox work is
-- owed a wake. One pending latch per such address, representative = its newest
-- live legacy row. The legacy table and its workers are left fully intact:
-- old pods keep enqueueing/draining push_wake_outbox during the rolling
-- deploy, and new workers dual-drain both sources until migration 0026
-- retires the legacy path. Duplicate wakes across the two systems during the
-- window are content-free and harmless; lost wakes are not possible.
INSERT INTO push_wake_latch (
    community_id, author, installation_id, state, generation, event_id,
    expires_at, request_id, next_attempt_at
)
SELECT DISTINCT ON (o.community_id, o.author, o.installation_id)
    o.community_id, o.author, o.installation_id, 'pending', o.lease_generation,
    o.event_id, o.expires_at, gen_random_uuid(), now()
FROM push_wake_outbox o
WHERE o.state IN ('pending', 'sending')
  AND o.expires_at > EXTRACT(EPOCH FROM now())::bigint
ORDER BY o.community_id, o.author, o.installation_id, o.created_at DESC
ON CONFLICT DO NOTHING;

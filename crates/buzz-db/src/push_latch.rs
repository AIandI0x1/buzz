//! Durable NIP-PL wake latch: one row per lease address.
//!
//! Replaces row-per-event wake fanout (`push_wake_outbox`) for the delivery
//! path. Pushes are content-free ("sync now"), so an address is owed at most
//! one pending wake cycle plus a record of work that arrived mid-send. The
//! latch bounds accepted wakes to one per address per cooldown window
//! regardless of message rate, matcher cadence, or gateway speed, because
//! `cooldown_until` is durable state consulted when the next cycle is armed —
//! not a timing accident of HTTP overlap.
//!
//! State machine (see `migrations/0025_push_wake_latch.sql`):
//!
//! * `idle -> pending`: first matched event arms a cycle. The leading wake is
//!   due at `GREATEST(now(), cooldown_until)`: immediate after genuine
//!   idleness, deferred to the cooldown boundary right after a wake.
//! * `pending`: further matches fold write-free unless the lease generation
//!   changed or the current cycle expired (both refresh the cycle identity —
//!   without the generation clause a lease rotation would leave a latch whose
//!   send-time revalidation can never pass again).
//! * `pending -> sending`: fenced worker claim (`claim_id` + `lease_until`).
//!   A claimed cycle's identity is IMMUTABLE: a match during `sending` may
//!   only set the `owed_*` triple (first-owed wins; a generation change
//!   refreshes it, at rotation rate, not message rate).
//! * `sending` exit: every exit path is the same promote-or-idle rule — if
//!   `owed_*` is present it becomes the next pending cycle with a fresh
//!   `request_id`; otherwise the latch idles. Accepted deliveries stamp
//!   `cooldown_until` and schedule the promoted cycle at the cooldown
//!   boundary; suppressed/terminal exits promote immediately (no wake reached
//!   the device, so no cooldown is owed). Newly arrived work is never
//!   silently discarded.
//! * Retry/recovery keep the cycle's `request_id` (the gateway replay fence
//!   sees one id per wake cycle, constant across retries).
//!
//! The claim deliberately does NOT join `push_leases`: it is pure fencing.
//! [`revalidate_latch_for_send`] is the single authorization read (lease
//! generation/active/endpoint + non-deleted representative event), and a
//! suppressed claim exits through promote-or-idle. This is what keeps
//! rotated-lease or stale-cycle rows from stranding: they get claimed,
//! suppressed, and healed instead of becoming permanently unclaimable.

use buzz_core::CommunityId;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row as _};
use uuid::Uuid;

use crate::error::Result;

/// One matcher-produced arm/fold request for a lease address.
#[derive(Debug, Clone)]
pub struct LatchArm {
    /// Lease owner's raw public key.
    pub author: Vec<u8>,
    /// Installation address within the tenant.
    pub installation_id: String,
    /// Generation observed by the matcher.
    pub generation: i64,
    /// Matched event id (32 bytes); becomes the representative event.
    pub event_id: Vec<u8>,
    /// Cycle deadline: `min(lease.expires_at, event.created_at + usefulness)`.
    pub expires_at: i64,
}

/// One exclusively claimed latch cycle. Fencing state only — authorization
/// fields come from [`revalidate_latch_for_send`].
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimedLatch {
    /// Server-resolved tenant that owns this latch.
    pub community: CommunityId,
    /// Lease owner's raw public key.
    pub author: Vec<u8>,
    /// Installation address within the community.
    pub installation_id: String,
    /// Generation captured into the current cycle.
    pub generation: i64,
    /// Representative event for this cycle.
    pub event_id: Vec<u8>,
    /// Cycle deadline, in Unix seconds.
    pub expires_at: i64,
    /// Stable gateway/APNs request id for this cycle (constant across
    /// retries, minted per cycle).
    pub request_id: Uuid,
    /// Claim fencing token required by every completion operation.
    pub claim_id: Uuid,
    /// Attempt number for this cycle, starting at one for the first claim.
    pub attempt: i32,
}

/// A revalidated, deliverable claim: the claimed cycle plus the
/// authorization-bearing fields read at send time.
#[derive(Debug, Clone, PartialEq)]
pub struct DeliverableLatch {
    /// The fenced claim this delivery belongs to.
    pub claim: ClaimedLatch,
    /// Opaque endpoint capability for the stateless gateway.
    pub endpoint_grant: String,
    /// Representative event's channel for membership revalidation.
    pub channel_id: Option<Uuid>,
}

/// Outcome of the load-bearing send-time check.
#[derive(Debug, Clone, PartialEq)]
pub enum RevalidateLatchOutcome {
    /// The claim, current lease, and representative event authorize delivery.
    Deliver(Box<DeliverableLatch>),
    /// The claim was lost, the lease rotated/revoked/expired/disabled, the
    /// cycle expired, or the representative event was deleted. The caller
    /// MUST exit the claim through [`release_latch_undelivered`].
    Suppressed,
}

/// Set-wise arm/fold. One statement for any number of matched (lease, event)
/// pairs; requests MUST be pre-collapsed to one per address (see
/// `collapse_arms`) because a multi-row `ON CONFLICT DO UPDATE` cannot touch
/// the same row twice.
///
/// Write-free by design for the sustained-traffic cases: a `pending` latch
/// with an unexpired same-generation cycle and a `sending` latch that is
/// already owed same-generation work are skipped by the update guard.
pub async fn arm_latches(
    pool: &PgPool,
    community: CommunityId,
    requests: &[LatchArm],
) -> Result<()> {
    if requests.is_empty() {
        return Ok(());
    }
    let requests = collapse_arms(requests);
    let authors: Vec<&[u8]> = requests.iter().map(|r| r.author.as_slice()).collect();
    let installs: Vec<&str> = requests
        .iter()
        .map(|r| r.installation_id.as_str())
        .collect();
    let generations: Vec<i64> = requests.iter().map(|r| r.generation).collect();
    let events: Vec<&[u8]> = requests.iter().map(|r| r.event_id.as_slice()).collect();
    let expires: Vec<i64> = requests.iter().map(|r| r.expires_at).collect();
    sqlx::query(
        r#"
        INSERT INTO push_wake_latch (
            community_id, author, installation_id, state, generation,
            event_id, expires_at, request_id, next_attempt_at
        )
        SELECT $1, a, i, 'pending', g, ev, ex, gen_random_uuid(), now()
        FROM UNNEST($2::bytea[], $3::text[], $4::bigint[], $5::bytea[], $6::bigint[])
            AS t(a, i, g, ev, ex)
        ON CONFLICT (community_id, author, installation_id) DO UPDATE SET
            state = CASE WHEN push_wake_latch.state = 'idle'
                THEN 'pending' ELSE push_wake_latch.state END,
            generation = CASE WHEN push_wake_latch.state IN ('idle', 'pending')
                THEN EXCLUDED.generation ELSE push_wake_latch.generation END,
            event_id = CASE WHEN push_wake_latch.state IN ('idle', 'pending')
                THEN EXCLUDED.event_id ELSE push_wake_latch.event_id END,
            expires_at = CASE WHEN push_wake_latch.state IN ('idle', 'pending')
                THEN EXCLUDED.expires_at ELSE push_wake_latch.expires_at END,
            request_id = CASE WHEN push_wake_latch.state = 'idle'
                THEN EXCLUDED.request_id ELSE push_wake_latch.request_id END,
            next_attempt_at = CASE WHEN push_wake_latch.state = 'idle'
                THEN GREATEST(now(), push_wake_latch.cooldown_until)
                ELSE push_wake_latch.next_attempt_at END,
            attempts = CASE WHEN push_wake_latch.state = 'idle'
                THEN 0 ELSE push_wake_latch.attempts END,
            owed_event_id = CASE WHEN push_wake_latch.state = 'sending'
                THEN EXCLUDED.event_id ELSE push_wake_latch.owed_event_id END,
            owed_generation = CASE WHEN push_wake_latch.state = 'sending'
                THEN EXCLUDED.generation ELSE push_wake_latch.owed_generation END,
            owed_expires_at = CASE WHEN push_wake_latch.state = 'sending'
                THEN EXCLUDED.expires_at ELSE push_wake_latch.owed_expires_at END,
            updated_at = now()
        WHERE push_wake_latch.state = 'idle'
           OR (push_wake_latch.state = 'pending'
               AND (push_wake_latch.generation <> EXCLUDED.generation
                    OR push_wake_latch.expires_at
                       <= EXTRACT(EPOCH FROM now())::bigint))
           OR (push_wake_latch.state = 'sending'
               AND (push_wake_latch.owed_event_id IS NULL
                    OR push_wake_latch.owed_generation <> EXCLUDED.generation))
        "#,
    )
    .bind(community.as_uuid())
    .bind(&authors)
    .bind(&installs)
    .bind(&generations)
    .bind(&events)
    .bind(&expires)
    .execute(pool)
    .await?;
    Ok(())
}

/// Collapse a matcher batch to one arm per address, keeping the entry with
/// the highest (generation, expires_at) — the newest lease view and freshest
/// representative. Mirrors what serial single-row folds would converge to.
fn collapse_arms(requests: &[LatchArm]) -> Vec<&LatchArm> {
    let mut best: std::collections::HashMap<(&[u8], &str), &LatchArm> =
        std::collections::HashMap::with_capacity(requests.len());
    for request in requests {
        let key = (request.author.as_slice(), request.installation_id.as_str());
        let entry = best.entry(key).or_insert(request);
        if (request.generation, request.expires_at) > ((entry).generation, (entry).expires_at) {
            *entry = request;
        }
    }
    let mut collapsed: Vec<&LatchArm> = best.into_values().collect();
    // Deterministic statement order keeps concurrent batch lock order stable.
    collapsed.sort_unstable_by(|a, b| {
        (a.author.as_slice(), a.installation_id.as_str())
            .cmp(&(b.author.as_slice(), b.installation_id.as_str()))
    });
    collapsed
}

/// Globally claim up to `limit` due latch cycles across all communities:
/// due pending cycles plus expired `sending` claims (crash recovery, which
/// preserves `request_id` — a recovered claim is a retry).
///
/// Two `UNION ALL` arms so each is served by its own global partial index
/// (`push_wake_latch_due_global`, `push_wake_latch_recovery_global`). The
/// claim is pure fencing: no lease/event join here — the send-time
/// revalidation owns authorization, and its suppression path heals stale
/// rows through promote-or-idle instead of leaving them unclaimable.
pub async fn claim_due_latches(
    pool: &PgPool,
    limit: i64,
    lease_until: DateTime<Utc>,
) -> Result<Vec<ClaimedLatch>> {
    let claim_id = Uuid::new_v4();
    let rows = sqlx::query(
        r#"
        WITH due AS (
            (SELECT community_id, author, installation_id,
                    next_attempt_at AS due_at
               FROM push_wake_latch
              WHERE state = 'pending' AND next_attempt_at <= now()
              ORDER BY next_attempt_at
              LIMIT $1)
            UNION ALL
            (SELECT community_id, author, installation_id,
                    lease_until AS due_at
               FROM push_wake_latch
              WHERE state = 'sending' AND lease_until < now()
              ORDER BY lease_until
              LIMIT $1)
        ),
        candidates AS (
            SELECT l.community_id, l.author, l.installation_id
            FROM push_wake_latch l
            JOIN due d ON d.community_id = l.community_id
                      AND d.author = l.author
                      AND d.installation_id = l.installation_id
            WHERE (l.state = 'pending' AND l.next_attempt_at <= now())
               OR (l.state = 'sending' AND l.lease_until < now())
            ORDER BY d.due_at
            FOR UPDATE OF l SKIP LOCKED
            LIMIT $1
        )
        UPDATE push_wake_latch l
        SET state = 'sending', claim_id = $2, lease_until = $3,
            attempts = l.attempts + 1, updated_at = now()
        FROM candidates c
        WHERE l.community_id = c.community_id
          AND l.author = c.author
          AND l.installation_id = c.installation_id
        RETURNING l.community_id, l.author, l.installation_id, l.generation,
                  l.event_id, l.expires_at, l.request_id, l.claim_id,
                  l.attempts
        "#,
    )
    .bind(limit)
    .bind(claim_id)
    .bind(lease_until)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(ClaimedLatch {
                community: CommunityId::from_uuid(row.try_get("community_id")?),
                author: row.try_get("author")?,
                installation_id: row.try_get("installation_id")?,
                generation: row.try_get("generation")?,
                event_id: row.try_get("event_id")?,
                expires_at: row.try_get("expires_at")?,
                request_id: row.try_get("request_id")?,
                claim_id: row.try_get("claim_id")?,
                attempt: row.try_get("attempts")?,
            })
        })
        .collect()
}

/// Revalidate a fenced claim immediately before transport. This is the
/// load-bearing authorization read: current lease (same generation, active,
/// endpoint-enabled, unexpired), unexpired cycle, live claim, and a
/// non-deleted representative event.
pub async fn revalidate_latch_for_send(
    pool: &PgPool,
    claim: &ClaimedLatch,
) -> Result<RevalidateLatchOutcome> {
    let row = sqlx::query(
        r#"
        SELECT l.community_id, l.author, l.installation_id, l.generation,
               l.event_id, l.expires_at, l.request_id, l.claim_id, l.attempts,
               pl.endpoint_grant, e.channel_id
        FROM push_wake_latch l
        JOIN push_leases pl
          ON pl.community_id = l.community_id
         AND pl.author = l.author
         AND pl.installation_id = l.installation_id
         AND pl.generation = l.generation
         AND pl.active
         AND pl.endpoint_enabled
         AND pl.expires_at > EXTRACT(EPOCH FROM now())::bigint
        JOIN events e
          ON e.community_id = l.community_id
         AND e.id = l.event_id
         AND e.deleted_at IS NULL
        WHERE l.community_id = $1
          AND l.author = $2
          AND l.installation_id = $3
          AND l.claim_id = $4
          AND l.state = 'sending'
          AND l.lease_until >= now()
          AND l.expires_at > EXTRACT(EPOCH FROM now())::bigint
        "#,
    )
    .bind(claim.community.as_uuid())
    .bind(&claim.author)
    .bind(&claim.installation_id)
    .bind(claim.claim_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(RevalidateLatchOutcome::Suppressed);
    };
    Ok(RevalidateLatchOutcome::Deliver(Box::new(
        DeliverableLatch {
            claim: ClaimedLatch {
                community: CommunityId::from_uuid(row.try_get("community_id")?),
                author: row.try_get("author")?,
                installation_id: row.try_get("installation_id")?,
                generation: row.try_get("generation")?,
                event_id: row.try_get("event_id")?,
                expires_at: row.try_get("expires_at")?,
                request_id: row.try_get("request_id")?,
                claim_id: row.try_get("claim_id")?,
                attempt: row.try_get("attempts")?,
            },
            endpoint_grant: row.try_get("endpoint_grant")?,
            channel_id: row.try_get("channel_id")?,
        },
    )))
}

/// Exit a fenced claim after an ACCEPTED gateway delivery.
///
/// Stamps `cooldown_until = now() + cooldown` — the durable state that bounds
/// accepted wakes to one per address per cooldown window — then applies the
/// promote-or-idle exit rule: owed work becomes the next pending cycle with a
/// fresh `request_id`, due exactly at the cooldown boundary; otherwise the
/// latch idles (retaining `cooldown_until` for the next arm).
pub async fn complete_latch_delivered(
    pool: &PgPool,
    claim: &ClaimedLatch,
    cooldown: chrono::Duration,
) -> Result<bool> {
    let result = sqlx::query(
        r#"
        UPDATE push_wake_latch SET
            cooldown_until = now() + $5,
            state = CASE WHEN owed_event_id IS NULL THEN 'idle' ELSE 'pending' END,
            event_id = COALESCE(owed_event_id, event_id),
            generation = COALESCE(owed_generation, generation),
            expires_at = COALESCE(owed_expires_at, expires_at),
            request_id = CASE WHEN owed_event_id IS NULL
                THEN request_id ELSE gen_random_uuid() END,
            next_attempt_at = CASE WHEN owed_event_id IS NULL
                THEN NULL ELSE now() + $5 END,
            attempts = CASE WHEN owed_event_id IS NULL THEN attempts ELSE 0 END,
            owed_event_id = NULL, owed_generation = NULL, owed_expires_at = NULL,
            claim_id = NULL, lease_until = NULL, updated_at = now()
        WHERE community_id = $1 AND author = $2 AND installation_id = $3
          AND claim_id = $4 AND state = 'sending'
        "#,
    )
    .bind(claim.community.as_uuid())
    .bind(&claim.author)
    .bind(&claim.installation_id)
    .bind(claim.claim_id)
    .bind(cooldown)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Exit a fenced claim that delivered NOTHING (suppressed by revalidation,
/// terminal gateway failure, or attempt exhaustion).
///
/// Same promote-or-idle rule as [`complete_latch_delivered`], but without a
/// cooldown stamp and with an immediately-due promoted cycle: no wake reached
/// the device, so no cooldown is owed and owed work must not wait for one.
pub async fn release_latch_undelivered(pool: &PgPool, claim: &ClaimedLatch) -> Result<bool> {
    let result = sqlx::query(
        r#"
        UPDATE push_wake_latch SET
            state = CASE WHEN owed_event_id IS NULL THEN 'idle' ELSE 'pending' END,
            event_id = COALESCE(owed_event_id, event_id),
            generation = COALESCE(owed_generation, generation),
            expires_at = COALESCE(owed_expires_at, expires_at),
            request_id = CASE WHEN owed_event_id IS NULL
                THEN request_id ELSE gen_random_uuid() END,
            next_attempt_at = CASE WHEN owed_event_id IS NULL THEN NULL ELSE now() END,
            attempts = CASE WHEN owed_event_id IS NULL THEN attempts ELSE 0 END,
            owed_event_id = NULL, owed_generation = NULL, owed_expires_at = NULL,
            claim_id = NULL, lease_until = NULL, updated_at = now()
        WHERE community_id = $1 AND author = $2 AND installation_id = $3
          AND claim_id = $4 AND state = 'sending'
        "#,
    )
    .bind(claim.community.as_uuid())
    .bind(&claim.author)
    .bind(&claim.installation_id)
    .bind(claim.claim_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Return a fenced claim to `pending` for a bounded retry of the SAME cycle:
/// `request_id`, cycle identity, owed work, and attempt count all survive.
pub async fn retry_latch(
    pool: &PgPool,
    claim: &ClaimedLatch,
    next_attempt_at: DateTime<Utc>,
) -> Result<bool> {
    let result = sqlx::query(
        r#"
        UPDATE push_wake_latch
        SET state = 'pending', next_attempt_at = $5,
            claim_id = NULL, lease_until = NULL, updated_at = now()
        WHERE community_id = $1 AND author = $2 AND installation_id = $3
          AND claim_id = $4 AND state = 'sending'
        "#,
    )
    .bind(claim.community.as_uuid())
    .bind(&claim.author)
    .bind(&claim.installation_id)
    .bind(claim.claim_id)
    .bind(next_attempt_at)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration;
    use crate::push::{replace_active_lease, ActiveLease, LeaseVersion, ReplaceLeaseOutcome};

    async fn setup_pool() -> PgPool {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".into());
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect to test DB");
        migration::run_migrations(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn make_community(pool: &PgPool) -> CommunityId {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(format!("latch-test-{}.example", id.simple()))
            .execute(pool)
            .await
            .expect("insert community");
        CommunityId::from_uuid(id)
    }

    /// Random 32-byte id, unique across tests sharing one database.
    fn random_id() -> [u8; 32] {
        let mut id = [0_u8; 32];
        id[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        id[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        id
    }

    async fn activate(
        pool: &PgPool,
        community: CommunityId,
        author: &[u8],
        installation: &str,
        endpoint: &[u8],
        generation: i64,
    ) {
        assert_eq!(
            replace_active_lease(
                pool,
                community,
                author,
                installation,
                LeaseVersion {
                    source_event_id: Box::leak(Box::new(random_id())),
                    source_created_at: generation * 10,
                    generation,
                    expires_at: i64::MAX / 2,
                },
                ActiveLease {
                    app_profile: "ios-production",
                    endpoint_hash: endpoint,
                    endpoint_grant: "opaque-grant",
                    max_class: "default",
                    subscriptions: &serde_json::json!([]),
                },
            )
            .await
            .expect("activate lease"),
            ReplaceLeaseOutcome::Accepted
        );
    }

    async fn insert_event(pool: &PgPool, community: CommunityId, event_id: &[u8; 32]) {
        sqlx::query(
            "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig) \
             VALUES ($1, $2, $3, to_timestamp(1), 9, '[]', '', $4)",
        )
        .bind(community.as_uuid())
        .bind(event_id)
        .bind([42_u8; 32])
        .bind([43_u8; 64])
        .execute(pool)
        .await
        .expect("insert wake source event");
    }

    fn arm(author: [u8; 32], event: [u8; 32], generation: i64) -> LatchArm {
        LatchArm {
            author: author.to_vec(),
            installation_id: "install".into(),
            generation,
            event_id: event.to_vec(),
            expires_at: i64::MAX / 2,
        }
    }

    #[derive(Debug, PartialEq)]
    struct LatchRow {
        state: String,
        generation: i64,
        event_id: Vec<u8>,
        request_id: Uuid,
        owed_event_id: Option<Vec<u8>>,
        owed_generation: Option<i64>,
        attempts: i32,
        next_attempt_at: Option<DateTime<Utc>>,
        cooldown_until: DateTime<Utc>,
        updated_at: DateTime<Utc>,
    }

    async fn latch_row(pool: &PgPool, community: CommunityId, author: &[u8]) -> LatchRow {
        let row = sqlx::query(
            "SELECT state, generation, event_id, request_id, owed_event_id, owed_generation, \
                    attempts, next_attempt_at, cooldown_until, updated_at \
             FROM push_wake_latch \
             WHERE community_id = $1 AND author = $2 AND installation_id = 'install'",
        )
        .bind(community.as_uuid())
        .bind(author)
        .fetch_one(pool)
        .await
        .expect("latch row");
        LatchRow {
            state: row.try_get("state").expect("state"),
            generation: row.try_get("generation").expect("generation"),
            event_id: row.try_get("event_id").expect("event_id"),
            request_id: row.try_get("request_id").expect("request_id"),
            owed_event_id: row.try_get("owed_event_id").expect("owed_event_id"),
            owed_generation: row.try_get("owed_generation").expect("owed_generation"),
            attempts: row.try_get("attempts").expect("attempts"),
            next_attempt_at: row.try_get("next_attempt_at").expect("next_attempt_at"),
            cooldown_until: row.try_get("cooldown_until").expect("cooldown_until"),
            updated_at: row.try_get("updated_at").expect("updated_at"),
        }
    }

    async fn db_now(pool: &PgPool) -> DateTime<Utc> {
        sqlx::query_scalar("SELECT now()")
            .fetch_one(pool)
            .await
            .expect("db now")
    }

    async fn claim_one(pool: &PgPool, community: CommunityId, author: &[u8]) -> ClaimedLatch {
        claim_due_latches(pool, 64, Utc::now() + chrono::Duration::minutes(1))
            .await
            .expect("claim due latches")
            .into_iter()
            .find(|claim| claim.community == community && claim.author == author)
            .expect("expected latch claimed")
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn idle_arm_is_immediately_due_and_repeat_folds_are_write_free() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let author = [1; 32];
        activate(&pool, community, &author, "install", &[2; 32], 1).await;

        arm_latches(&pool, community, &[arm(author, [3; 32], 1)])
            .await
            .expect("first arm");
        let first = latch_row(&pool, community, &author).await;
        assert_eq!(first.state, "pending");
        assert_eq!(first.event_id, [3; 32]);
        assert_eq!(first.attempts, 0);
        assert!(first.next_attempt_at.expect("due") <= db_now(&pool).await);

        // Same generation, unexpired cycle: folds MUST be write-free.
        arm_latches(&pool, community, &[arm(author, [4; 32], 1)])
            .await
            .expect("fold");
        let folded = latch_row(&pool, community, &author).await;
        assert_eq!(folded, first, "pending fold must not touch the row");

        let rows: i64 =
            sqlx::query_scalar("SELECT count(*) FROM push_wake_latch WHERE community_id = $1")
                .bind(community.as_uuid())
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(rows, 1, "one latch per address regardless of event count");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn generation_change_refreshes_pending_cycle() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let author = [5; 32];
        activate(&pool, community, &author, "install", &[6; 32], 1).await;
        arm_latches(&pool, community, &[arm(author, [7; 32], 1)])
            .await
            .expect("arm");
        let first = latch_row(&pool, community, &author).await;

        activate(&pool, community, &author, "install", &[8; 32], 2).await;
        arm_latches(&pool, community, &[arm(author, [9; 32], 2)])
            .await
            .expect("rotated arm");
        let rotated = latch_row(&pool, community, &author).await;
        assert_eq!(rotated.state, "pending");
        assert_eq!(rotated.generation, 2, "stale-latch deadlock guard");
        assert_eq!(rotated.event_id, [9; 32]);
        assert_eq!(
            rotated.request_id, first.request_id,
            "no wake was sent; still the same pending cycle"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn sending_claim_is_immutable_and_folds_set_only_owed() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let author = [10; 32];
        activate(&pool, community, &author, "install", &[11; 32], 1).await;
        insert_event(&pool, community, &[12; 32]).await;
        arm_latches(&pool, community, &[arm(author, [12; 32], 1)])
            .await
            .expect("arm");

        let claim = claim_one(&pool, community, &author).await;
        assert_eq!(claim.event_id, [12; 32]);
        assert_eq!(claim.attempt, 1);

        // Fold during sending: claimed identity untouched, owed_* set once.
        arm_latches(&pool, community, &[arm(author, [13; 32], 1)])
            .await
            .expect("fold during sending");
        let owed = latch_row(&pool, community, &author).await;
        assert_eq!(owed.state, "sending");
        assert_eq!(owed.event_id, [12; 32], "claimed identity is immutable");
        assert_eq!(owed.request_id, claim.request_id);
        assert_eq!(owed.owed_event_id.as_deref(), Some([13; 32].as_slice()));

        // Second fold same generation: first-owed wins, write-free.
        arm_latches(&pool, community, &[arm(author, [14; 32], 1)])
            .await
            .expect("repeat fold during sending");
        assert_eq!(latch_row(&pool, community, &author).await, owed);

        // Generation change refreshes the owed triple (rotation rate).
        activate(&pool, community, &author, "install", &[15; 32], 2).await;
        arm_latches(&pool, community, &[arm(author, [16; 32], 2)])
            .await
            .expect("rotated fold during sending");
        let rotated = latch_row(&pool, community, &author).await;
        assert_eq!(rotated.event_id, [12; 32], "claim still immutable");
        assert_eq!(rotated.owed_event_id.as_deref(), Some([16; 32].as_slice()));
        assert_eq!(rotated.owed_generation, Some(2));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn fast_gateway_cooldown_bounds_accepted_wakes() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let author = [17; 32];
        activate(&pool, community, &author, "install", &[18; 32], 1).await;
        insert_event(&pool, community, &[19; 32]).await;

        // A: arm, claim, gateway ACCEPTS instantly (the fast-gateway case).
        arm_latches(&pool, community, &[arm(author, [19; 32], 1)])
            .await
            .expect("arm A");
        let claim_a = claim_one(&pool, community, &author).await;
        assert!(
            complete_latch_delivered(&pool, &claim_a, chrono::Duration::seconds(15))
                .await
                .expect("complete A")
        );
        let after_a = latch_row(&pool, community, &author).await;
        assert_eq!(after_a.state, "idle", "no owed work: latch idles");
        assert!(
            after_a.cooldown_until > db_now(&pool).await,
            "accepted delivery stamps a durable cooldown on the idle row"
        );

        // B: arrives idle-but-cooling. Must arm ONE pending cycle due exactly
        // at the cooldown boundary — not immediately, however fast the
        // gateway completed A.
        arm_latches(&pool, community, &[arm(author, [20; 32], 1)])
            .await
            .expect("arm B");
        let after_b = latch_row(&pool, community, &author).await;
        assert_eq!(after_b.state, "pending");
        assert_eq!(
            after_b.next_attempt_at,
            Some(after_a.cooldown_until),
            "leading wake defers to the cooldown boundary"
        );
        assert_ne!(after_b.request_id, claim_a.request_id, "new cycle, new id");
        assert!(
            claim_due_latches(&pool, 64, Utc::now() + chrono::Duration::minutes(1))
                .await
                .expect("claim during cooldown")
                .iter()
                .all(|c| !(c.community == community && c.author == author)),
            "cooling latch must not be claimable before cooldown_until"
        );

        // C: folds into B's pending cycle write-free.
        arm_latches(&pool, community, &[arm(author, [21; 32], 1)])
            .await
            .expect("arm C");
        assert_eq!(latch_row(&pool, community, &author).await, after_b);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn accepted_delivery_promotes_owed_work_at_cooldown_boundary() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let author = [22; 32];
        activate(&pool, community, &author, "install", &[23; 32], 1).await;
        insert_event(&pool, community, &[24; 32]).await;
        arm_latches(&pool, community, &[arm(author, [24; 32], 1)])
            .await
            .expect("arm");
        let claim = claim_one(&pool, community, &author).await;
        arm_latches(&pool, community, &[arm(author, [25; 32], 1)])
            .await
            .expect("fold during sending");

        assert!(
            complete_latch_delivered(&pool, &claim, chrono::Duration::seconds(15))
                .await
                .expect("complete")
        );
        let promoted = latch_row(&pool, community, &author).await;
        assert_eq!(promoted.state, "pending");
        assert_eq!(promoted.event_id, [25; 32], "owed became current");
        assert_eq!(promoted.owed_event_id, None);
        assert_ne!(promoted.request_id, claim.request_id, "fresh cycle id");
        assert_eq!(promoted.attempts, 0, "attempts reset per cycle");
        assert_eq!(
            promoted.next_attempt_at,
            Some(promoted.cooldown_until),
            "trailing wake due exactly at the cooldown boundary"
        );

        // Completion is fenced: a stale claim must not double-exit.
        assert!(
            !complete_latch_delivered(&pool, &claim, chrono::Duration::seconds(15))
                .await
                .expect("stale complete")
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn undelivered_exit_promotes_immediately_without_cooldown() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let author = [26; 32];
        activate(&pool, community, &author, "install", &[27; 32], 1).await;
        insert_event(&pool, community, &[28; 32]).await;
        arm_latches(&pool, community, &[arm(author, [28; 32], 1)])
            .await
            .expect("arm");
        let claim = claim_one(&pool, community, &author).await;
        arm_latches(&pool, community, &[arm(author, [29; 32], 1)])
            .await
            .expect("fold during sending");

        assert!(release_latch_undelivered(&pool, &claim)
            .await
            .expect("release"));
        let promoted = latch_row(&pool, community, &author).await;
        assert_eq!(promoted.state, "pending");
        assert_eq!(promoted.event_id, [29; 32], "owed work never discarded");
        assert!(
            promoted.next_attempt_at.expect("due") <= db_now(&pool).await,
            "no wake reached the device, so no cooldown is owed"
        );
        let epoch = DateTime::<Utc>::from_timestamp(0, 0).expect("epoch");
        assert_eq!(promoted.cooldown_until, epoch, "no cooldown stamp");

        // Without owed work the same exit idles the latch.
        let claim = claim_one(&pool, community, &author).await;
        assert!(release_latch_undelivered(&pool, &claim)
            .await
            .expect("release idle"));
        let idled = latch_row(&pool, community, &author).await;
        assert_eq!(idled.state, "idle");
        assert_eq!(idled.next_attempt_at, None);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn retry_and_expired_claim_recovery_preserve_cycle_identity() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let author = [30; 32];
        activate(&pool, community, &author, "install", &[31; 32], 1).await;
        insert_event(&pool, community, &[32; 32]).await;
        arm_latches(&pool, community, &[arm(author, [32; 32], 1)])
            .await
            .expect("arm");
        let first = claim_one(&pool, community, &author).await;
        arm_latches(&pool, community, &[arm(author, [33; 32], 1)])
            .await
            .expect("fold during sending");

        // Bounded retry of the SAME cycle: request_id, owed, attempts survive.
        assert!(retry_latch(&pool, &first, Utc::now()).await.expect("retry"));
        let retried = latch_row(&pool, community, &author).await;
        assert_eq!(retried.state, "pending");
        assert_eq!(retried.request_id, first.request_id);
        assert_eq!(retried.owed_event_id.as_deref(), Some([33; 32].as_slice()));
        assert_eq!(retried.attempts, 1, "retry does not reset attempts");

        let second = claim_one(&pool, community, &author).await;
        assert_eq!(second.request_id, first.request_id);
        assert_eq!(second.attempt, 2);

        // Crash recovery: expire the claim lease; the recovery arm reclaims
        // it globally as a retry of the same cycle.
        sqlx::query(
            "UPDATE push_wake_latch SET lease_until = now() - interval '1 second' \
             WHERE community_id = $1 AND author = $2 AND installation_id = 'install'",
        )
        .bind(community.as_uuid())
        .bind(author.as_slice())
        .execute(&pool)
        .await
        .expect("expire claim lease");
        let recovered = claim_one(&pool, community, &author).await;
        assert_eq!(recovered.request_id, first.request_id);
        assert_ne!(recovered.claim_id, second.claim_id, "fresh fence");
        assert_eq!(recovered.attempt, 3);
        let row = latch_row(&pool, community, &author).await;
        assert_eq!(row.owed_event_id.as_deref(), Some([33; 32].as_slice()));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn revalidation_delivers_current_lease_and_suppresses_rotated_one() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let author = [34; 32];
        activate(&pool, community, &author, "install", &[35; 32], 1).await;
        insert_event(&pool, community, &[36; 32]).await;
        arm_latches(&pool, community, &[arm(author, [36; 32], 1)])
            .await
            .expect("arm");
        let claim = claim_one(&pool, community, &author).await;

        let outcome = revalidate_latch_for_send(&pool, &claim)
            .await
            .expect("revalidate");
        let RevalidateLatchOutcome::Deliver(deliverable) = outcome else {
            panic!("expected deliverable claim, got {outcome:?}");
        };
        assert_eq!(deliverable.claim, claim);
        assert_eq!(deliverable.endpoint_grant, "opaque-grant");

        // Lease rotates mid-flight: send-time authorization must refuse.
        activate(&pool, community, &author, "install", &[37; 32], 2).await;
        assert_eq!(
            revalidate_latch_for_send(&pool, &claim)
                .await
                .expect("revalidate after rotate"),
            RevalidateLatchOutcome::Suppressed
        );
        // The suppressed claim exits through promote-or-idle and heals.
        assert!(release_latch_undelivered(&pool, &claim)
            .await
            .expect("release suppressed"));
        assert_eq!(latch_row(&pool, community, &author).await.state, "idle");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn expired_pending_cycle_is_refreshed_by_next_fold() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let author = [38; 32];
        activate(&pool, community, &author, "install", &[39; 32], 1).await;
        arm_latches(&pool, community, &[arm(author, [40; 32], 1)])
            .await
            .expect("arm");
        sqlx::query(
            "UPDATE push_wake_latch SET expires_at = 1 \
             WHERE community_id = $1 AND author = $2 AND installation_id = 'install'",
        )
        .bind(community.as_uuid())
        .bind(author.as_slice())
        .execute(&pool)
        .await
        .expect("expire current cycle");

        // Folds against an expired current cycle must NOT be write-free
        // forever: the guard refreshes the cycle identity.
        arm_latches(&pool, community, &[arm(author, [41; 32], 1)])
            .await
            .expect("fold after expiry");
        let refreshed = latch_row(&pool, community, &author).await;
        assert_eq!(refreshed.event_id, [41; 32]);
        assert!(refreshed.state == "pending");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn batch_collapses_per_address_and_isolates_addresses() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let alice = [44; 32];
        let bob = [45; 32];
        activate(&pool, community, &alice, "install", &[46; 32], 2).await;
        activate(&pool, community, &bob, "install", &[47; 32], 1).await;

        // Two arms for alice in one batch (self-conflict without collapse)
        // plus one for bob: one statement, no error, newest lease view wins.
        arm_latches(
            &pool,
            community,
            &[
                arm(alice, [48; 32], 1),
                arm(alice, [49; 32], 2),
                arm(bob, [50; 32], 1),
            ],
        )
        .await
        .expect("batch arm");
        let alice_row = latch_row(&pool, community, &alice).await;
        assert_eq!(alice_row.generation, 2, "highest generation wins collapse");
        assert_eq!(alice_row.event_id, [49; 32]);
        let bob_row = latch_row(&pool, community, &bob).await;
        assert_eq!(bob_row.event_id, [50; 32], "addresses never cross");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn brownfield_seed_arms_live_addresses_and_leaves_legacy_untouched() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let live = [51; 32];
        let expired = [52; 32];
        activate(&pool, community, &live, "install", &[53; 32], 1).await;
        activate(&pool, community, &expired, "install", &[54; 32], 1).await;

        let legacy = |author: [u8; 32],
                      event: [u8; 32],
                      state: &'static str,
                      expires_at: i64,
                      created_at: &'static str| {
            let community = community.as_uuid();
            let pool = pool.clone();
            async move {
                sqlx::query(
                    "INSERT INTO push_wake_outbox (community_id, author, installation_id, \
                         lease_generation, endpoint_hash, event_id, class, expires_at, state, \
                         lease_until, claim_id, created_at) \
                     VALUES ($1, $2, 'install', 1, $3, $4, 'default', $5, $6, \
                         CASE WHEN $6 = 'sending' THEN now() + interval '1 minute' END, \
                         CASE WHEN $6 = 'sending' THEN gen_random_uuid() END, $7::timestamptz)",
                )
                .bind(community)
                .bind(author.as_slice())
                .bind([author[0]; 32].as_slice())
                .bind(event.as_slice())
                .bind(expires_at)
                .bind(state)
                .bind(created_at)
                .execute(&pool)
                .await
                .expect("insert legacy outbox row");
            }
        };
        // Two live rows for one address (older pending, newer sending) and
        // one expired row for another: seed must produce exactly one latch,
        // representative = newest live row.
        legacy(
            live,
            [55; 32],
            "pending",
            i64::MAX / 2,
            "2026-01-01T00:00:00Z",
        )
        .await;
        legacy(
            live,
            [56; 32],
            "sending",
            i64::MAX / 2,
            "2026-01-02T00:00:00Z",
        )
        .await;
        legacy(expired, [57; 32], "pending", 1, "2026-01-01T00:00:00Z").await;

        // Execute the actual shipped seed statement from migration 0025 (the
        // migrator already ran it against an empty table at setup).
        let migration = include_str!("../../../migrations/0025_push_wake_latch.sql");
        let seed_start = migration
            .find("INSERT INTO push_wake_latch")
            .expect("seed statement present in 0025");
        sqlx::query(&migration[seed_start..])
            .execute(&pool)
            .await
            .expect("run 0025 seed");

        let latches: Vec<(Vec<u8>, String, Vec<u8>)> = sqlx::query(
            "SELECT author, state, event_id FROM push_wake_latch WHERE community_id = $1",
        )
        .bind(community.as_uuid())
        .fetch_all(&pool)
        .await
        .expect("seeded latches")
        .into_iter()
        .map(|row| {
            (
                row.try_get("author").expect("author"),
                row.try_get("state").expect("state"),
                row.try_get("event_id").expect("event_id"),
            )
        })
        .collect();
        assert_eq!(
            latches,
            vec![(live.to_vec(), "pending".into(), [56; 32].to_vec())],
            "one pending latch per live address, newest representative, \
             expired addresses skipped"
        );

        // 0025 must leave the legacy outbox fully intact for dual-drain.
        let legacy_rows: Vec<(Vec<u8>, String)> = sqlx::query(
            "SELECT event_id, state FROM push_wake_outbox \
             WHERE community_id = $1 ORDER BY created_at",
        )
        .bind(community.as_uuid())
        .fetch_all(&pool)
        .await
        .expect("legacy rows")
        .into_iter()
        .map(|row| {
            (
                row.try_get("event_id").expect("event_id"),
                row.try_get("state").expect("state"),
            )
        })
        .collect();
        assert_eq!(
            legacy_rows,
            vec![
                ([55; 32].to_vec(), "pending".into()),
                ([57; 32].to_vec(), "pending".into()),
                ([56; 32].to_vec(), "sending".into()),
            ],
            "legacy rows untouched (0026 owns retirement)"
        );
    }
}

//! Group-commit batching for plain (non-replaceable, non-reaction) event inserts.
//!
//! At high ingest rates each plain event pays a full synchronous COMMIT (WAL
//! flush; on Aurora, a storage-quorum ack). A single writer task coalesces
//! concurrent inserts into one transaction so one commit amortizes over the
//! whole batch, while each caller still gets its own per-event result.
//!
//! Batching is opportunistic, not timed: the worker takes one request, then
//! drains whatever else is already queued (up to `max_batch`). A lone request
//! under light load flushes immediately with zero added latency; batches only
//! form while a previous transaction is committing.
//!
//! Semantics relative to [`Db::insert_event_with_thread_metadata`]:
//!
//! - **ACK-after-commit.** A caller's future resolves only after the
//!   transaction containing its event has durably committed (or definitively
//!   failed). No caller is ever answered from an uncommitted state.
//! - **Poison isolation, layer 1 (statement time).** Each event runs under a
//!   savepoint; a statement-time failure (FK violation, rejected kind) fails
//!   only that event — its batch-mates commit.
//! - **Poison isolation, layer 2 (commit time).** Deferred constraint
//!   triggers (migrations 0021/0022) fire during COMMIT, after savepoints are
//!   released, so one bad row aborts the whole batch transaction. When COMMIT
//!   fails with a *server-reported* error (the transaction provably aborted
//!   and nothing committed), every request is replayed individually through
//!   the unbatched path so the poison event fails alone.
//! - **Indeterminate commits are not replayed.** A COMMIT failure that does
//!   not prove an abort (connection dropped while awaiting the response) may
//!   have committed server-side. A blind replay would misreport durable
//!   inserts as duplicates and skip their mentions, so every caller instead
//!   receives [`DbError::CommitOutcomeUnknown`]. Client retries are safe:
//!   event inserts are idempotent (`ON CONFLICT DO NOTHING` → `duplicate:`).
//! - **Mentions stay outside the event transaction**, exactly as the
//!   unbatched wrapper does today: after commit, each newly inserted event's
//!   mentions insert runs on the pool (log-and-succeed), and the caller is
//!   answered only after its own mentions attempt.
//!
//! Shutdown: `mpsc::Receiver::recv` keeps yielding buffered requests after
//! all senders drop and returns `None` only once the queue is empty, so the
//! worker drains naturally. If the worker is gone, [`EventWriteBatcher::
//! insert_event_with_thread_metadata`] returns `None` and the caller falls
//! back to the direct insert path — a dead batcher degrades to today's
//! behavior, it never hangs an ingest future.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use buzz_core::{CommunityId, StoredEvent};

use crate::error::{DbError, Result};
use crate::event::ThreadMetadataParams;
use crate::Db;

/// Default maximum events coalesced into one transaction.
pub const DEFAULT_MAX_BATCH: usize = 16;

/// Queue depth for pending insert requests (matches the relay's default
/// concurrent-handler ceiling; `send` applies backpressure beyond it).
const QUEUE_DEPTH: usize = 1024;

/// Owned thread metadata for a batched insert.
///
/// Mirrors [`ThreadMetadataParams`], which borrows and therefore cannot cross
/// the queue.
#[derive(Debug, Clone)]
pub struct ThreadMetadataOwned {
    /// The Nostr event ID of this message.
    pub event_id: Vec<u8>,
    /// When the event was created.
    pub event_created_at: DateTime<Utc>,
    /// The channel this event belongs to.
    pub channel_id: Uuid,
    /// Event ID of the direct parent, if this is a reply.
    pub parent_event_id: Option<Vec<u8>>,
    /// When the parent event was created.
    pub parent_event_created_at: Option<DateTime<Utc>>,
    /// Event ID of the thread root, if this is a nested reply.
    pub root_event_id: Option<Vec<u8>>,
    /// When the root event was created.
    pub root_event_created_at: Option<DateTime<Utc>>,
    /// Nesting depth (root = 0).
    pub depth: i32,
    /// Whether this reply is broadcast to the channel timeline.
    pub broadcast: bool,
}

impl ThreadMetadataOwned {
    /// Borrow as the parameter struct used by the insert primitives.
    pub fn as_params(&self) -> ThreadMetadataParams<'_> {
        ThreadMetadataParams {
            event_id: &self.event_id,
            event_created_at: self.event_created_at,
            channel_id: self.channel_id,
            parent_event_id: self.parent_event_id.as_deref(),
            parent_event_created_at: self.parent_event_created_at,
            root_event_id: self.root_event_id.as_deref(),
            root_event_created_at: self.root_event_created_at,
            depth: self.depth,
            broadcast: self.broadcast,
        }
    }
}

struct BatchRequest {
    community_id: CommunityId,
    event: nostr::Event,
    channel_id: Option<Uuid>,
    thread_meta: Option<ThreadMetadataOwned>,
    respond: oneshot::Sender<Result<(StoredEvent, bool)>>,
}

#[derive(Debug, Default)]
struct BatchCounters {
    batch_commits: AtomicU64,
    batch_events_committed: AtomicU64,
    single_flushes: AtomicU64,
    fallback_events: AtomicU64,
    indeterminate_commits: AtomicU64,
}

/// Point-in-time snapshot of the batcher's monotonic counters.
///
/// `batch_commits`/`batch_events_committed` count only *successful*
/// multi-event commits, so coalescing cannot be claimed by batches that
/// aborted and replayed individually (those land in `fallback_events`).
#[derive(Debug, Clone, Copy)]
pub struct BatchStats {
    /// Multi-event batch transactions that committed.
    pub batch_commits: u64,
    /// Events newly inserted (`was_inserted == true`) inside committed
    /// multi-event batches.
    pub batch_events_committed: u64,
    /// Requests executed alone because nothing else was queued (idle path).
    pub single_flushes: u64,
    /// Requests replayed individually after a provably aborted batch commit.
    pub fallback_events: u64,
    /// Batch commits whose outcome could not be determined (transport
    /// failure while awaiting the COMMIT response).
    pub indeterminate_commits: u64,
}

/// Handle to the group-commit writer task. Cheap to clone.
#[derive(Clone)]
pub struct EventWriteBatcher {
    tx: mpsc::Sender<BatchRequest>,
    counters: Arc<BatchCounters>,
}

impl EventWriteBatcher {
    /// Spawn the writer task on the current Tokio runtime.
    ///
    /// `max_batch` is clamped to at least 2 — a max of 1 would be the direct
    /// path with extra steps; callers wanting batching off should not
    /// construct a batcher at all.
    pub fn spawn(db: Db, max_batch: usize) -> Self {
        let (tx, rx) = mpsc::channel(QUEUE_DEPTH);
        let counters = Arc::new(BatchCounters::default());
        tokio::spawn(worker(db, rx, max_batch.max(2), Arc::clone(&counters)));
        Self { tx, counters }
    }

    /// Snapshot the batcher's counters.
    pub fn stats(&self) -> BatchStats {
        BatchStats {
            batch_commits: self.counters.batch_commits.load(Ordering::Relaxed),
            batch_events_committed: self.counters.batch_events_committed.load(Ordering::Relaxed),
            single_flushes: self.counters.single_flushes.load(Ordering::Relaxed),
            fallback_events: self.counters.fallback_events.load(Ordering::Relaxed),
            indeterminate_commits: self.counters.indeterminate_commits.load(Ordering::Relaxed),
        }
    }

    /// Enqueue an insert and await its per-event result.
    ///
    /// Returns `None` when the worker is unavailable (exited or panicked
    /// before accepting the request); the caller must fall back to the
    /// direct insert path.
    pub async fn insert_event_with_thread_metadata(
        &self,
        community_id: CommunityId,
        event: &nostr::Event,
        channel_id: Option<Uuid>,
        thread_meta: Option<ThreadMetadataOwned>,
    ) -> Option<Result<(StoredEvent, bool)>> {
        let (respond, rx) = oneshot::channel();
        let request = BatchRequest {
            community_id,
            event: event.clone(),
            channel_id,
            thread_meta,
            respond,
        };
        if self.tx.send(request).await.is_err() {
            return None;
        }
        match rx.await {
            Ok(result) => Some(result),
            // The worker accepted the request but dropped the response
            // channel (panic mid-batch). The write may or may not have
            // committed; report unknown rather than guessing.
            Err(_) => Some(Err(DbError::CommitOutcomeUnknown(
                "event write batcher dropped the request".into(),
            ))),
        }
    }
}

async fn worker(
    db: Db,
    mut rx: mpsc::Receiver<BatchRequest>,
    max_batch: usize,
    counters: Arc<BatchCounters>,
) {
    while let Some(first) = rx.recv().await {
        let mut batch = Vec::with_capacity(max_batch);
        batch.push(first);
        while batch.len() < max_batch {
            match rx.try_recv() {
                Ok(request) => batch.push(request),
                Err(_) => break,
            }
        }
        execute_batch(&db, batch, &counters).await;
    }
    tracing::info!("event write batcher exited (queue closed and drained)");
}

/// Outcome of one attempted multi-event batch transaction.
enum BatchAttempt {
    /// COMMIT succeeded; per-event results are in request order.
    Committed(Vec<Result<(StoredEvent, bool)>>),
    /// The transaction provably aborted (server-reported error, or failure
    /// before COMMIT was issued). Nothing committed; safe to replay.
    Aborted,
    /// COMMIT outcome unknown (transport failure awaiting the response).
    Indeterminate(String),
}

/// Whether a COMMIT error proves the transaction aborted.
///
/// Only an explicit allowlist of SQLSTATEs qualifies — codes PostgreSQL
/// raises *while rolling the transaction back*:
///
/// - class `23` (integrity constraint violation): deferred constraint
///   triggers fire during COMMIT and abort it — the 0021/0022 guards raise
///   `check_violation` (23514) — as do deferred FK/unique checks;
/// - `40001` (`serialization_failure`) and `40P01` (`deadlock_detected`):
///   PostgreSQL guarantees the transaction rolled back.
///
/// Everything else is indeterminate, **including** server-reported errors:
/// `08007` (`transaction_resolution_unknown`) and `40003`
/// (`statement_completion_unknown`) explicitly mean the server lost track of
/// the outcome, and an unknown or missing SQLSTATE proves nothing. A false
/// "aborted" here would replay a transaction that actually committed —
/// misreporting durable inserts as duplicates and skipping their mentions —
/// so the default must be indeterminate.
fn commit_definitely_aborted(error: &sqlx::Error) -> bool {
    let sqlx::Error::Database(db_error) = error else {
        return false;
    };
    let Some(code) = db_error.code() else {
        return false;
    };
    code.starts_with("23") || code == "40001" || code == "40P01"
}

async fn run_batch_txn(db: &Db, batch: &[BatchRequest]) -> BatchAttempt {
    // Failures before COMMIT (including begin) leave nothing committed:
    // dropping the transaction rolls it back server-side.
    let Ok(mut tx) = db.pool.begin().await else {
        return BatchAttempt::Aborted;
    };

    let mut results = Vec::with_capacity(batch.len());
    for request in batch {
        if sqlx::query("SAVEPOINT batch_event")
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return BatchAttempt::Aborted;
        }
        let params = request.thread_meta.as_ref().map(|m| m.as_params());
        match crate::event::insert_event_with_thread_metadata_tx(
            &mut tx,
            request.community_id,
            &request.event,
            request.channel_id,
            params,
        )
        .await
        {
            Ok(ok) => {
                if sqlx::query("RELEASE SAVEPOINT batch_event")
                    .execute(&mut *tx)
                    .await
                    .is_err()
                {
                    return BatchAttempt::Aborted;
                }
                results.push(Ok(ok));
            }
            Err(e) => {
                // Statement-time poison: unwind just this event. ROLLBACK TO
                // keeps the savepoint defined; the next SAVEPOINT re-binds it.
                if sqlx::query("ROLLBACK TO SAVEPOINT batch_event")
                    .execute(&mut *tx)
                    .await
                    .is_err()
                {
                    return BatchAttempt::Aborted;
                }
                results.push(Err(e));
            }
        }
    }

    match tx.commit().await {
        Ok(()) => BatchAttempt::Committed(results),
        Err(e) if commit_definitely_aborted(&e) => {
            tracing::warn!("batch commit aborted by server, replaying individually: {e}");
            BatchAttempt::Aborted
        }
        Err(e) => BatchAttempt::Indeterminate(e.to_string()),
    }
}

async fn execute_batch(db: &Db, batch: Vec<BatchRequest>, counters: &BatchCounters) {
    if batch.len() == 1 {
        counters.single_flushes.fetch_add(1, Ordering::Relaxed);
        let request = batch.into_iter().next().expect("len == 1");
        respond_direct(db, request).await;
        return;
    }

    match run_batch_txn(db, &batch).await {
        BatchAttempt::Committed(results) => {
            let inserted = results
                .iter()
                .filter(|r| matches!(r, Ok((_, true))))
                .count() as u64;
            counters.batch_commits.fetch_add(1, Ordering::Relaxed);
            counters
                .batch_events_committed
                .fetch_add(inserted, Ordering::Relaxed);

            // Post-commit mentions, matching the unbatched wrapper: only for
            // newly inserted events, log-and-succeed, and each caller is
            // answered after its own attempt. Concurrent — mention inserts
            // are independent single statements.
            let mut mention_tasks = tokio::task::JoinSet::new();
            for (request, result) in batch.into_iter().zip(results) {
                match result {
                    Ok((stored, true)) => {
                        let pool = db.pool.clone();
                        mention_tasks.spawn(async move {
                            if let Err(e) = crate::insert_mentions(
                                &pool,
                                request.community_id,
                                &request.event,
                                request.channel_id,
                            )
                            .await
                            {
                                tracing::warn!(
                                    event_id = %request.event.id,
                                    "Failed to insert mentions: {e}"
                                );
                            }
                            let _ = request.respond.send(Ok((stored, true)));
                        });
                    }
                    other => {
                        let _ = request.respond.send(other);
                    }
                }
            }
            while mention_tasks.join_next().await.is_some() {}
        }
        BatchAttempt::Aborted => {
            counters
                .fallback_events
                .fetch_add(batch.len() as u64, Ordering::Relaxed);
            // Nothing committed; replay each request through the unbatched
            // path (which owns its mentions) so a poison event fails alone.
            for request in batch {
                respond_direct(db, request).await;
            }
        }
        BatchAttempt::Indeterminate(message) => {
            counters
                .indeterminate_commits
                .fetch_add(1, Ordering::Relaxed);
            for request in batch {
                let _ = request
                    .respond
                    .send(Err(DbError::CommitOutcomeUnknown(message.clone())));
            }
        }
    }
}

/// Execute one request through the existing unbatched wrapper (event
/// transaction + post-commit mentions) and answer its caller.
async fn respond_direct(db: &Db, request: BatchRequest) {
    let params = request.thread_meta.as_ref().map(|m| m.as_params());
    let result = db
        .insert_event_with_thread_metadata(
            request.community_id,
            &request.event,
            request.channel_id,
            params,
        )
        .await;
    let _ = request.respond.send(result);
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    use sqlx::postgres::PgPoolOptions;
    use sqlx::PgPool;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";

    fn test_db_url() -> String {
        std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned())
    }

    async fn setup_db() -> Db {
        let pool = PgPool::connect(&test_db_url())
            .await
            .expect("connect to test DB");
        Db::from_pool(pool)
    }

    /// A `Db` whose every connection arms the migration-0021 commit-time
    /// `created_at` floor, like the relay's writer pool does in production.
    async fn setup_db_with_floor(floor_secs: u32) -> Db {
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .after_connect(move |conn, _meta| {
                Box::pin(async move {
                    sqlx::query("SELECT set_config('buzz.created_at_floor', $1, false)")
                        .bind(floor_secs.to_string())
                        .execute(conn)
                        .await?;
                    Ok(())
                })
            })
            .connect(&test_db_url())
            .await
            .expect("connect floor-armed test DB");
        Db::from_pool(pool)
    }

    async fn make_test_community(db: &Db) -> CommunityId {
        let id = Uuid::new_v4();
        let host = format!("batch-test-{}.example", id.simple());
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(host)
            .execute(&db.pool)
            .await
            .expect("insert test community");
        CommunityId::from_uuid(id)
    }

    async fn make_test_channel(db: &Db, community: CommunityId) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO channels (id, community_id, name, created_by) VALUES ($1, $2, $3, $4)",
        )
        .bind(id)
        .bind(community.as_uuid())
        .bind(format!("batch-test-{}", id.simple()))
        .bind(vec![7_u8; 32])
        .execute(&db.pool)
        .await
        .expect("insert test channel");
        id
    }

    fn make_event(content: &str) -> nostr::Event {
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(9), content)
            .sign_with_keys(&keys)
            .expect("sign event")
    }

    fn make_stale_event(content: &str, age_secs: u64) -> nostr::Event {
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(9), content)
            .custom_created_at(Timestamp::from_secs(Timestamp::now().as_secs() - age_secs))
            .sign_with_keys(&keys)
            .expect("sign stale event")
    }

    fn make_auth_event() -> nostr::Event {
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(22242), "auth")
            .tags(vec![Tag::parse(["nonce", "batch-test"]).expect("tag")])
            .sign_with_keys(&keys)
            .expect("sign auth event")
    }

    fn reply_meta(
        event: &nostr::Event,
        channel_id: Uuid,
        root: &nostr::Event,
    ) -> ThreadMetadataOwned {
        ThreadMetadataOwned {
            event_id: event.id.as_bytes().to_vec(),
            event_created_at: DateTime::from_timestamp(event.created_at.as_secs() as i64, 0)
                .expect("event ts"),
            channel_id,
            parent_event_id: Some(root.id.as_bytes().to_vec()),
            parent_event_created_at: Some(
                DateTime::from_timestamp(root.created_at.as_secs() as i64, 0).expect("root ts"),
            ),
            root_event_id: Some(root.id.as_bytes().to_vec()),
            root_event_created_at: Some(
                DateTime::from_timestamp(root.created_at.as_secs() as i64, 0).expect("root ts"),
            ),
            depth: 1,
            broadcast: false,
        }
    }

    fn request(
        community: CommunityId,
        event: &nostr::Event,
        channel_id: Option<Uuid>,
        thread_meta: Option<ThreadMetadataOwned>,
    ) -> (BatchRequest, oneshot::Receiver<Result<(StoredEvent, bool)>>) {
        let (respond, rx) = oneshot::channel();
        (
            BatchRequest {
                community_id: community,
                event: event.clone(),
                channel_id,
                thread_meta,
                respond,
            },
            rx,
        )
    }

    async fn count_event_rows(db: &Db, community: CommunityId, event: &nostr::Event) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id = $1 AND id = $2")
            .bind(community.as_uuid())
            .bind(event.id.as_bytes().as_slice())
            .fetch_one(&db.pool)
            .await
            .expect("count event rows")
    }

    /// One deterministic batch mixing good, duplicate-in-batch, statement-time
    /// poison (FK violation + rejected AUTH kind), and threaded replies:
    /// every caller gets its own correct result, poison fails alone, thread
    /// counters land exactly, and every reported insert is durable.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn mixed_batch_maps_results_per_event() {
        let db = setup_db().await;
        let community = make_test_community(&db).await;
        let channel = make_test_channel(&db, community).await;
        let counters = BatchCounters::default();

        // Root inserted up front so replies have a live target.
        let root = make_event("root");
        let (root_req, root_rx) = request(community, &root, Some(channel), None);
        execute_batch(&db, vec![root_req], &counters).await;
        assert!(
            root_rx
                .await
                .expect("root response")
                .expect("root insert")
                .1
        );
        assert_eq!(counters.single_flushes.load(Ordering::Relaxed), 1);

        let good = make_event("good");
        let dup = make_event("duplicated");
        let fk_poison = make_event("fk poison");
        // thread_metadata.channel_id → channels FK: a random UUID violates it
        // mid-transaction (statement-time poison with real SQL error).
        let bad_channel_meta = ThreadMetadataOwned {
            channel_id: Uuid::new_v4(),
            ..reply_meta(&fk_poison, channel, &root)
        };
        let auth_poison = make_auth_event();
        let reply_a = make_event("reply a");
        let reply_b = make_event("reply b");

        let (requests, receivers): (Vec<_>, Vec<_>) = vec![
            request(community, &good, Some(channel), None),
            request(community, &dup, Some(channel), None),
            request(community, &dup, Some(channel), None), // duplicate within one batch
            request(community, &fk_poison, Some(channel), Some(bad_channel_meta)),
            request(community, &auth_poison, Some(channel), None),
            request(
                community,
                &reply_a,
                Some(channel),
                Some(reply_meta(&reply_a, channel, &root)),
            ),
            request(
                community,
                &reply_b,
                Some(channel),
                Some(reply_meta(&reply_b, channel, &root)),
            ),
        ]
        .into_iter()
        .unzip();

        execute_batch(&db, requests, &counters).await;

        let mut results = Vec::new();
        for rx in receivers {
            results.push(rx.await.expect("caller answered"));
        }

        assert!(results[0].as_ref().expect("good").1, "good inserted");
        assert!(
            results[1].as_ref().expect("dup first").1,
            "first dup inserted"
        );
        assert!(
            !results[2].as_ref().expect("dup second").1,
            "second dup deduplicated in same batch"
        );
        assert!(results[3].is_err(), "FK poison fails alone");
        assert!(
            matches!(results[4], Err(DbError::AuthEventRejected)),
            "AUTH kind rejected"
        );
        assert!(results[5].as_ref().expect("reply a").1);
        assert!(results[6].as_ref().expect("reply b").1);

        // Every reported insert is durable; the poison event never landed.
        for event in [&good, &dup, &reply_a, &reply_b] {
            assert_eq!(count_event_rows(&db, community, event).await, 1);
        }
        assert_eq!(count_event_rows(&db, community, &fk_poison).await, 0);
        assert_eq!(count_event_rows(&db, community, &auth_poison).await, 0);

        // Thread counters on the root reflect exactly the two committed replies.
        let (reply_count, descendant_count): (i32, i32) = sqlx::query_as(
            "SELECT reply_count, descendant_count FROM thread_metadata \
             WHERE community_id = $1 AND event_id = $2",
        )
        .bind(community.as_uuid())
        .bind(root.id.as_bytes().as_slice())
        .fetch_one(&db.pool)
        .await
        .expect("root thread metadata");
        assert_eq!((reply_count, descendant_count), (2, 2));

        // Coalescing counters: one multi-event commit with four newly
        // inserted rows (good, first dup, two replies).
        assert_eq!(counters.batch_commits.load(Ordering::Relaxed), 1);
        assert_eq!(counters.batch_events_committed.load(Ordering::Relaxed), 4);
        assert_eq!(counters.fallback_events.load(Ordering::Relaxed), 0);
    }

    /// A deferred-trigger failure (migration-0021 created_at floor) aborts the
    /// whole batch at COMMIT — after savepoints are gone. The batch must
    /// replay per-event so the stale event fails alone and its batch-mates
    /// commit; nobody may be told "inserted" by the aborted first attempt.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn deferred_trigger_abort_replays_per_event() {
        let db = setup_db_with_floor(60).await;
        let community = make_test_community(&db).await;
        let channel = make_test_channel(&db, community).await;
        let counters = BatchCounters::default();

        let good_a = make_event("survives deferred abort a");
        let stale = make_stale_event("below the floor", 3600);
        let good_b = make_event("survives deferred abort b");

        let (requests, receivers): (Vec<_>, Vec<_>) = vec![
            request(community, &good_a, Some(channel), None),
            request(community, &stale, Some(channel), None),
            request(community, &good_b, Some(channel), None),
        ]
        .into_iter()
        .unzip();

        execute_batch(&db, requests, &counters).await;

        let mut results = Vec::new();
        for rx in receivers {
            results.push(rx.await.expect("caller answered"));
        }

        assert!(results[0].as_ref().expect("good a").1);
        assert!(results[1].is_err(), "stale event fails its own commit");
        assert!(results[2].as_ref().expect("good b").1);

        assert_eq!(count_event_rows(&db, community, &good_a).await, 1);
        assert_eq!(count_event_rows(&db, community, &stale).await, 0);
        assert_eq!(count_event_rows(&db, community, &good_b).await, 1);

        assert_eq!(counters.batch_commits.load(Ordering::Relaxed), 0);
        assert_eq!(counters.fallback_events.load(Ordering::Relaxed), 3);
        assert_eq!(counters.indeterminate_commits.load(Ordering::Relaxed), 0);
    }

    /// Commit-error classification allowlist, exercised with real
    /// server-reported SQLSTATEs raised by Postgres: only codes proving
    /// rollback (class 23, 40001, 40P01) classify as aborted. Indeterminate
    /// server-reported outcomes — `08007 transaction_resolution_unknown`,
    /// `40003 statement_completion_unknown` — and arbitrary other database
    /// errors must NOT be treated as proof of abort, nor may transport-shaped
    /// non-database errors.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn commit_abort_classification() {
        let db = setup_db().await;

        let raise = |code: &'static str| {
            let pool = db.pool.clone();
            async move {
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                    "DO $$ BEGIN RAISE EXCEPTION 'classifier probe' USING ERRCODE = '{code}'; END $$;"
                )))
                .execute(&pool)
                .await
                .expect_err("raise must error")
            }
        };

        // Proves rollback → replay is safe.
        for code in ["23514", "23503", "23505", "40001", "40P01"] {
            assert!(
                commit_definitely_aborted(&raise(code).await),
                "{code} proves rollback"
            );
        }

        // Server-reported but outcome-indeterminate or irrelevant → no replay.
        for code in ["08007", "40003", "42703", "57014", "53300", "XX000"] {
            assert!(
                !commit_definitely_aborted(&raise(code).await),
                "{code} must not be treated as proof of abort"
            );
        }

        // Transport/pool-shaped errors carry no SQLSTATE at all → no replay.
        let io_error = sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset by peer",
        ));
        assert!(!commit_definitely_aborted(&io_error));
        assert!(!commit_definitely_aborted(&sqlx::Error::PoolTimedOut));
    }

    /// A dead worker (receiver dropped) must make `insert_event_with_
    /// thread_metadata` return `None` immediately — the ingest caller falls
    /// back to the direct path — never hang the future. No DB involved.
    #[tokio::test]
    async fn dead_worker_returns_none_for_fallback() {
        let (tx, rx) = mpsc::channel(1);
        drop(rx);
        let batcher = EventWriteBatcher {
            tx,
            counters: Arc::new(BatchCounters::default()),
        };
        let event = make_event("orphaned");
        let outcome = batcher
            .insert_event_with_thread_metadata(
                CommunityId::from_uuid(Uuid::new_v4()),
                &event,
                None,
                None,
            )
            .await;
        assert!(outcome.is_none(), "dead batcher must signal fallback");
    }

    /// End-to-end through the public API: 64 concurrent inserts through a
    /// spawned batcher all succeed, all are durable, and the counters show
    /// real coalescing (multi-event commits actually happened).
    ///
    /// ACK-after-commit is asserted at the strongest observable point: the
    /// instant a caller's future resolves `was_inserted`, the row must
    /// already be visible from a *different* connection (the pool). Under
    /// READ COMMITTED another connection can only see committed data, so
    /// visibility here proves the caller was never answered from an
    /// uncommitted transaction.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires Postgres"]
    async fn concurrent_inserts_coalesce_and_all_commit() {
        let db = setup_db().await;
        let community = make_test_community(&db).await;
        let channel = make_test_channel(&db, community).await;
        let batcher = EventWriteBatcher::spawn(db.clone(), DEFAULT_MAX_BATCH);

        let mut tasks = tokio::task::JoinSet::new();
        for i in 0..64 {
            let batcher = batcher.clone();
            let db = db.clone();
            let event = make_event(&format!("concurrent {i}"));
            tasks.spawn(async move {
                let result = batcher
                    .insert_event_with_thread_metadata(community, &event, Some(channel), None)
                    .await
                    .expect("worker alive")
                    .expect("insert ok");
                assert!(result.1, "unique event inserted");
                assert_eq!(
                    count_event_rows(&db, community, &event).await,
                    1,
                    "row must be committed (visible to another connection) \
                     before the caller's future resolves"
                );
                event
            });
        }
        let mut events = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            events.push(joined.expect("task ok"));
        }
        assert_eq!(events.len(), 64);
        for event in &events {
            assert_eq!(count_event_rows(&db, community, event).await, 1);
        }

        let stats = batcher.stats();
        assert_eq!(
            stats.batch_events_committed + stats.single_flushes + stats.fallback_events,
            64,
            "every insert accounted for: {stats:?}"
        );
        assert!(
            stats.batch_commits >= 1,
            "expected at least one multi-event commit under 64-way concurrency: {stats:?}"
        );
        assert_eq!(stats.indeterminate_commits, 0);
    }
}

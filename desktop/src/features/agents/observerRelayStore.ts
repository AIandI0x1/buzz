import * as React from "react";

import { subscribeToAgentObserverFrames } from "@/shared/api/observerRelay";
import type { RelayEvent, ManagedAgent } from "@/shared/api/types";
import type { ControlResultFrame } from "@/shared/api/types";
import { getIdentity, putAgentSessionConfig } from "@/shared/api/tauri";
import { decryptObserverEvent } from "@/shared/api/tauriObserver";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { useQueryClient } from "@tanstack/react-query";
import { agentConfigSurfaceQueryKey } from "@/features/agents/hooks";
import type {
  ConnectionState,
  ObserverEvent,
  TranscriptItem,
} from "./ui/agentSessionTypes";
import {
  type TranscriptState,
  buildTranscriptState,
  createEmptyTranscriptState,
  processTranscriptEvent,
} from "./ui/agentSessionTranscript";

const MAX_OBSERVER_EVENTS = 800;

export type ObserverSnapshot = {
  connectionState: ConnectionState;
  errorMessage: string | null;
  events: ObserverEvent[];
};

const IDLE_SNAPSHOT: ObserverSnapshot = {
  connectionState: "idle",
  errorMessage: null,
  events: [],
};

const EMPTY_TRANSCRIPT: TranscriptItem[] = [];

const listeners = new Set<() => void>();
const eventsByAgent = new Map<string, ObserverEvent[]>();
const transcriptByAgent = new Map<string, TranscriptState>();
const snapshotByAgent = new Map<string, ObserverSnapshot>();

// Per-agent listeners for `control_result` frames. The ModelPicker subscribes
// here to learn the async outcome of a `switch_model` frame (the send is
// fire-and-forget; the harness replies out-of-band over the observer relay).
const controlResultListeners = new Map<
  string,
  Set<(frame: ControlResultFrame) => void>
>();

// Normalized pubkeys of agents we are actively managing. Only events whose
// "agent" tag matches an entry here will be decrypted (defense-in-depth).
//
// This set is the *union* of every active subscriber's contribution. Multiple
// callers of `useManagedAgentObserverBridge` (e.g. the channel screen and the
// profile panel) can be mounted at once, each tracking a different agent list.
// We key each subscriber's contribution in `knownAgentsBySubscription` and
// recompute the union, so co-mounted callers no longer clobber each other.
const knownAgentPubkeys = new Set<string>();
const knownAgentsBySubscription = new Map<string, Set<string>>();

// Callback invoked when session_config_captured is received, so React Query
// can invalidate the config-surface query for the affected agent. Wired up
// by useManagedAgentObserverBridge via setSessionConfigCapturedCallback.
let onSessionConfigCaptured: ((pubkey: string) => void) | null = null;

export function setSessionConfigCapturedCallback(
  cb: ((pubkey: string) => void) | null,
) {
  onSessionConfigCaptured = cb;
}

function recomputeKnownAgentPubkeys() {
  knownAgentPubkeys.clear();
  for (const subscriptionAgents of knownAgentsBySubscription.values()) {
    for (const pubkey of subscriptionAgents) {
      knownAgentPubkeys.add(pubkey);
    }
  }
}

function registerKnownAgents(
  subscriptionId: string,
  pubkeys: readonly string[],
) {
  const normalizedPubkeys = pubkeys.map((pubkey) => normalizePubkey(pubkey));
  knownAgentsBySubscription.set(subscriptionId, new Set(normalizedPubkeys));
  recomputeKnownAgentPubkeys();
  pillDiagLog("registerKnownAgents", {
    subscriptionId,
    subscriptionPubkeys: pillDiagPubkeys(normalizedPubkeys),
  });
}

function unregisterKnownAgents(subscriptionId: string) {
  const removedPubkeys = knownAgentsBySubscription.get(subscriptionId);
  const removed = knownAgentsBySubscription.delete(subscriptionId);
  if (removed) {
    recomputeKnownAgentPubkeys();
  }
  pillDiagLog("unregisterKnownAgents", {
    subscriptionId,
    removed,
    removedPubkeys: removedPubkeys ? pillDiagPubkeys(removedPubkeys) : [],
  });
}

let connectionState: ConnectionState = "idle";
let errorMessage: string | null = null;
let unsubscribeRelay: (() => Promise<void>) | null = null;
let startPromise: Promise<void> | null = null;
let eventProcessingQueue: Promise<void> = Promise.resolve();
let generation = 0;

function pillDiagPubkeys(pubkeys: Iterable<string>) {
  return [...pubkeys].map((pubkey) => normalizePubkey(pubkey)).sort();
}

function pillDiagState(extra: Record<string, unknown> = {}) {
  return {
    generation,
    connectionState,
    hasRelaySubscription: Boolean(unsubscribeRelay),
    hasStartPromise: Boolean(startPromise),
    knownAgentCount: knownAgentPubkeys.size,
    knownAgents: pillDiagPubkeys(knownAgentPubkeys),
    subscriptionCount: knownAgentsBySubscription.size,
    subscriptionSizes: Object.fromEntries(
      [...knownAgentsBySubscription.entries()].map(
        ([subscriptionId, pubkeys]) => [subscriptionId, pubkeys.size],
      ),
    ),
    at: new Date().toISOString(),
    ...extra,
  };
}

function pillDiagLog(label: string, extra: Record<string, unknown> = {}) {
  console.log(`[pill-diag] observer ${label}`, pillDiagState(extra));
}

function pillDiagEvent(event: RelayEvent) {
  const agentPubkey = observerTag(event, "agent");
  return {
    eventId: event.id,
    eventPubkey: normalizePubkey(event.pubkey),
    agentPubkey: agentPubkey ? normalizePubkey(agentPubkey) : null,
    frame: observerTag(event, "frame"),
    createdAt: event.created_at,
  };
}

function pillDiagBridgeAgents(
  agents: readonly Pick<ManagedAgent, "pubkey" | "status">[],
) {
  return agents.map((agent) => ({
    pubkey: normalizePubkey(agent.pubkey),
    status: agent.status,
    startsObserver: agent.status === "running" || agent.status === "deployed",
  }));
}

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

function invalidateSnapshot(key: string) {
  snapshotByAgent.delete(key);
}

function setConnectionState(
  nextState: ConnectionState,
  nextErrorMessage: string | null = errorMessage,
) {
  connectionState = nextState;
  errorMessage = nextErrorMessage;
  snapshotByAgent.clear();
  notifyListeners();
}

function observerTag(event: RelayEvent, tagName: string) {
  return event.tags.find((tag) => tag[0] === tagName)?.[1] ?? null;
}

function appendAgentEvent(agentPubkey: string, event: ObserverEvent) {
  const key = normalizePubkey(agentPubkey);
  const current = eventsByAgent.get(key) ?? [];
  if (
    current.some(
      (existing) =>
        existing.seq === event.seq && existing.timestamp === event.timestamp,
    )
  ) {
    return;
  }

  const sorted = [...current, event].sort(compareObserverEvents);
  const trimmed = sorted.length > MAX_OBSERVER_EVENTS;
  const final = trimmed
    ? sorted.slice(sorted.length - MAX_OBSERVER_EVENTS)
    : sorted;
  eventsByAgent.set(key, final);

  // Determine whether the new event landed at the end of the sorted array.
  // If it did (common case), we can incrementally process just this event.
  // If not (out-of-order arrival) or if we trimmed, fall back to full rebuild.
  const eventAtEnd = sorted[sorted.length - 1] === event;

  if (eventAtEnd && !trimmed) {
    // Fast path: incremental update
    const transcriptState =
      transcriptByAgent.get(key) ?? createEmptyTranscriptState();
    const updatedTranscript = processTranscriptEvent(transcriptState, event);
    transcriptByAgent.set(key, updatedTranscript);
  } else {
    // Slow path: full rebuild (out-of-order insertion or trim fired)
    transcriptByAgent.set(key, buildTranscriptState(final));
  }

  invalidateSnapshot(key);

  notifyListeners();
}

export function compareObserverEvents(
  left: ObserverEvent,
  right: ObserverEvent,
) {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    const timeDiff = leftTime - rightTime;
    if (timeDiff !== 0) {
      return timeDiff;
    }
  }

  return left.seq - right.seq;
}

async function handleRelayObserverEvent(
  event: RelayEvent,
  activeGeneration: number,
) {
  const agentPubkey = observerTag(event, "agent");
  const frame = observerTag(event, "frame");
  if (!agentPubkey || frame !== "telemetry") {
    pillDiagLog("drop nonTelemetryFrame", {
      activeGeneration,
      event: pillDiagEvent(event),
    });
    return;
  }

  // Verify agent is known/trusted before decrypting.
  // Silently drop events from agents we are not managing.
  if (!knownAgentPubkeys.has(normalizePubkey(agentPubkey))) {
    pillDiagLog("drop unknownAgent", {
      activeGeneration,
      event: pillDiagEvent(event),
    });
    return;
  }

  // Defense-in-depth: verify the event sender matches the claimed agent pubkey.
  // The relay gates on is_agent_owner, but a compromised relay could misroute.
  if (normalizePubkey(event.pubkey) !== normalizePubkey(agentPubkey)) {
    pillDiagLog("drop senderMismatch", {
      activeGeneration,
      event: pillDiagEvent(event),
    });
    return;
  }

  try {
    const parsed = (await decryptObserverEvent(event)) as ObserverEvent;
    if (activeGeneration !== generation) {
      pillDiagLog("drop staleGenerationAfterDecrypt", {
        activeGeneration,
        event: pillDiagEvent(event),
        parsedKind: parsed.kind,
        parsedSeq: parsed.seq,
        parsedTimestamp: parsed.timestamp,
      });
      return;
    }
    pillDiagLog("appendFrame", {
      activeGeneration,
      event: pillDiagEvent(event),
      parsedKind: parsed.kind,
      parsedSeq: parsed.seq,
      parsedTimestamp: parsed.timestamp,
    });
    appendAgentEvent(agentPubkey, parsed);
    if (parsed.kind === "session_config_captured") {
      void putAgentSessionConfig(agentPubkey, parsed.payload);
      onSessionConfigCaptured?.(agentPubkey);
    } else if (parsed.kind === "control_result") {
      dispatchControlResult(agentPubkey, parsed.payload);
    }
  } catch (error) {
    if (activeGeneration !== generation) {
      pillDiagLog("drop staleGenerationAfterError", {
        activeGeneration,
        event: pillDiagEvent(event),
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    pillDiagLog("decryptError", {
      activeGeneration,
      event: pillDiagEvent(event),
      error: error instanceof Error ? error.message : String(error),
    });
    setConnectionState(
      "error",
      error instanceof Error
        ? `Observer event decrypt failed: ${error.message}`
        : "Observer event decrypt failed.",
    );
  }
}

export function ensureRelayObserverSubscription() {
  if (unsubscribeRelay) {
    pillDiagLog("ensure reuseOpenSubscription");
    return Promise.resolve();
  }
  if (startPromise) {
    pillDiagLog("ensure reuseStartPromise");
    return startPromise;
  }

  const activeGeneration = generation;
  pillDiagLog("ensure start", { activeGeneration });
  setConnectionState("connecting", null);
  startPromise = (async () => {
    const identity = await getIdentity();
    pillDiagLog("subscribeToAgentObserverFrames start", {
      activeGeneration,
      identityPubkey: normalizePubkey(identity.pubkey),
    });
    const unsubscribe = await subscribeToAgentObserverFrames(
      identity.pubkey,
      (event) => {
        pillDiagLog("frame received", {
          activeGeneration,
          event: pillDiagEvent(event),
        });
        eventProcessingQueue = eventProcessingQueue
          .then(() => handleRelayObserverEvent(event, activeGeneration))
          .catch((error) => {
            if (activeGeneration !== generation) {
              pillDiagLog("drop staleGenerationInQueueCatch", {
                activeGeneration,
                error: error instanceof Error ? error.message : String(error),
              });
              return;
            }
            pillDiagLog("eventHandlingError", {
              activeGeneration,
              error: error instanceof Error ? error.message : String(error),
            });
            setConnectionState(
              "error",
              error instanceof Error
                ? `Observer event handling failed: ${error.message}`
                : "Observer event handling failed.",
            );
          });
      },
    );
    if (activeGeneration !== generation) {
      pillDiagLog("subscribe resolved staleGeneration", { activeGeneration });
      await unsubscribe();
      return;
    }
    unsubscribeRelay = unsubscribe;
    pillDiagLog("subscribe open", { activeGeneration });
    setConnectionState("open", null);
  })()
    .catch((error) => {
      pillDiagLog("subscribe error", {
        activeGeneration,
        error: error instanceof Error ? error.message : String(error),
      });
      if (activeGeneration === generation) {
        setConnectionState(
          "error",
          error instanceof Error
            ? error.message
            : "Observer relay subscription failed.",
        );
      }
    })
    .finally(() => {
      pillDiagLog("ensure finally", { activeGeneration });
      if (activeGeneration === generation) {
        startPromise = null;
      }
    });

  return startPromise;
}

export function subscribeAgentObserverStore(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isControlResultFrame(payload: unknown): payload is ControlResultFrame {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { type?: unknown }).type === "string" &&
    typeof (payload as { status?: unknown }).status === "string"
  );
}

function dispatchControlResult(agentPubkey: string, payload: unknown) {
  if (!isControlResultFrame(payload)) {
    return;
  }
  const subscribers = controlResultListeners.get(normalizePubkey(agentPubkey));
  if (!subscribers) {
    return;
  }
  for (const subscriber of subscribers) {
    subscriber(payload);
  }
}

/**
 * Subscribe to `control_result` frames for a single agent. Returns an
 * unsubscribe function. Used by the ModelPicker to learn the async outcome of
 * a `switch_model` frame.
 */
export function subscribeControlResults(
  agentPubkey: string,
  listener: (frame: ControlResultFrame) => void,
) {
  const key = normalizePubkey(agentPubkey);
  const subscribers = controlResultListeners.get(key) ?? new Set();
  subscribers.add(listener);
  controlResultListeners.set(key, subscribers);
  return () => {
    const current = controlResultListeners.get(key);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      controlResultListeners.delete(key);
    }
  };
}

export function getAgentObserverSnapshot(
  agentPubkey?: string | null,
  enabled?: boolean,
): ObserverSnapshot {
  if (!enabled || !agentPubkey) {
    return IDLE_SNAPSHOT;
  }
  const key = normalizePubkey(agentPubkey);
  const cached = snapshotByAgent.get(key);
  if (
    cached &&
    cached.connectionState === connectionState &&
    cached.errorMessage === errorMessage
  ) {
    return cached;
  }
  const snapshot: ObserverSnapshot = {
    connectionState,
    errorMessage,
    events: eventsByAgent.get(key) ?? [],
  };
  snapshotByAgent.set(key, snapshot);
  return snapshot;
}

export function getAgentTranscript(
  agentPubkey?: string | null,
  enabled?: boolean,
): TranscriptItem[] {
  if (!enabled || !agentPubkey) {
    return EMPTY_TRANSCRIPT;
  }
  const key = normalizePubkey(agentPubkey);
  const state = transcriptByAgent.get(key);
  return state?.items ?? EMPTY_TRANSCRIPT;
}

export function useManagedAgentObserverBridge(
  agents: readonly Pick<ManagedAgent, "pubkey" | "status">[],
) {
  const subscriptionId = React.useId();
  const hasActiveAgent = React.useMemo(
    () =>
      agents.some(
        (agent) => agent.status === "running" || agent.status === "deployed",
      ),
    [agents],
  );

  pillDiagLog("bridge render", {
    subscriptionId,
    hasActiveAgent,
    agents: pillDiagBridgeAgents(agents),
  });

  const agentPubkeys = React.useMemo(
    () => agents.map((agent) => agent.pubkey),
    [agents],
  );

  // Keep this subscriber's slice of the trusted-pubkey set in sync with its
  // own agent list. The store recomputes the union across all subscribers, so
  // a co-mounted caller no longer wipes out this caller's agents.
  React.useEffect(() => {
    registerKnownAgents(subscriptionId, agentPubkeys);
    return () => {
      unregisterKnownAgents(subscriptionId);
    };
  }, [subscriptionId, agentPubkeys]);

  React.useEffect(() => {
    pillDiagLog("bridge activeEffect", { hasActiveAgent });
    if (!hasActiveAgent) {
      return;
    }
    void ensureRelayObserverSubscription();
  }, [hasActiveAgent]);

  // Wire up config-surface query invalidation when session_config_captured fires.
  const queryClient = useQueryClient();
  React.useEffect(() => {
    setSessionConfigCapturedCallback((pubkey) => {
      void queryClient.invalidateQueries({
        queryKey: agentConfigSurfaceQueryKey(pubkey),
      });
    });
    return () => setSessionConfigCapturedCallback(null);
  }, [queryClient]);
}

export function resetAgentObserverStore() {
  pillDiagLog("reset start", { nextGeneration: generation + 1 });
  generation += 1;
  const unsubscribe = unsubscribeRelay;
  unsubscribeRelay = null;
  startPromise = null;
  eventProcessingQueue = Promise.resolve();
  eventsByAgent.clear();
  transcriptByAgent.clear();
  snapshotByAgent.clear();
  knownAgentPubkeys.clear();
  knownAgentsBySubscription.clear();
  onSessionConfigCaptured = null;
  connectionState = "idle";
  errorMessage = null;
  notifyListeners();
  pillDiagLog("reset afterClear", { hadUnsubscribe: Boolean(unsubscribe) });
  void unsubscribe?.();
}

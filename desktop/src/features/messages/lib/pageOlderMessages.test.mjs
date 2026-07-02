import assert from "node:assert/strict";
import test from "node:test";

import { pageOlderMessagesUntilRowFloor } from "./pageOlderMessages.ts";
import {
  channelMessagesKey,
  mergeNonContiguousTimelineMessages,
  mergeTimelineHistoryMessages,
  oldestContiguousHistoryTimestamp,
  sortMessages,
} from "./messageQueryKeys.ts";
import { relayClient } from "@/shared/api/relayClient";

const PUBKEY = "a".repeat(64);

function event({ id, kind = 9, createdAt, channelId, tags }) {
  return {
    id,
    pubkey: PUBKEY,
    created_at: createdAt,
    kind,
    tags: tags ?? [["h", channelId]],
    content: "",
    sig: "mocksig".repeat(20).slice(0, 128),
  };
}

function id(prefix, index) {
  return `${prefix}${String(index).padStart(64 - prefix.length, "0")}`;
}

function makeQueryClientStub(queryKey, initialEvents) {
  const store = new Map([[JSON.stringify(queryKey), initialEvents]]);
  return {
    getQueryData(key) {
      return store.get(JSON.stringify(key));
    },
    setQueryData(key, updater) {
      const k = JSON.stringify(key);
      const next =
        typeof updater === "function" ? updater(store.get(k) ?? []) : updater;
      store.set(k, next);
      return next;
    },
  };
}

/**
 * Relay double: serves WS-style `until` pages over a fixed ascending dataset,
 * newest `limit` events strictly older than `before`.
 */
function serveHistoryFrom(dataset) {
  return async (_channelId, before, limit) =>
    dataset.filter((e) => e.created_at < before).slice(-limit);
}

test("ancestor island does not poison the older-history cursor (June 14 → June 9 skip)", async (t) => {
  const channelId = "island-cursor-regression";
  // Relay holds a contiguous channel history: 400 events spanning the "gap
  // days" (t=5000..5399), then the newest window (t=10000..10059).
  const gapDays = [];
  for (let index = 0; index < 400; index += 1) {
    gapDays.push(
      event({ id: id("gap", index), createdAt: 5_000 + index, channelId }),
    );
  }
  const newestWindow = [];
  for (let index = 0; index < 60; index += 1) {
    newestWindow.push(
      event({ id: id("new", index), createdAt: 10_000 + index, channelId }),
    );
  }
  const islandRoot = event({ id: id("old", 0), createdAt: 1_000, channelId });
  const relayDataset = sortMessages([...gapDays, ...newestWindow, islandRoot]);

  // Cache shape at the moment of the bug: contiguous newest window plus one
  // much older thread root injected out-of-band by useLoadMissingAncestors.
  const cache = mergeNonContiguousTimelineMessages(newestWindow, [islandRoot]);
  const queryKey = channelMessagesKey(channelId);
  const queryClient = makeQueryClientStub(queryKey, cache);

  const originalFetch = relayClient.fetchChannelHistoryBefore;
  relayClient.fetchChannelHistoryBefore = serveHistoryFrom(relayDataset);
  t.after(() => {
    relayClient.fetchChannelHistoryBefore = originalFetch;
  });

  await pageOlderMessagesUntilRowFloor(queryClient, channelId, () => true);

  const merged = queryClient.getQueryData(queryKey);
  const gapLoaded = merged.filter((e) => e.id.startsWith("gap")).length;
  // The pager must page from the contiguous frontier (t=10000) into the gap
  // days — not from the island (t=1000), which skips them forever.
  assert.ok(
    gapLoaded > 0,
    "pager anchored on the out-of-band island and skipped the gap days",
  );
});

test("contiguous paging heals the island: re-fetched copy loses the mark and anchors later passes", async (t) => {
  const channelId = "island-heal-regression";
  const older = [];
  for (let index = 0; index < 10; index += 1) {
    older.push(
      event({ id: id("old", index), createdAt: 1_000 + index, channelId }),
    );
  }
  const newestWindow = [];
  for (let index = 0; index < 60; index += 1) {
    newestWindow.push(
      event({ id: id("new", index), createdAt: 10_000 + index, channelId }),
    );
  }
  const relayDataset = sortMessages([...older, ...newestWindow]);

  // older[5] was injected out-of-band; the rest of `older` is unloaded.
  const cache = mergeNonContiguousTimelineMessages(newestWindow, [older[5]]);
  const queryKey = channelMessagesKey(channelId);
  const queryClient = makeQueryClientStub(queryKey, cache);

  const originalFetch = relayClient.fetchChannelHistoryBefore;
  relayClient.fetchChannelHistoryBefore = serveHistoryFrom(relayDataset);
  t.after(() => {
    relayClient.fetchChannelHistoryBefore = originalFetch;
  });

  await pageOlderMessagesUntilRowFloor(queryClient, channelId, () => true);

  const merged = queryClient.getQueryData(queryKey);
  assert.equal(merged.filter((e) => e.id.startsWith("old")).length, 10);
  const healed = merged.find((e) => e.id === older[5].id);
  assert.ok(
    !healed.nonContiguous,
    "contiguous re-fetch must clear the nonContiguous mark (last-copy-wins)",
  );
  // With the island healed, the frontier is now the true oldest event.
  assert.equal(oldestContiguousHistoryTimestamp(merged), 1_000);
});

test("frontier falls back to the oldest cached event when nothing is contiguous", async () => {
  const events = [
    {
      ...event({ id: id("iso", 0), createdAt: 500, channelId: "x" }),
      nonContiguous: true,
    },
  ];
  assert.equal(oldestContiguousHistoryTimestamp(events), null);
  // mergeTimelineHistoryMessages keeps the incoming (unflagged) copy on collision.
  const healed = mergeTimelineHistoryMessages(events, [
    event({ id: id("iso", 0), createdAt: 500, channelId: "x" }),
  ]);
  assert.equal(oldestContiguousHistoryTimestamp(healed), 500);
});

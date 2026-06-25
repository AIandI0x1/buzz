import assert from "node:assert/strict";
import test from "node:test";

import { summarizeProjectActivityEvents } from "./projectActivity.mjs";

const OWNER = "a".repeat(64);
const AGENT = "b".repeat(64);
const REVIEWER = "c".repeat(64);
const OTHER = "d".repeat(64);
const REPO_ADDRESS = `30617:${OWNER}:demo`;

function event(overrides = {}) {
  return {
    id: overrides.id ?? "event-id",
    pubkey: overrides.pubkey ?? AGENT,
    created_at: overrides.created_at ?? 100,
    kind: overrides.kind ?? 1621,
    content: overrides.content ?? "",
    sig: "",
    tags: overrides.tags ?? [["a", REPO_ADDRESS]],
  };
}

test("summarizes project activity participants by repo address", () => {
  const summary = summarizeProjectActivityEvents(
    [
      event({
        id: "issue",
        kind: 1621,
        pubkey: AGENT,
        created_at: 100,
        tags: [
          ["a", REPO_ADDRESS],
          ["p", REVIEWER],
        ],
      }),
      event({
        id: "status",
        kind: 1630,
        pubkey: REVIEWER,
        created_at: 200,
        tags: [["a", REPO_ADDRESS]],
      }),
      event({
        id: "other-repo",
        kind: 1621,
        pubkey: OTHER,
        created_at: 300,
        tags: [["a", `30617:${OWNER}:other`]],
      }),
    ],
    [{ repoAddress: REPO_ADDRESS }],
  );

  assert.equal(summary[REPO_ADDRESS].issueCount, 1);
  assert.equal(summary[REPO_ADDRESS].activityCount, 2);
  assert.equal(summary[REPO_ADDRESS].updatedAt, 200);
  assert.deepEqual(summary[REPO_ADDRESS].participantPubkeys, [AGENT, REVIEWER]);
});

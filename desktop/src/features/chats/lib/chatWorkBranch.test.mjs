import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveChatWorkBranch,
  parseBranchFromCommand,
} from "./chatWorkBranch.ts";

function toolItem(command, overrides = {}) {
  return {
    id: overrides.id ?? command,
    type: "tool",
    renderClass: "generic",
    descriptor: { category: "shell" },
    title: "Ran command",
    toolName: "shell",
    buzzToolName: null,
    status: "completed",
    args: { command },
    result: "",
    isError: false,
    timestamp: "2026-07-04T00:00:00Z",
    startedAt: "2026-07-04T00:00:00Z",
    completedAt: null,
    channelId: overrides.channelId ?? "chat-1",
    turnId: overrides.turnId ?? "turn-1",
  };
}

test("worktree add with -b names the new branch", () => {
  assert.equal(
    parseBranchFromCommand("git worktree add ../wt/feature -b feature-x"),
    "feature-x",
  );
});

test("worktree add with existing branch uses the second positional", () => {
  assert.equal(
    parseBranchFromCommand("git worktree add ../wt/fix fix-panel"),
    "fix-panel",
  );
});

test("worktree add with only a path uses the basename", () => {
  assert.equal(
    parseBranchFromCommand("git worktree add /tmp/worktrees/chat-panel"),
    "chat-panel",
  );
});

test("checkout -b and switch -c name the branch", () => {
  assert.equal(
    parseBranchFromCommand("git checkout -b kenny/new-panel"),
    "kenny/new-panel",
  );
  assert.equal(parseBranchFromCommand("git switch -c wip"), "wip");
});

test("plain switch to an existing branch counts", () => {
  assert.equal(parseBranchFromCommand("git switch main"), "main");
});

test("compound commands take the last branch operation", () => {
  assert.equal(
    parseBranchFromCommand(
      "cd /repo && git fetch origin && git worktree add ../wt -b first && git -C ../wt checkout -b second",
    ),
    "second",
  );
});

test("file checkouts, detached heads, and non-git commands are ignored", () => {
  assert.equal(parseBranchFromCommand("git checkout -- src/app.ts"), null);
  assert.equal(parseBranchFromCommand("git checkout src/a.ts src/b.ts"), null);
  assert.equal(parseBranchFromCommand("git checkout deadbeefcafe"), null);
  assert.equal(parseBranchFromCommand("cargo build --release"), null);
  assert.equal(parseBranchFromCommand("echo git checkout"), null);
});

test("deriveChatWorkBranch returns the latest branch across the transcript", () => {
  const transcript = [
    toolItem("ls -la", { id: "1" }),
    toolItem("git worktree add ../wt -b first-branch", { id: "2" }),
    { id: "3", type: "lifecycle", renderClass: "status" },
    toolItem("git checkout -b second-branch", { id: "4" }),
    toolItem("cargo test", { id: "5" }),
  ];
  assert.equal(deriveChatWorkBranch(transcript), "second-branch");
});

test("deriveChatWorkBranch is null without branch activity", () => {
  assert.equal(deriveChatWorkBranch([toolItem("pnpm test")]), null);
});

import type { TranscriptItem } from "@/features/agents/ui/agentSessionTypes";
import { getToolString } from "@/features/agents/ui/agentSessionUtils";

/**
 * Derive the branch the chat's agent is currently working on from its shell
 * activity: the latest `git worktree add` / `git checkout` / `git switch`
 * that names a branch wins. This is what lets the work panel show a branch
 * as soon as the agent sets up a worktree — before any PR exists to report
 * `head.ref`.
 */
export function deriveChatWorkBranch(
  transcript: readonly TranscriptItem[],
): string | null {
  let branch: string | null = null;
  for (const item of transcript) {
    if (item.type !== "tool") {
      continue;
    }
    const command = getToolString(item.args, ["command"]);
    if (!command) {
      continue;
    }
    const parsed = parseBranchFromCommand(command);
    if (parsed) {
      branch = parsed;
    }
  }
  return branch;
}

/** Latest branch named by any segment of a (possibly compound) command. */
export function parseBranchFromCommand(command: string): string | null {
  let branch: string | null = null;
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const parsed = parseBranchFromSegment(segment.trim());
    if (parsed) {
      branch = parsed;
    }
  }
  return branch;
}

function parseBranchFromSegment(segment: string): string | null {
  const tokens = tokenize(segment);
  const gitIndex = tokens.indexOf("git");
  if (gitIndex === -1) {
    return null;
  }
  // Skip `git -C <path> …` style global flags between `git` and the verb.
  let verbIndex = gitIndex + 1;
  while (verbIndex < tokens.length && tokens[verbIndex].startsWith("-")) {
    verbIndex += tokens[verbIndex] === "-C" ? 2 : 1;
  }
  const verb = tokens[verbIndex];
  const rest = tokens.slice(verbIndex + 1);

  if (verb === "worktree" && rest[0] === "add") {
    return parseWorktreeAdd(rest.slice(1));
  }
  if (verb === "checkout" || verb === "switch") {
    return parseCheckoutOrSwitch(rest);
  }
  return null;
}

function parseWorktreeAdd(args: string[]): string | null {
  const flagged = valueOfFlag(args, ["-b", "-B"]);
  if (flagged) {
    return flagged;
  }
  const positional = args.filter((token) => !token.startsWith("-"));
  if (positional.length >= 2) {
    // `git worktree add <path> <branch>` — a commit-ish second arg (sha)
    // isn't a branch name worth showing.
    return looksLikeSha(positional[1]) ? null : positional[1];
  }
  if (positional.length === 1) {
    // `git worktree add <path>` creates a branch named after the basename.
    const parts = positional[0].split("/").filter(Boolean);
    return parts[parts.length - 1] || null;
  }
  return null;
}

function parseCheckoutOrSwitch(args: string[]): string | null {
  const flagged = valueOfFlag(args, ["-b", "-B", "-c", "-C"]);
  if (flagged) {
    return flagged;
  }
  // Plain `git checkout <branch>` / `git switch <branch>`: only a single
  // non-flag argument reads as a branch move — more args means file paths,
  // and `--` restores files, and a bare sha is a detached head.
  if (args.includes("--")) {
    return null;
  }
  const positional = args.filter((token) => !token.startsWith("-"));
  if (positional.length !== 1 || looksLikeSha(positional[0])) {
    return null;
  }
  return positional[0];
}

function valueOfFlag(args: string[], flags: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (flags.includes(args[index])) {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        return value;
      }
    }
  }
  return null;
}

function looksLikeSha(token: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(token);
}

function tokenize(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .filter((token) => token.length > 0);
}

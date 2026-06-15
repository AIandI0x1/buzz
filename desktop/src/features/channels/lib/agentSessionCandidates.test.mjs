import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChannelAgentSessionCandidates,
  getChannelAgentSessionAgents,
} from "./agentSessionCandidates.ts";

const CHANNEL = {
  id: "channel-1",
  name: "general",
  channelType: "stream",
  visibility: "private",
  description: "",
  topic: null,
  purpose: null,
  memberCount: 0,
  memberPubkeys: [],
  lastMessageAt: null,
  archivedAt: null,
  participants: [],
  participantPubkeys: [],
  isMember: true,
  ttlSeconds: null,
  ttlDeadline: null,
};

function member(overrides) {
  return {
    pubkey: "aa".repeat(32),
    role: "member",
    isAgent: false,
    joinedAt: "2024-01-01T00:00:00Z",
    displayName: "Agent",
    ...overrides,
  };
}

test("buildChannelAgentSessionCandidates includes members marked isAgent", () => {
  const candidates = buildChannelAgentSessionCandidates({
    channelMembers: [
      member({
        pubkey: "11".repeat(32),
        role: "member",
        isAgent: true,
        displayName: "Ned",
      }),
    ],
    managedAgents: [],
    relayAgents: [],
  });

  assert.deepEqual(
    candidates.map((agent) => ({
      name: agent.name,
      pubkey: agent.pubkey,
      source: agent.agentSource,
    })),
    [{ name: "Ned", pubkey: "11".repeat(32), source: "member-bot" }],
  );
});

test("getChannelAgentSessionAgents keeps isAgent member candidates in channel scope", () => {
  const channelMembers = [
    member({
      pubkey: "22".repeat(32),
      role: "member",
      isAgent: true,
      displayName: "Ned",
    }),
  ];
  const candidates = buildChannelAgentSessionCandidates({
    channelMembers,
    managedAgents: [],
    relayAgents: [],
  });

  const scoped = getChannelAgentSessionAgents({
    activeChannel: CHANNEL,
    activeChannelId: CHANNEL.id,
    agents: candidates,
    channelMembers,
  });

  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].pubkey, "22".repeat(32));
});

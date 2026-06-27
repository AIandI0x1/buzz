import * as React from "react";

import type {
  AgentConversationMarker,
  OpenAgentConversationInput,
} from "@/features/agents/agentConversations";
import type { TimelineMessage } from "@/features/messages/types";
import type { Channel } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

type GoChannel = (
  channelId: string,
  options?: {
    messageId?: string;
    replace?: boolean;
    taskReplyId?: string;
    threadRootId?: string | null;
  },
) => Promise<boolean>;

type UseAgentConversationRouteTargetInput = {
  activeChannel: Channel | null;
  agentConversationMarkers: readonly AgentConversationMarker[];
  agentPubkeys: ReadonlySet<string>;
  enabled: boolean;
  goChannel: GoChannel;
  messageProfilesReady: boolean;
  openAgentConversation: (
    input: OpenAgentConversationInput,
    options?: { publishMarker?: boolean },
  ) => void;
  targetAgentConversationReplyId: string | null;
  timelineMessages: readonly TimelineMessage[];
};

export function useAgentConversationRouteTarget({
  activeChannel,
  agentConversationMarkers,
  agentPubkeys,
  enabled,
  goChannel,
  messageProfilesReady,
  openAgentConversation,
  targetAgentConversationReplyId,
  timelineMessages,
}: UseAgentConversationRouteTargetInput) {
  const handledRouteTargetRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!enabled || !targetAgentConversationReplyId) {
      handledRouteTargetRef.current = null;
      return;
    }

    const targetKey = `${activeChannel?.id ?? "none"}:${targetAgentConversationReplyId}`;
    if (handledRouteTargetRef.current === targetKey) {
      return;
    }
    if (!activeChannel || activeChannel.channelType === "forum") {
      return;
    }
    if (!messageProfilesReady) {
      return;
    }

    const marker =
      agentConversationMarkers.find(
        (candidate) =>
          candidate.channelId === activeChannel.id &&
          candidate.agentReplyId === targetAgentConversationReplyId,
      ) ?? null;
    const sourceMessage =
      timelineMessages.find(
        (message) => message.id === targetAgentConversationReplyId,
      ) ?? null;
    if (!sourceMessage) {
      return;
    }

    const sourceAuthorIsAgent = sourceMessage.pubkey
      ? agentPubkeys.has(normalizePubkey(sourceMessage.pubkey))
      : false;
    const taskAgentPubkey =
      marker?.agentPubkey ||
      (sourceAuthorIsAgent ? (sourceMessage.pubkey ?? "") : "");
    const taskAgentName =
      marker?.agentName || (taskAgentPubkey ? sourceMessage.author : "");
    const rootId =
      sourceMessage.rootId ?? sourceMessage.parentId ?? sourceMessage.id;
    const contextMessages = timelineMessages.filter(
      (candidate) =>
        candidate.id === rootId ||
        candidate.id === sourceMessage.id ||
        candidate.rootId === rootId ||
        candidate.parentId === rootId,
    );
    const parentMessage = sourceMessage.parentId
      ? (timelineMessages.find(
          (candidate) => candidate.id === sourceMessage.parentId,
        ) ?? null)
      : null;
    const threadRootMessage =
      timelineMessages.find((candidate) => candidate.id === rootId) ?? null;

    handledRouteTargetRef.current = targetKey;
    void goChannel(activeChannel.id, { replace: true }).then(() => {
      openAgentConversation(
        {
          agentName: taskAgentName,
          agentPubkey: taskAgentPubkey,
          agentReply: sourceMessage,
          channel: activeChannel,
          contextMessages,
          parentMessage,
          threadRootMessage,
        },
        { publishMarker: false },
      );
    });
  }, [
    activeChannel,
    agentConversationMarkers,
    agentPubkeys,
    enabled,
    goChannel,
    messageProfilesReady,
    openAgentConversation,
    targetAgentConversationReplyId,
    timelineMessages,
  ]);
}

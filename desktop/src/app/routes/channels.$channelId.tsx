import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  parseProfilePanelView,
  type ProfilePanelView,
} from "@/features/profile/ui/UserProfilePanelUtils";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

type ChannelRouteSearch = {
  agentSession?: string;
  messageId?: string;
  profile?: string;
  profileView?: Exclude<ProfilePanelView, "summary">;
  thread?: string;
  threadRootId?: string;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function profileViewValue(
  value: unknown,
): Exclude<ProfilePanelView, "summary"> | undefined {
  const view = parseProfilePanelView(value);
  return view && view !== "summary" ? view : undefined;
}

function validateChannelSearch(
  search: Record<string, unknown>,
): ChannelRouteSearch {
  return {
    agentSession: nonEmptyString(search.agentSession),
    messageId: nonEmptyString(search.messageId),
    profile: nonEmptyString(search.profile),
    profileView: profileViewValue(search.profileView),
    thread: nonEmptyString(search.thread),
    threadRootId: nonEmptyString(search.threadRootId),
  };
}

export const Route = createFileRoute("/channels/$channelId")({
  validateSearch: validateChannelSearch,
  component: ChannelRouteComponent,
});

const ChannelRouteScreen = React.lazy(async () => {
  const module = await import("./ChannelRouteScreen");
  return { default: module.ChannelRouteScreen };
});

function ChannelRouteComponent() {
  const { channelId } = Route.useParams();
  const search = Route.useSearch();

  return (
    <React.Suspense
      fallback={<ViewLoadingFallback includeHeader kind="channel" />}
    >
      <ChannelRouteScreen
        channelId={channelId}
        selectedPostId={null}
        targetMessageId={search.messageId ?? null}
        targetReplyId={null}
        targetThreadRootId={search.threadRootId ?? search.thread ?? null}
      />
    </React.Suspense>
  );
}

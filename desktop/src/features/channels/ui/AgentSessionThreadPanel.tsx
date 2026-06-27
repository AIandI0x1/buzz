import * as React from "react";
import { Octagon, Settings, TerminalSquare } from "lucide-react";
import { toast } from "sonner";

import { ManagedAgentSessionPanel } from "@/features/agents/ui/ManagedAgentSessionPanel";
import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import { cancelManagedAgentTurn } from "@/shared/api/agentControl";
import type { Channel } from "@/shared/api/types";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import { useIsThreadPanelOverlay } from "@/shared/hooks/use-mobile";
import { useStickToBottom } from "@/shared/hooks/useStickToBottom";
import { cn } from "@/shared/lib/cn";
import {
  AuxiliaryPanelHeader,
  AuxiliaryPanelHeaderActions,
  AuxiliaryPanelHeaderCloseButton,
  AuxiliaryPanelHeaderGroup,
  AuxiliaryPanelTitle,
  auxiliaryPanelFloatingHeaderBackdropClass,
  auxiliaryPanelFloatingHeaderBaseClass,
  auxiliaryPanelFloatingHeaderClass,
  auxiliaryPanelFloatingHeaderSingleColumnClass,
  auxiliaryPanelHeaderBodyOffsetClass,
  auxiliaryPanelContentPaddingClass,
} from "@/shared/layout/AuxiliaryPanelHeader";
import { Button } from "@/shared/ui/button";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import {
  OverlayPanelBackdrop,
  PANEL_ENTER_BASE_CLASS,
  PANEL_OVERLAY_CLASS,
  PANEL_SINGLE_COLUMN_HEADER_LAYER_CLASS,
} from "@/shared/ui/OverlayPanelBackdrop";
import { THREAD_PANEL_MIN_WIDTH_PX } from "@/shared/hooks/useThreadPanelWidth";
import { Switch } from "@/shared/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import type { ChannelAgentSessionAgent } from "./useChannelAgentSessions";

type AgentSessionThreadPanelProps = {
  agent: ChannelAgentSessionAgent;
  channel: Channel | null;
  canInterruptTurn: boolean;
  isWorking: boolean;
  layout?: "standalone" | "split";
  isSinglePanelView?: boolean;
  profiles?: UserProfileLookup;
  onBackToProfile: () => void;
  onClose: () => void;
  widthPx: number;
};

export function AgentSessionThreadPanel({
  agent,
  canInterruptTurn,
  channel,
  isWorking,
  layout = "standalone",
  isSinglePanelView = false,
  profiles,
  onBackToProfile,
  onClose,
  widthPx,
}: AgentSessionThreadPanelProps) {
  const isLive = isManagedAgentActive(agent);
  const isOverlay = useIsThreadPanelOverlay();
  const isFloatingOverlay = isOverlay && !isSinglePanelView;
  const isSplitLayout = layout === "split";
  useEscapeKey(onClose, isOverlay || isSinglePanelView);

  const { ref: scrollRef, onScroll } = useStickToBottom<HTMLDivElement>();
  const rawFeedScopeKey = `${agent.pubkey}:${channel?.id ?? "all"}`;
  const rawFeedSwitchId = React.useId();
  const [rawFeedState, setRawFeedState] = React.useState(() => ({
    scopeKey: rawFeedScopeKey,
    show: false,
  }));
  const showRawFeed =
    rawFeedState.scopeKey === rawFeedScopeKey && rawFeedState.show;
  const handleRawFeedChange = React.useCallback(
    (checked: boolean) => {
      setRawFeedState({ scopeKey: rawFeedScopeKey, show: checked });
    },
    [rawFeedScopeKey],
  );
  const canStopCurrentTurn = isWorking && canInterruptTurn;

  async function handleInterruptTurn() {
    if (!channel) {
      return;
    }

    try {
      await cancelManagedAgentTurn(agent.pubkey, channel.id);
      toast.success(
        `Stop signal sent to ${agent.name}. It may take a moment to respond.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Failed to stop ${agent.name}'s current turn.`,
      );
    }
  }

  const agentHeaderActions = (
    <AuxiliaryPanelHeaderActions>
      {isLive ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Open activity settings"
              className="relative"
              data-testid="agent-session-settings-menu-trigger"
              size="icon"
              title="Activity settings"
              type="button"
              variant="ghost"
            >
              <Settings />
              {canStopCurrentTurn ? (
                <span
                  aria-hidden="true"
                  className="absolute bottom-1 right-1 h-2 w-2 rounded-full bg-primary ring-2 ring-background"
                  data-testid="agent-session-settings-live-badge"
                />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-56"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuItem
              className="gap-3 pr-2"
              onSelect={(event) => {
                event.preventDefault();
                handleRawFeedChange(!showRawFeed);
              }}
              title={
                showRawFeed
                  ? "Hide raw JSON-RPC payloads."
                  : channel
                    ? "Show raw JSON-RPC payloads for this channel."
                    : "Show raw JSON-RPC payloads for this agent."
              }
            >
              <TerminalSquare className="h-4 w-4 text-muted-foreground" />
              <label
                className="min-w-0 flex-1 text-sm font-medium"
                htmlFor={rawFeedSwitchId}
              >
                Raw activity
              </label>
              <Switch
                aria-label={showRawFeed ? "Hide raw feed" : "Show raw feed"}
                checked={showRawFeed}
                className="shrink-0 data-[state=unchecked]:bg-muted-foreground/45 [&>span]:bg-white"
                data-testid="agent-session-toggle-raw-feed"
                id={rawFeedSwitchId}
                onCheckedChange={handleRawFeedChange}
                onClick={(event) => event.stopPropagation()}
              />
            </DropdownMenuItem>
            {isWorking ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="items-start gap-3"
                  data-testid="agent-session-stop-turn"
                  disabled={!canStopCurrentTurn}
                  onSelect={() => {
                    void handleInterruptTurn();
                  }}
                  title={
                    canStopCurrentTurn
                      ? "Interrupt the current ACP turn without stopping the agent process."
                      : "Only locally managed agents can be interrupted from this workspace."
                  }
                >
                  <Octagon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      Stop current turn
                    </span>
                    {!canStopCurrentTurn ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Only available for locally managed agents.
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <AuxiliaryPanelHeaderCloseButton
        ariaLabel="Close activity panel"
        onClose={onClose}
        testId="agent-session-close"
      />
    </AuxiliaryPanelHeaderActions>
  );

  const agentHeaderContent = (
    <>
      <AuxiliaryPanelHeaderGroup
        backButtonAriaLabel="Back from activity"
        backButtonTestId="agent-session-back"
        onBack={onBackToProfile}
      >
        <AuxiliaryPanelTitle>
          {showRawFeed ? "Raw ACP Activity" : "Activity"}
        </AuxiliaryPanelTitle>
      </AuxiliaryPanelHeaderGroup>
      {agentHeaderActions}
    </>
  );

  const agentBody = (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-3 pb-4",
        isSplitLayout && auxiliaryPanelContentPaddingClass,
        !isSplitLayout &&
          (isFloatingOverlay ? "pt-4" : auxiliaryPanelHeaderBodyOffsetClass),
      )}
    >
      <ManagedAgentSessionPanel
        agent={agent}
        channelId={channel?.id ?? null}
        className="border-0 bg-transparent p-0 shadow-none"
        emptyDescription={
          channel
            ? `Mention ${agent.name} in the channel to see its work here.`
            : `Mention ${agent.name} in any channel to see its work here.`
        }
        isWorking={isWorking}
        profiles={profiles}
        rawLayout="exclusive"
        showHeader={false}
        showRaw={showRawFeed}
      />
    </div>
  );

  if (isSplitLayout) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <AuxiliaryPanelHeader>{agentHeaderContent}</AuxiliaryPanelHeader>
        {agentBody}
      </div>
    );
  }

  return (
    <>
      {isFloatingOverlay && <OverlayPanelBackdrop onClose={onClose} />}
      <aside
        className={cn(
          PANEL_ENTER_BASE_CLASS,
          isSinglePanelView && "border-l-0",
          isFloatingOverlay && PANEL_OVERLAY_CLASS,
        )}
        data-testid="agent-session-thread-panel"
        style={{
          width: isSinglePanelView
            ? "100%"
            : `min(${widthPx}px, calc(100% - ${THREAD_PANEL_MIN_WIDTH_PX}px))`,
        }}
      >
        {!isOverlay ? (
          <div
            aria-hidden="true"
            className={auxiliaryPanelFloatingHeaderBackdropClass}
          />
        ) : null}

        <div
          className={cn(
            auxiliaryPanelFloatingHeaderBaseClass,
            isSinglePanelView
              ? `${PANEL_SINGLE_COLUMN_HEADER_LAYER_CLASS} ${auxiliaryPanelFloatingHeaderSingleColumnClass}`
              : auxiliaryPanelFloatingHeaderClass,
          )}
          data-tauri-drag-region
        >
          {agentHeaderContent}
        </div>

        {agentBody}
      </aside>
    </>
  );
}

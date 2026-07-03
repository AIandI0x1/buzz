import type * as React from "react";
import { Ellipsis, OctagonX, Trash2 } from "lucide-react";

import { formatAgentModelLabel } from "@/features/agents/lib/formatAgentModelLabel";
import { friendlyAgentLastError } from "@/features/agents/lib/friendlyAgentLastError";
import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import { useUserProfileQuery } from "@/features/profile/hooks";
import type { ManagedAgent } from "@/shared/api/types";
import type { ProfilePanelOpenOptions } from "@/shared/context/ProfilePanelContext";
import { useFeedbackToasts } from "@/shared/hooks/useToastEffect";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { IdentityCardSkeleton } from "@/shared/ui/identity-card-skeleton";
import { AgentActionsMenu } from "./AgentActionsMenu";
import { AgentIdentityCard } from "./AgentIdentityCard";
import { AgentRuntimeAvatarControl } from "./AgentRuntimeAvatarControl";
import { CreateIdentityCard } from "./CreateIdentityCard";

type UnifiedAgentsSectionProps = {
  actionErrorMessage: string | null;
  actionNoticeMessage: string | null;
  agents: ManagedAgent[];
  agentsError: Error | null;
  isActionPending: boolean;
  isAgentsLoading: boolean;
  startingAgentPubkey: string | null;
  onBulkRemoveStopped: () => void;
  onBulkStopRunning: () => void;
  onCreateAgent: () => void;
  onOpenAgentProfile: (
    pubkey: string,
    options?: ProfilePanelOpenOptions,
  ) => void;
  onStartAgent: (pubkey: string) => void;
  onAddAgentToChannel: (agent: ManagedAgent) => void;
  onDeleteAgent: (agent: ManagedAgent) => void;
  onDuplicateAgent: (agent: ManagedAgent) => void;
  onEditAgent: (agent: ManagedAgent) => void;
  onExportAgent: (agent: ManagedAgent) => void;
  onSaveAgentAsTemplate: (agent: ManagedAgent) => void;
  onImportAgentFile: (fileBytes: number[], fileName: string) => void;
};

const AGENT_CARD_COLUMN_CLASS = "w-full";
const AGENT_CARD_GRID_CLASS = `${AGENT_CARD_COLUMN_CLASS} grid grid-cols-[repeat(auto-fill,minmax(220px,240px))] justify-start gap-3`;

export function UnifiedAgentsSection(props: UnifiedAgentsSectionProps) {
  const {
    actionErrorMessage,
    actionNoticeMessage,
    agents,
    agentsError,
    isActionPending,
    isAgentsLoading,
    startingAgentPubkey,
    onBulkRemoveStopped,
    onBulkStopRunning,
    onCreateAgent,
    onOpenAgentProfile,
    onStartAgent,
    onAddAgentToChannel,
    onDeleteAgent,
    onDuplicateAgent,
    onEditAgent,
    onExportAgent,
    onSaveAgentAsTemplate,
    onImportAgentFile,
  } = props;

  const runningCount = agents.filter((agent) =>
    isManagedAgentActive(agent),
  ).length;
  const stoppedCount = agents.filter(
    (agent) => agent.status === "stopped" || agent.status === "not_deployed",
  ).length;
  const { fileInputRef, isDragOver, dropHandlers, handleFileChange } =
    useFileImportZone({ onImportFile: onImportAgentFile });

  useFeedbackToasts(actionNoticeMessage, actionErrorMessage);

  return (
    <section
      className="relative space-y-4"
      data-testid="agents-library-personas"
      {...dropHandlers}
    >
      {isDragOver ? (
        <div className="pointer-events-none absolute -inset-1 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-background/80 backdrop-blur-sm">
          <p className="text-sm font-medium text-primary">
            Drop agent files (.persona.md, .persona.json, .persona.png, or .zip)
            to import
          </p>
        </div>
      ) : null}

      <SectionHeader
        agentCount={agents.length}
        fileInputRef={fileInputRef}
        handleFileChange={handleFileChange}
        isActionPending={isActionPending}
        runningCount={runningCount}
        stoppedCount={stoppedCount}
        onBulkRemoveStopped={onBulkRemoveStopped}
        onBulkStopRunning={onBulkStopRunning}
      />

      {isAgentsLoading ? <LoadingSkeleton /> : null}

      {!isAgentsLoading ? (
        <div className="space-y-3" data-testid="unified-agents-groups">
          <div className={AGENT_CARD_GRID_CLASS}>
            {agents.map((agent) => (
              <AgentCard
                actions={
                  <AgentActionsMenu
                    agent={agent}
                    disabled={isActionPending}
                    onAddToChannel={onAddAgentToChannel}
                    onDelete={onDeleteAgent}
                    onDuplicate={onDuplicateAgent}
                    onEdit={onEditAgent}
                    onExport={onExportAgent}
                    onSaveAsTemplate={onSaveAgentAsTemplate}
                  />
                }
                agent={agent}
                key={agent.pubkey}
                startingAgentPubkey={startingAgentPubkey}
                onOpenAgentProfile={onOpenAgentProfile}
                onStartAgent={onStartAgent}
              />
            ))}
            <CreateIdentityCard
              ariaLabel="New agent"
              dataTestId="new-agent-card"
              label="New agent"
              onClick={onCreateAgent}
            />
          </div>
        </div>
      ) : null}

      {agentsError ? (
        <p
          className={`${AGENT_CARD_COLUMN_CLASS} rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive`}
        >
          {agentsError.message}
        </p>
      ) : null}
    </section>
  );
}

function AgentCard({
  actions,
  agent,
  startingAgentPubkey,
  onOpenAgentProfile,
  onStartAgent,
}: {
  actions?: React.ReactNode;
  agent: ManagedAgent;
  startingAgentPubkey: string | null;
  onOpenAgentProfile: (
    pubkey: string,
    options?: ProfilePanelOpenOptions,
  ) => void;
  onStartAgent: (pubkey: string) => void;
}) {
  const title = agent.name;
  const profileQuery = useUserProfileQuery(agent.pubkey);
  const avatarUrl = firstAvatarUrl(
    profileQuery.data?.avatarUrl,
    agent.avatarUrl,
  );
  const friendlyError = friendlyAgentLastError(agent.lastError)?.copy;
  const isActive = isManagedAgentActive(agent);
  const opensRuntimeTab = Boolean(friendlyError && !isActive);

  return (
    <AgentIdentityCard
      actions={actions}
      ariaLabel={`${title} agent profile`}
      avatar={
        <AgentRuntimeAvatarControl
          activeTestId={`agent-runtime-active-${agent.pubkey}`}
          avatarUrl={avatarUrl}
          errorLabel={friendlyError}
          errorTestId={`agent-runtime-error-${agent.pubkey}`}
          isActive={isActive}
          isStarting={startingAgentPubkey === agent.pubkey}
          label={title}
          startTestId={`agent-runtime-start-${agent.pubkey}`}
          onOpenError={() => {
            onOpenAgentProfile(agent.pubkey, { tab: "runtime" });
          }}
          onStart={() => onStartAgent(agent.pubkey)}
        />
      }
      avatarUrl={avatarUrl}
      dataTestId={`managed-agent-${agent.pubkey}`}
      label={title}
      modelLabel={isActive ? formatAgentModelLabel(agent.model) : null}
      onClick={() => {
        onOpenAgentProfile(
          agent.pubkey,
          opensRuntimeTab ? { tab: "runtime" } : undefined,
        );
      }}
    />
  );
}

function firstAvatarUrl(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function SectionHeader({
  agentCount,
  fileInputRef,
  handleFileChange,
  isActionPending,
  runningCount,
  stoppedCount,
  onBulkRemoveStopped,
  onBulkStopRunning,
}: {
  agentCount: number;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isActionPending: boolean;
  runningCount: number;
  stoppedCount: number;
  onBulkRemoveStopped: () => void;
  onBulkStopRunning: () => void;
}) {
  return (
    <div
      className={`${AGENT_CARD_COLUMN_CLASS} flex items-center justify-between gap-3`}
    >
      <div>
        <h3 className="text-sm font-semibold tracking-tight">Agents</h3>
        <p className="text-sm text-secondary-foreground/75">
          Agents in this workspace.
        </p>
      </div>
      <input
        accept=".md,.json,.png,.zip"
        className="hidden"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />
      {agentCount > 0 ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Bulk actions"
              className="h-7 w-7"
              size="icon"
              variant="ghost"
            >
              <Ellipsis className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuItem
              disabled={isActionPending || runningCount === 0}
              onClick={onBulkStopRunning}
            >
              <OctagonX className="h-4 w-4" />
              Stop all running ({runningCount})
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={isActionPending || stoppedCount === 0}
              onClick={onBulkRemoveStopped}
            >
              <Trash2 className="h-4 w-4" />
              Remove all stopped ({stoppedCount})
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className={AGENT_CARD_GRID_CLASS}>
      <IdentityCardSkeleton
        footerSubtitleWidthClass="w-14"
        footerTitleWidthClass="w-24"
      />
      <IdentityCardSkeleton
        footerSubtitleWidthClass="w-20"
        footerTitleWidthClass="w-32"
      />
      <IdentityCardSkeleton
        footerSubtitleWidthClass="w-16"
        footerTitleWidthClass="w-28"
      />
    </div>
  );
}

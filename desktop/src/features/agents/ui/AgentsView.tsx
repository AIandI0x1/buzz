import * as React from "react";
import {
  consumePendingOpenCreateAgent,
  subscribeOpenCreateAgent,
} from "@/features/agents/openCreateAgentEvent";
import { usePersonasQuery } from "@/features/agents/hooks";
import type { ManagedAgent } from "@/shared/api/types";
import { useProfilePanel } from "@/shared/context/ProfilePanelContext";
import type { AgentDraft } from "./agentDraft";
import { AddAgentToChannelDialog } from "./AddAgentToChannelDialog";
import { AddTeamToChannelDialog } from "./AddTeamToChannelDialog";
import { BatchImportDialog } from "./BatchImportDialog";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { CreateAgentStartDialog } from "./CreateAgentStartDialog";
import { EditAgentDialog } from "./EditAgentDialog";
import { RelayDirectorySection } from "./RelayDirectorySection";
import { SecretRevealDialog } from "./SecretRevealDialog";
import { TeamDeleteDialog } from "./TeamDeleteDialog";
import { TeamDialog } from "./TeamDialog";
import { TeamImportDialog } from "./TeamImportDialog";
import { TeamImportUpdateDialog } from "./TeamImportUpdateDialog";
import { TeamsSection } from "./TeamsSection";
import { UnifiedAgentsSection } from "./UnifiedAgentsSection";
import { useManagedAgentActions } from "./useManagedAgentActions";
import { useTeamActions } from "./useTeamActions";

export function AgentsView() {
  const { openProfilePanel } = useProfilePanel();
  const agents = useManagedAgentActions();
  const personasQuery = usePersonasQuery();
  const [agentToEdit, setAgentToEdit] = React.useState<ManagedAgent | null>(
    null,
  );
  const teamActions = useTeamActions(
    {
      setActionNoticeMessage: agents.setActionNoticeMessage,
      setActionErrorMessage: agents.setActionErrorMessage,
    },
    {
      refetchManagedAgents: agents.refetchManagedAgents,
      refetchRelayAgents: agents.refetchRelayAgents,
    },
  );

  const personas = personasQuery.data ?? [];
  const isActionPending =
    agents.isPending ||
    teamActions.exportTeamJsonMutation.isPending ||
    teamActions.createTeamMutation.isPending ||
    teamActions.updateTeamMutation.isPending ||
    teamActions.deleteTeamMutation.isPending;

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe once on mount
  React.useEffect(() => {
    function handleRequest(pending: { draft: AgentDraft | null }) {
      if (pending.draft) {
        agents.setIsCreateStartOpen(false);
        agents.setCreateDraft(pending.draft);
      } else {
        agents.openCreateStart();
      }
    }

    const pending = consumePendingOpenCreateAgent();
    if (pending) {
      handleRequest(pending);
    }

    return subscribeOpenCreateAgent(handleRequest);
  }, []);

  return (
    <>
      <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
          <div className="flex flex-col gap-8">
            <UnifiedAgentsSection
              actionErrorMessage={agents.actionErrorMessage}
              actionNoticeMessage={agents.actionNoticeMessage}
              agents={agents.managedAgents}
              agentsError={
                agents.managedAgentsQuery.error instanceof Error
                  ? agents.managedAgentsQuery.error
                  : null
              }
              isActionPending={isActionPending}
              isAgentsLoading={agents.managedAgentsQuery.isLoading}
              startingAgentPubkey={agents.startingAgentPubkey}
              onBulkRemoveStopped={() => {
                void agents.handleBulkRemoveStopped();
              }}
              onBulkStopRunning={() => {
                void agents.handleBulkStopRunning();
              }}
              onCreateAgent={agents.openCreateStart}
              onOpenAgentProfile={(pubkey, options) => {
                openProfilePanel?.(pubkey, options);
              }}
              onStartAgent={(pubkey) => {
                void agents.handleStart(pubkey);
              }}
              onAddAgentToChannel={agents.setAgentToAddToChannel}
              onDeleteAgent={(agent) => {
                void agents.handleDelete(agent.pubkey);
              }}
              onDuplicateAgent={agents.openDuplicateAgent}
              onEditAgent={setAgentToEdit}
              onExportAgent={agents.handleExportAgent}
              onSaveAgentAsTemplate={agents.handleSaveAsTemplate}
              onImportAgentFile={(fileBytes, fileName) => {
                void agents.handleImportAgentFile(fileBytes, fileName);
              }}
            />

            <TeamsSection
              agents={agents.managedAgents}
              error={
                teamActions.teamsQuery.error instanceof Error
                  ? teamActions.teamsQuery.error
                  : null
              }
              isLoading={teamActions.teamsQuery.isLoading}
              isPending={
                teamActions.createTeamMutation.isPending ||
                teamActions.updateTeamMutation.isPending ||
                teamActions.deleteTeamMutation.isPending
              }
              onCreate={teamActions.openCreateDialog}
              onDelete={teamActions.setTeamToDelete}
              onDuplicate={teamActions.openDuplicateDialog}
              onEdit={teamActions.openEditDialog}
              onExport={teamActions.handleExportTeam}
              onImportFile={teamActions.handleImportFile}
              onInstallFromDirectory={teamActions.handleInstallFromDirectory}
              onSync={teamActions.handleSyncTeam}
              onRevealInFinder={teamActions.handleRevealInFinder}
              onAddToChannel={teamActions.setTeamToAddToChannel}
              personas={personas}
              teams={teamActions.teams}
            />

            <RelayDirectorySection
              error={
                agents.relayAgentsQuery.error instanceof Error
                  ? agents.relayAgentsQuery.error
                  : null
              }
              isLoading={agents.relayAgentsQuery.isLoading}
              managedPubkeys={agents.managedPubkeys}
              relayAgents={agents.relayAgentsQuery.data ?? []}
            />
          </div>
        </div>
      </div>

      <CreateAgentStartDialog
        onImportFile={(fileBytes, fileName) => {
          void agents.handleImportAgentFile(fileBytes, fileName);
        }}
        onOpenChange={agents.setIsCreateStartOpen}
        onPickBlank={agents.handlePickBlank}
        onPickTemplate={agents.handlePickTemplate}
        open={agents.isCreateStartOpen}
      />
      {agents.createDraft ? (
        <CreateAgentDialog
          draft={agents.createDraft}
          onCreated={(result) => {
            agents.setLogAgentPubkey(result.agent.pubkey);
            agents.setCreatedAgent(result);
          }}
          onOpenChange={(open) => {
            if (!open) {
              agents.setCreateDraft(null);
            }
          }}
          open={agents.createDraft !== null}
        />
      ) : null}
      {agentToEdit ? (
        <EditAgentDialog
          agent={agentToEdit}
          onOpenChange={(open) => {
            if (!open) {
              setAgentToEdit(null);
            }
          }}
          open={agentToEdit !== null}
        />
      ) : null}
      {agents.agentToAddToChannel ? (
        <AddAgentToChannelDialog
          agent={agents.agentToAddToChannel}
          onAdded={agents.handleAddedToChannel}
          onOpenChange={(open) => {
            if (!open) {
              agents.setAgentToAddToChannel(null);
            }
          }}
          open={agents.agentToAddToChannel !== null}
        />
      ) : null}
      {agents.createdAgent ? (
        <SecretRevealDialog
          created={agents.createdAgent}
          onOpenChange={(open) => {
            if (!open) {
              agents.setCreatedAgent(null);
            }
          }}
        />
      ) : null}
      {agents.batchImportResult ? (
        <BatchImportDialog
          fileName={agents.batchImportFileName}
          onComplete={agents.handleBatchImportComplete}
          onOpenChange={(open) => {
            if (!open) {
              agents.setBatchImportResult(null);
            }
          }}
          open={agents.batchImportResult !== null}
          result={agents.batchImportResult}
        />
      ) : null}
      {teamActions.teamDialogState ? (
        <TeamDialog
          agents={agents.managedAgents}
          description={teamActions.teamDialogState.description}
          error={
            teamActions.updateTeamMutation.error instanceof Error
              ? teamActions.updateTeamMutation.error
              : teamActions.createTeamMutation.error instanceof Error
                ? teamActions.createTeamMutation.error
                : null
          }
          initialValues={teamActions.teamDialogState.initialValues}
          isImportPending={teamActions.isApplyingTeamImportUpdate}
          isPending={
            teamActions.createTeamMutation.isPending ||
            teamActions.updateTeamMutation.isPending
          }
          onImportUpdateFile={teamActions.handleEditDialogImportUpdateFile}
          onOpenChange={(open) => {
            if (!open) {
              teamActions.setTeamDialogState(null);
            }
          }}
          onDeleteRemovedMembers={teamActions.handleDeleteRemovedMembers}
          onSubmit={teamActions.handleTeamSubmit}
          open={teamActions.teamDialogState !== null}
          personas={personas}
          submitLabel={teamActions.teamDialogState.submitLabel}
          title={teamActions.teamDialogState.title}
        />
      ) : null}
      {teamActions.teamToDelete ? (
        <TeamDeleteDialog
          onConfirm={(team) => {
            void teamActions.handleDeleteTeam(team);
          }}
          onOpenChange={(open) => {
            if (!open) {
              teamActions.setTeamToDelete(null);
            }
          }}
          open={teamActions.teamToDelete !== null}
          team={teamActions.teamToDelete}
        />
      ) : null}
      {teamActions.teamToAddToChannel ? (
        <AddTeamToChannelDialog
          agents={agents.managedAgents}
          onDeployed={teamActions.handleTeamDeployed}
          onOpenChange={(open) => {
            if (!open) {
              teamActions.setTeamToAddToChannel(null);
            }
          }}
          open={teamActions.teamToAddToChannel !== null}
          personas={personas}
          team={teamActions.teamToAddToChannel}
        />
      ) : null}
      {teamActions.teamImportPreview ? (
        <TeamImportDialog
          fileName={teamActions.teamImportPreview.fileName}
          onComplete={teamActions.handleTeamImportComplete}
          onOpenChange={(open) => {
            if (!open) {
              teamActions.setTeamImportPreview(null);
            }
          }}
          open={teamActions.teamImportPreview !== null}
          preview={teamActions.teamImportPreview.preview}
        />
      ) : null}
      {teamActions.teamImportTarget ? (
        <TeamImportUpdateDialog
          agents={agents.managedAgents}
          fileName={teamActions.teamImportTargetPreview?.fileName ?? ""}
          isPending={
            teamActions.isApplyingTeamImportUpdate ||
            teamActions.updateTeamMutation.isPending
          }
          onApply={teamActions.handleTeamImportUpdateApply}
          onClear={teamActions.clearImportUpdateAndReturnToEdit}
          onOpenChange={(open) => {
            if (!open) {
              teamActions.closeImportUpdateDialog();
            }
          }}
          open={teamActions.teamImportTarget !== null}
          personas={personas}
          preview={teamActions.teamImportTargetPreview?.preview ?? null}
          team={teamActions.teamImportTarget}
        />
      ) : null}
    </>
  );
}

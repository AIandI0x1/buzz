import * as React from "react";

import {
  type AttachManagedAgentToChannelResult,
  useExportAgentJsonMutation,
  useManagedAgentLogQuery,
  useManagedAgentsQuery,
  useRelayAgentsQuery,
  useSaveAgentAsTemplateMutation,
  useSetManagedAgentStartOnAppLaunchMutation,
  useStartManagedAgentMutation,
  useStopManagedAgentMutation,
  useDeleteManagedAgentMutation,
} from "@/features/agents/hooks";
import { useChannelsQuery } from "@/features/channels/hooks";
import { usePresenceQuery } from "@/features/presence/hooks";
import { useManagedAgentObserverBridge } from "@/features/agents/observerRelayStore";
import { useActiveAgentTurnsBridge } from "@/features/agents/activeAgentTurnsStore";
import type {
  AgentTemplate,
  Channel,
  CreateManagedAgentResponse,
  ManagedAgent,
} from "@/shared/api/types";
import { removeChannelMember } from "@/shared/api/tauri";
import {
  parsePersonaFiles,
  type ParsePersonaFilesResult,
} from "@/shared/api/tauriPersonas";
import { isSingleItemFile } from "@/shared/lib/fileMagic";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  deleteManagedAgentWithRules,
  isManagedAgentActive,
  startManagedAgentWithRules,
  stopManagedAgentWithRules,
} from "../lib/managedAgentControlActions";
import {
  blankAgentDraft,
  duplicateAgentDraft,
  importAgentDraft,
  templateAgentDraft,
  type AgentDraft,
} from "./agentDraft";

export function useManagedAgentActions() {
  const relayAgentsQuery = useRelayAgentsQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const [shouldLoadChannels, setShouldLoadChannels] = React.useState(false);
  const channelsQuery = useChannelsQuery({ enabled: shouldLoadChannels });
  const startMutation = useStartManagedAgentMutation();
  const stopMutation = useStopManagedAgentMutation();
  const deleteMutation = useDeleteManagedAgentMutation();
  const startOnLaunchMutation = useSetManagedAgentStartOnAppLaunchMutation();
  const exportAgentJsonMutation = useExportAgentJsonMutation();
  const saveAsTemplateMutation = useSaveAgentAsTemplateMutation();
  const [isCreateStartOpen, setIsCreateStartOpen] = React.useState(false);
  const [createDraft, setCreateDraft] = React.useState<AgentDraft | null>(null);
  const [batchImportResult, setBatchImportResult] =
    React.useState<ParsePersonaFilesResult | null>(null);
  const [batchImportFileName, setBatchImportFileName] = React.useState("");
  const [agentToAddToChannel, setAgentToAddToChannel] =
    React.useState<ManagedAgent | null>(null);
  const [createdAgent, setCreatedAgent] =
    React.useState<CreateManagedAgentResponse | null>(null);
  const [logAgentPubkey, setLogAgentPubkey] = React.useState<string | null>(
    null,
  );
  const [actionNoticeMessage, setActionNoticeMessage] = React.useState<
    string | null
  >(null);
  const [actionErrorMessage, setActionErrorMessage] = React.useState<
    string | null
  >(null);

  const managedAgentLogQuery = useManagedAgentLogQuery(logAgentPubkey);

  React.useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setShouldLoadChannels(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const managedAgents = React.useMemo(
    () =>
      [...(managedAgentsQuery.data ?? [])].sort((left, right) => {
        const activeScore = (s: string) =>
          s === "running" || s === "deployed" ? 1 : 0;
        const diff = activeScore(right.status) - activeScore(left.status);
        if (diff !== 0) return diff;
        return left.name.localeCompare(right.name);
      }),
    [managedAgentsQuery.data],
  );
  useManagedAgentObserverBridge(managedAgents);
  useActiveAgentTurnsBridge(managedAgents);

  const managedPubkeys = React.useMemo(
    () => new Set(managedAgents.map((agent) => agent.pubkey)),
    [managedAgents],
  );

  const managedPubkeyList = React.useMemo(
    () => managedAgents.map((agent) => agent.pubkey),
    [managedAgents],
  );

  const managedPresenceQuery = usePresenceQuery(managedPubkeyList);

  const channelsByPubkey = React.useMemo(() => {
    const map: Record<string, { id: string; name: string }[]> = {};
    // Seed from relay agent profiles (kind:10100 events).
    for (const ra of relayAgentsQuery.data ?? []) {
      if (ra.channels.length > 0) {
        // Skip entries missing a channel id rather than falling back to the
        // name as id — a misaligned channels/channelIds pairing would otherwise
        // produce a pill that silently navigates to a channel name as if it
        // were an id.
        map[normalizePubkey(ra.pubkey)] = ra.channels.flatMap((name, i) => {
          const id = ra.channelIds[i];
          return id ? [{ id, name }] : [];
        });
      }
    }
    // Fill in from channel member lists (kind:39002) for any managed agents
    // not already covered by relay agent data.
    const normalizedManaged = new Set(
      managedAgents.map((a) => normalizePubkey(a.pubkey)),
    );
    for (const ch of channelsQuery.data ?? []) {
      for (const pk of ch.memberPubkeys) {
        const key = normalizePubkey(pk);
        if (!normalizedManaged.has(key)) continue;
        if (!map[key]) map[key] = [];
        if (!map[key].some((entry) => entry.id === ch.id)) {
          map[key].push({ id: ch.id, name: ch.name });
        }
      }
    }
    return map;
  }, [relayAgentsQuery.data, channelsQuery.data, managedAgents]);

  const channelIdToName = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const ch of channelsQuery.data ?? []) {
      map[ch.id] = ch.name;
    }
    return map;
  }, [channelsQuery.data]);

  // Clear log selection if the agent was removed
  React.useEffect(() => {
    if (
      logAgentPubkey &&
      !managedAgents.some((agent) => agent.pubkey === logAgentPubkey)
    ) {
      setLogAgentPubkey(null);
    }
  }, [managedAgents, logAgentPubkey]);

  function clearFeedback() {
    setActionNoticeMessage(null);
    setActionErrorMessage(null);
  }

  async function handleStart(pubkey: string) {
    clearFeedback();
    try {
      const agent = managedAgents.find((c) => c.pubkey === pubkey);
      if (!agent) return;
      await startManagedAgentWithRules({
        agent,
        startManagedAgent: startMutation.mutateAsync,
      });
    } catch (error) {
      setActionErrorMessage(
        error instanceof Error ? error.message : "Failed to start agent.",
      );
    }
  }

  // ── Create Agent wizard ────────────────────────────────────────────────

  function openCreateStart() {
    clearFeedback();
    setIsCreateStartOpen(true);
  }

  function openCreateWithDraft(draft: AgentDraft) {
    clearFeedback();
    setIsCreateStartOpen(false);
    setCreateDraft(draft);
  }

  function handlePickBlank() {
    openCreateWithDraft(blankAgentDraft());
  }

  function handlePickTemplate(template: AgentTemplate) {
    openCreateWithDraft(templateAgentDraft(template));
  }

  function openDuplicateAgent(agent: ManagedAgent) {
    openCreateWithDraft(duplicateAgentDraft(agent));
  }

  async function handleImportAgentFile(fileBytes: number[], fileName: string) {
    clearFeedback();
    try {
      const result = await parsePersonaFiles(fileBytes, fileName);
      if (
        isSingleItemFile(fileBytes, fileName) &&
        result.personas.length === 1
      ) {
        openCreateWithDraft(importAgentDraft(result.personas[0]));
      } else if (result.personas.length > 0) {
        setIsCreateStartOpen(false);
        setBatchImportResult(result);
        setBatchImportFileName(fileName);
      } else {
        setActionErrorMessage("No valid agents found in file.");
      }
    } catch (error) {
      setActionErrorMessage(
        error instanceof Error ? error.message : "Failed to parse agent file.",
      );
    }
  }

  function handleBatchImportComplete(count: number) {
    clearFeedback();
    setBatchImportResult(null);
    setActionNoticeMessage(`Imported ${count} agent${count !== 1 ? "s" : ""}.`);
    void managedAgentsQuery.refetch();
    void relayAgentsQuery.refetch();
  }

  function handleExportAgent(agent: ManagedAgent) {
    clearFeedback();
    exportAgentJsonMutation.mutate(agent.pubkey, {
      onSuccess: (saved) => {
        if (saved) {
          setActionNoticeMessage(`Exported ${agent.name}.`);
        }
      },
      onError: (error) => {
        setActionErrorMessage(
          error instanceof Error ? error.message : "Failed to export agent.",
        );
      },
    });
  }

  function handleSaveAsTemplate(agent: ManagedAgent) {
    clearFeedback();
    saveAsTemplateMutation.mutate(agent.pubkey, {
      onSuccess: (template) => {
        setActionNoticeMessage(
          `Saved ${template.displayName} as a template. It will show under New agent.`,
        );
      },
      onError: (error) => {
        setActionErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to save agent as a template.",
        );
      },
    });
  }

  async function getChannelsForAction() {
    if (channelsQuery.data) {
      return channelsQuery.data;
    }

    const result = await channelsQuery.refetch();
    return result.data ?? [];
  }

  async function handleStop(pubkey: string) {
    clearFeedback();
    try {
      const agent = managedAgents.find((a) => a.pubkey === pubkey);
      if (!agent) return;
      const channels = await getChannelsForAction();
      const result = await stopManagedAgentWithRules({
        agent,
        channels,
        relayAgents: relayAgentsQuery.data ?? [],
        stopManagedAgent: stopMutation.mutateAsync,
      });
      if (result.noticeMessage) {
        setActionNoticeMessage(result.noticeMessage);
      }
    } catch (error) {
      setActionErrorMessage(
        error instanceof Error ? error.message : "Failed to stop agent.",
      );
    }
  }

  function getAgentChannelIds(pubkey: string): string[] {
    const normalized = normalizePubkey(pubkey);
    const relayAgent = (relayAgentsQuery.data ?? []).find(
      (ra) => normalizePubkey(ra.pubkey) === normalized,
    );
    return relayAgent?.channelIds ?? [];
  }

  async function removeAgentFromAllChannels(pubkey: string) {
    const channelIds = getAgentChannelIds(pubkey);
    if (channelIds.length === 0) return;
    await Promise.allSettled(
      channelIds.map((channelId) => removeChannelMember(channelId, pubkey)),
    );
  }

  async function handleDelete(pubkey: string) {
    clearFeedback();
    try {
      const agent = managedAgents.find((a) => a.pubkey === pubkey);
      if (!agent) return;
      const channels = await getChannelsForAction();
      const result = await deleteManagedAgentWithRules({
        agent,
        channels,
        deleteManagedAgent: deleteMutation.mutateAsync,
        presenceLookup: managedPresenceQuery.data,
        relayAgents: relayAgentsQuery.data ?? [],
      });
      if (result.cancelled) return;
      await removeAgentFromAllChannels(pubkey);
      if (logAgentPubkey === pubkey) {
        setLogAgentPubkey(null);
      }
    } catch (error) {
      setActionErrorMessage(
        error instanceof Error ? error.message : "Failed to delete agent.",
      );
    }
  }

  async function handleToggleStartOnAppLaunch(
    pubkey: string,
    startOnAppLaunch: boolean,
  ) {
    clearFeedback();
    try {
      const updated = await startOnLaunchMutation.mutateAsync({
        pubkey,
        startOnAppLaunch,
      });
      setActionNoticeMessage(
        updated.startOnAppLaunch
          ? `Will start ${updated.name} automatically when the desktop app opens.`
          : `${updated.name} will stay manual-start only.`,
      );
    } catch (error) {
      setActionErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to update startup preference.",
      );
    }
  }

  function handleAddedToChannel(
    channel: Channel,
    result: AttachManagedAgentToChannelResult,
  ) {
    setActionErrorMessage(null);
    setActionNoticeMessage(() => {
      if (result.started) {
        return `Added ${result.agent.name} to ${channel.name} and spawned it.`;
      }
      if (result.membershipAdded) {
        return `Added ${result.agent.name} to ${channel.name}.`;
      }
      return `${result.agent.name} is already in ${channel.name}.`;
    });
    void managedAgentsQuery.refetch();
    void relayAgentsQuery.refetch();
  }

  async function runBulkAction(
    targets: ManagedAgent[],
    confirmLabel: string,
    failureNoun: string,
    action: (agent: ManagedAgent) => Promise<unknown>,
  ): Promise<boolean> {
    if (targets.length === 0) return false;
    const confirmed = window.confirm(
      `${confirmLabel} ${targets.length} agent${targets.length === 1 ? "" : "s"}?`,
    );
    if (!confirmed) return false;
    clearFeedback();
    const results = await Promise.allSettled(targets.map(action));
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      setActionErrorMessage(
        `${failures.length} of ${targets.length} ${failureNoun}${failures.length === 1 ? "" : "s"} failed.`,
      );
    }
    return true;
  }

  async function handleBulkStopRunning() {
    await runBulkAction(
      managedAgents.filter((a) => isManagedAgentActive(a)),
      "Stop",
      "stop",
      (a) =>
        stopManagedAgentWithRules({
          agent: a,
          channels: channelsQuery.data ?? [],
          relayAgents: relayAgentsQuery.data ?? [],
          stopManagedAgent: stopMutation.mutateAsync,
        }),
    );
  }

  async function handleBulkRemoveStopped() {
    const targets = managedAgents.filter(
      (a) => a.status === "stopped" || a.status === "not_deployed",
    );
    const executed = await runBulkAction(
      targets,
      "Remove",
      "removal",
      async (a) => {
        await deleteManagedAgent(a);
        await removeAgentFromAllChannels(a.pubkey);
      },
    );
    if (
      executed &&
      logAgentPubkey &&
      targets.some((a) => a.pubkey === logAgentPubkey)
    ) {
      setLogAgentPubkey(null);
    }
  }

  async function deleteManagedAgent(agent: ManagedAgent) {
    const isDeployedRemote =
      agent.backend.type === "provider" && agent.backendAgentId;
    await deleteMutation.mutateAsync({
      pubkey: agent.pubkey,
      forceRemoteDelete: isDeployedRemote ? true : undefined,
    });
  }

  const isPending =
    startMutation.isPending ||
    stopMutation.isPending ||
    startOnLaunchMutation.isPending ||
    exportAgentJsonMutation.isPending ||
    saveAsTemplateMutation.isPending ||
    deleteMutation.isPending;
  const startingAgentPubkey =
    startMutation.isPending && typeof startMutation.variables === "string"
      ? startMutation.variables
      : null;

  return {
    relayAgentsQuery,
    managedAgentsQuery,
    managedAgentLogQuery,
    managedPresenceQuery,
    managedAgents,
    managedPubkeys,
    channelIdToName,
    channelsByPubkey,
    isPending,
    isCreateStartOpen,
    setIsCreateStartOpen,
    createDraft,
    setCreateDraft,
    batchImportResult,
    setBatchImportResult,
    batchImportFileName,
    agentToAddToChannel,
    setAgentToAddToChannel,
    createdAgent,
    setCreatedAgent,
    logAgentPubkey,
    setLogAgentPubkey,
    actionNoticeMessage,
    setActionNoticeMessage,
    actionErrorMessage,
    setActionErrorMessage,
    startingAgentPubkey,
    openCreateStart,
    handlePickBlank,
    handlePickTemplate,
    openDuplicateAgent,
    handleImportAgentFile,
    handleBatchImportComplete,
    handleExportAgent,
    handleSaveAsTemplate,
    handleStart,
    handleStop,
    handleDelete,
    handleToggleStartOnAppLaunch,
    handleAddedToChannel,
    handleBulkStopRunning,
    handleBulkRemoveStopped,
    refetchManagedAgents: () => void managedAgentsQuery.refetch(),
    refetchRelayAgents: () => void relayAgentsQuery.refetch(),
  };
}

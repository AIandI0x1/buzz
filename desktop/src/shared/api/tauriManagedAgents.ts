import {
  fromRawManagedAgent,
  invokeTauri,
  type RawManagedAgent,
} from "@/shared/api/tauri";
import type { AgentTemplate, ManagedAgent } from "@/shared/api/types";

export async function setManagedAgentStartOnAppLaunch(
  pubkey: string,
  startOnAppLaunch: boolean,
): Promise<ManagedAgent> {
  const response = await invokeTauri<RawManagedAgent>(
    "set_managed_agent_start_on_app_launch",
    {
      pubkey,
      startOnAppLaunch,
    },
  );
  return fromRawManagedAgent(response);
}

/** Templates for the Create Agent wizard: built-ins plus saved templates. */
export async function listAgentTemplates(): Promise<AgentTemplate[]> {
  return invokeTauri<AgentTemplate[]>("list_agent_templates");
}

/**
 * Save a managed agent's pinned config as a reusable template so it shows
 * in the New Agent catalog. Re-saving an agent with the same name updates
 * the existing template instead of duplicating it.
 */
export async function saveAgentAsTemplate(
  pubkey: string,
): Promise<AgentTemplate> {
  return invokeTauri<AgentTemplate>("save_agent_as_template", { pubkey });
}

/**
 * Export a managed agent's pinned config as a shareable `.persona.json` card.
 * Returns `false` when the user cancels the save dialog.
 */
export async function exportAgentToJson(pubkey: string): Promise<boolean> {
  return invokeTauri<boolean>("export_agent_to_json", { pubkey });
}

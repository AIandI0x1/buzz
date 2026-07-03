//! Agent templates and agent-record export.
//!
//! Templates are starter data for the Create Agent wizard — selecting one
//! prefills the create form; the submit creates a plain managed agent.
//! Built-ins are static; saved templates are persona records (relay-synced).
//! Export maps a managed agent's pinned config onto the shareable
//! `.persona.json` card interchange format.

use tauri::{AppHandle, Manager, State};

use crate::{
    app_state::AppState,
    managed_agents::{
        agent_template_from_persona, builtin_agent_templates, load_managed_agents, load_personas,
        save_personas, try_regenerate_nest, AgentTemplate, PersonaRecord,
    },
    util::now_iso,
};

/// Templates for the Create Agent wizard: static built-ins followed by saved
/// templates (active persona records), sorted by display name. A saved record
/// whose id shadows a built-in id (a demoted legacy built-in copy) is skipped
/// so the catalog never shows the same starter twice.
#[tauri::command]
pub async fn list_agent_templates(app: AppHandle) -> Result<Vec<AgentTemplate>, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let mut templates = builtin_agent_templates();
        let mut saved: Vec<AgentTemplate> = load_personas(&app)?
            .iter()
            .filter(|persona| persona.is_active)
            .filter(|persona| !templates.iter().any(|builtin| builtin.id == persona.id))
            .map(agent_template_from_persona)
            .collect();
        saved.sort_by(|a, b| {
            a.display_name
                .to_lowercase()
                .cmp(&b.display_name.to_lowercase())
                .then_with(|| a.id.cmp(&b.id))
        });
        templates.extend(saved);
        Ok(templates)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Save a managed agent's pinned config as a reusable template (a persona
/// record) so it shows up in the New Agent catalog. An existing active
/// in-app template with the same display name is updated in place — saving
/// the same agent twice refreshes the template instead of duplicating it.
/// `env_vars` are deliberately excluded: templates are shareable definitions
/// and must never carry credentials. The record is retained for relay sync
/// (kind:30175), so the template reaches the owner's other devices.
#[tauri::command]
pub async fn save_agent_as_template(
    pubkey: String,
    app: AppHandle,
) -> Result<AgentTemplate, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let records = load_managed_agents(&app)?;
        let record = records
            .iter()
            .find(|r| r.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} not found"))?;

        let name = record.name.trim().to_string();
        if name.is_empty() {
            return Err("agent has no name to save as a template".to_string());
        }

        let mut personas = load_personas(&app)?;
        let effective_command = crate::managed_agents::effective_agent_command(
            record.persona_id.as_deref(),
            &personas,
            record.agent_command_override.as_deref(),
        );
        let runtime =
            crate::managed_agents::known_acp_runtime(&effective_command).map(|r| r.id.to_string());
        let now = now_iso();

        let persona = match personas.iter_mut().find(|p| {
            p.is_active
                && p.source_team.is_none()
                && p.display_name.trim().eq_ignore_ascii_case(&name)
        }) {
            Some(existing) => {
                existing.display_name = name;
                existing.avatar_url = record.avatar_url.clone();
                existing.system_prompt = record.system_prompt.clone().unwrap_or_default();
                existing.runtime = runtime;
                existing.model = record.model.clone();
                existing.provider = record.provider.clone();
                existing.updated_at = now;
                existing.clone()
            }
            None => {
                let persona = PersonaRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    display_name: name,
                    avatar_url: record.avatar_url.clone(),
                    system_prompt: record.system_prompt.clone().unwrap_or_default(),
                    runtime,
                    model: record.model.clone(),
                    provider: record.provider.clone(),
                    name_pool: Vec::new(),
                    is_builtin: false,
                    is_active: true,
                    source_team: None,
                    source_team_persona_slug: None,
                    env_vars: Default::default(),
                    created_at: now.clone(),
                    updated_at: now,
                };
                personas.push(persona.clone());
                persona
            }
        };
        save_personas(&app, &personas)?;
        super::personas::retain_persona_pending(&app, &state, &persona);
        try_regenerate_nest(&app);
        Ok(agent_template_from_persona(&persona))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Export a managed agent's pinned config as a shareable `.persona.json`
/// card (the interchange format). `env_vars` are deliberately excluded —
/// cards are shareable artifacts and must never carry credentials.
#[tauri::command]
pub async fn export_agent_to_json(
    pubkey: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    // Load the record under lock, then drop the lock before the dialog.
    let (name, system_prompt, avatar_url, runtime, model, provider) = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let records = load_managed_agents(&app)?;
        let record = records
            .iter()
            .find(|r| r.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} not found"))?;
        let personas = load_personas(&app).unwrap_or_default();
        let effective_command = crate::managed_agents::effective_agent_command(
            record.persona_id.as_deref(),
            &personas,
            record.agent_command_override.as_deref(),
        );
        let runtime =
            crate::managed_agents::known_acp_runtime(&effective_command).map(|r| r.id.to_string());
        (
            record.name.clone(),
            record.system_prompt.clone().unwrap_or_default(),
            record.avatar_url.clone(),
            runtime,
            record.model.clone(),
            record.provider.clone(),
        )
    };

    let json_bytes = crate::managed_agents::encode_persona_json(
        &name,
        &system_prompt,
        avatar_url.as_deref(),
        runtime.as_deref(),
        model.as_deref(),
        provider.as_deref(),
        &[],
    )?;

    let slug = crate::util::slugify(&name, "agent", 50);
    let filename = format!("{slug}.persona.json");
    super::export_util::save_json_with_dialog(&app, &filename, &json_bytes).await
}

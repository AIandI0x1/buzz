use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;
use uuid::Uuid;

use crate::app_state::{AppState, KEYRING_SERVICE};
use crate::secret_store::SecretStore;

const SPOTIFY_CREDENTIAL_KEY: &str = "spotify-oauth";
const SPOTIFY_AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const OAUTH_CALLBACK_PATH: &str = "/oauth/spotify/callback";
const OAUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);
const DEFAULT_SPOTIFY_REDIRECT_PORT: u16 = 18202;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SpotifyCredential {
    access_token: Option<String>,
    connected_at: i64,
    expires_at: Option<i64>,
    refresh_token: String,
    scope: Option<String>,
    token_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SpotifyStatus {
    configured: bool,
    connected: bool,
    connected_at: Option<i64>,
    scopes: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SpotifyTokenResponse {
    access_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
    scope: Option<String>,
    token_type: Option<String>,
}

fn spotify_client_id() -> Option<String> {
    std::env::var("BUZZ_SPOTIFY_CLIENT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            option_env!("BUZZ_SPOTIFY_CLIENT_ID")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn spotify_redirect_port() -> u16 {
    std::env::var("BUZZ_SPOTIFY_REDIRECT_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(DEFAULT_SPOTIFY_REDIRECT_PORT)
}

fn credential_store() -> &'static SecretStore {
    SecretStore::shared(KEYRING_SERVICE)
}

fn now_ts() -> i64 {
    Utc::now().timestamp()
}

fn load_credential() -> Result<Option<SpotifyCredential>, String> {
    let Some(raw) = credential_store().load(SPOTIFY_CREDENTIAL_KEY)? else {
        return Ok(None);
    };
    serde_json::from_str(&raw).map_err(|e| format!("parse Spotify credential: {e}"))
}

fn save_credential(credential: &SpotifyCredential) -> Result<(), String> {
    let raw = serde_json::to_string(credential)
        .map_err(|e| format!("serialize Spotify credential: {e}"))?;
    credential_store().store(SPOTIFY_CREDENTIAL_KEY, &raw)
}

fn scopes(scope: Option<&str>) -> Vec<String> {
    scope
        .unwrap_or("")
        .split_whitespace()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn status_from_credential(credential: Option<&SpotifyCredential>) -> SpotifyStatus {
    SpotifyStatus {
        configured: spotify_client_id().is_some(),
        connected: credential.is_some(),
        connected_at: credential.map(|value| value.connected_at),
        scopes: scopes(credential.and_then(|value| value.scope.as_deref())),
    }
}

fn pkce_verifier() -> String {
    [
        Uuid::new_v4().simple().to_string(),
        Uuid::new_v4().simple().to_string(),
        Uuid::new_v4().simple().to_string(),
    ]
    .join("")
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn oauth_state() -> String {
    [
        Uuid::new_v4().simple().to_string(),
        Uuid::new_v4().simple().to_string(),
    ]
    .join("")
}

fn oauth_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> Result<Url, String> {
    let mut url = Url::parse(SPOTIFY_AUTH_URL).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url)
}

fn callback_response(title: &str, body: &str) -> String {
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body><main style=\"font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto;\">\
         <h1>{title}</h1><p>{body}</p></main></body></html>"
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    )
}

async fn wait_for_oauth_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    let (mut stream, _) = tokio::time::timeout(OAUTH_CALLBACK_TIMEOUT, listener.accept())
        .await
        .map_err(|_| "Timed out waiting for Spotify authorization.".to_string())?
        .map_err(|e| format!("accept OAuth callback: {e}"))?;

    let mut buffer = [0_u8; 8192];
    let bytes_read = stream
        .read(&mut buffer)
        .await
        .map_err(|e| format!("read OAuth callback: {e}"))?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let request_target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "Invalid OAuth callback request.".to_string())?;
    let callback_url = Url::parse(&format!("http://127.0.0.1{request_target}"))
        .map_err(|e| format!("parse OAuth callback: {e}"))?;

    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (key, value) in callback_url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }

    let result = if callback_url.path() != OAUTH_CALLBACK_PATH {
        Err("Spotify returned an unexpected OAuth callback path.".to_string())
    } else if let Some(error) = error {
        Err(format!("Spotify authorization couldn't complete: {error}"))
    } else if state.as_deref() != Some(expected_state) {
        Err("Spotify authorization state did not match.".to_string())
    } else {
        code.ok_or_else(|| "Spotify authorization returned no code.".to_string())
    };

    let (title, body) = if result.is_ok() {
        (
            "Spotify authorization received",
            "Return to Buzz to finish connecting Spotify.",
        )
    } else {
        (
            "Spotify connection incomplete",
            "Return to Buzz to try again.",
        )
    };
    let response = callback_response(title, body);
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;

    result
}

async fn parse_spotify_token_response(
    response: reqwest::Response,
) -> Result<SpotifyTokenResponse, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("read Spotify token response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Spotify token request returned {status}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("parse Spotify token response: {e}"))
}

async fn exchange_code_for_token(
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
    client_id: &str,
    state: &AppState,
) -> Result<SpotifyTokenResponse, String> {
    let form = vec![
        ("client_id", client_id.to_string()),
        ("code", code.to_string()),
        ("code_verifier", code_verifier.to_string()),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri.to_string()),
    ];

    let response = state
        .http_client
        .post(SPOTIFY_TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Spotify OAuth token exchange couldn't complete: {e}"))?;
    parse_spotify_token_response(response).await
}

#[tauri::command]
pub fn get_spotify_status() -> Result<SpotifyStatus, String> {
    if spotify_client_id().is_none() {
        return Ok(status_from_credential(None));
    }

    Ok(status_from_credential(load_credential()?.as_ref()))
}

#[tauri::command]
pub async fn connect_spotify(state: State<'_, AppState>) -> Result<SpotifyStatus, String> {
    let client_id = spotify_client_id()
        .ok_or_else(|| "Set BUZZ_SPOTIFY_CLIENT_ID to enable Spotify.".to_string())?;
    let redirect_port = spotify_redirect_port();
    let listener = TcpListener::bind(("127.0.0.1", redirect_port))
        .await
        .map_err(|e| format!("bind Spotify OAuth callback on port {redirect_port}: {e}"))?;
    let redirect_uri = format!("http://127.0.0.1:{redirect_port}{OAUTH_CALLBACK_PATH}");
    let code_verifier = pkce_verifier();
    let state_token = oauth_state();
    let auth_url = oauth_authorization_url(
        &client_id,
        &redirect_uri,
        &state_token,
        &pkce_challenge(&code_verifier),
    )?;

    tauri_plugin_opener::open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("open Spotify authorization page: {e}"))?;

    let code = wait_for_oauth_callback(listener, &state_token).await?;
    let token =
        exchange_code_for_token(&code, &code_verifier, &redirect_uri, &client_id, &state).await?;
    let refresh_token = token.refresh_token.ok_or_else(|| {
        "Spotify did not return a refresh token. Disconnect and try again.".to_string()
    })?;
    let credential = SpotifyCredential {
        access_token: token.access_token,
        connected_at: now_ts(),
        expires_at: token.expires_in.map(|seconds| now_ts() + seconds),
        refresh_token,
        scope: token.scope,
        token_type: token.token_type,
    };
    save_credential(&credential)?;

    Ok(status_from_credential(Some(&credential)))
}

#[tauri::command]
pub fn disconnect_spotify() -> Result<SpotifyStatus, String> {
    credential_store().delete(SPOTIFY_CREDENTIAL_KEY)?;
    Ok(status_from_credential(None))
}

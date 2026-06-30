import { invokeTauri } from "@/shared/api/tauri";

export type SpotifyStatus = {
  configured: boolean;
  connected: boolean;
  connectedAt: number | null;
  scopes: string[];
};

type RawSpotifyStatus = {
  configured: boolean;
  connected: boolean;
  connected_at: number | null;
  scopes: string[];
};

function fromRawStatus(raw: RawSpotifyStatus): SpotifyStatus {
  return {
    configured: raw.configured,
    connected: raw.connected,
    connectedAt: raw.connected_at,
    scopes: raw.scopes,
  };
}

export async function getSpotifyStatus(): Promise<SpotifyStatus> {
  return fromRawStatus(
    await invokeTauri<RawSpotifyStatus>("get_spotify_status"),
  );
}

export async function connectSpotify(): Promise<SpotifyStatus> {
  return fromRawStatus(await invokeTauri<RawSpotifyStatus>("connect_spotify"));
}

export async function disconnectSpotify(): Promise<SpotifyStatus> {
  return fromRawStatus(
    await invokeTauri<RawSpotifyStatus>("disconnect_spotify"),
  );
}

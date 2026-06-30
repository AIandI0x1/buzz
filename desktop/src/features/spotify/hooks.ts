import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  connectSpotify,
  disconnectSpotify,
  getSpotifyStatus,
} from "@/features/spotify/api";

export const spotifyStatusQueryKey = ["spotify-status"] as const;

export function useSpotifyStatusQuery() {
  return useQuery({
    queryKey: spotifyStatusQueryKey,
    queryFn: getSpotifyStatus,
    staleTime: 60_000,
  });
}

export function useSpotifyConnectionMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: spotifyStatusQueryKey });
  };

  const connect = useMutation({
    mutationFn: connectSpotify,
    onSuccess: invalidate,
  });
  const disconnect = useMutation({
    mutationFn: disconnectSpotify,
    onSuccess: invalidate,
  });

  return { connect, disconnect };
}

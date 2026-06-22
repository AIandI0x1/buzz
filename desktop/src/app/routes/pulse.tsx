import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  parseProfilePanelView,
  type ProfilePanelView,
} from "@/features/profile/ui/UserProfilePanelUtils";
import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const PulseScreen = React.lazy(async () => {
  const module = await import("@/features/pulse/ui/PulseScreen");
  return { default: module.PulseScreen };
});

type PulseRouteSearch = {
  profile?: string;
  profileView?: Exclude<ProfilePanelView, "summary">;
};

function profileViewValue(
  value: unknown,
): Exclude<ProfilePanelView, "summary"> | undefined {
  const view = parseProfilePanelView(value);
  return view && view !== "summary" ? view : undefined;
}

function validatePulseSearch(
  search: Record<string, unknown>,
): PulseRouteSearch {
  return {
    profile:
      typeof search.profile === "string" && search.profile.length > 0
        ? search.profile
        : undefined,
    profileView: profileViewValue(search.profileView),
  };
}

export const Route = createFileRoute("/pulse")({
  validateSearch: validatePulseSearch,
  component: PulseRouteComponent,
});

function PulseRouteComponent() {
  usePreviewFeatureWarning("pulse");
  return (
    <React.Suspense
      fallback={<ViewLoadingFallback includeHeader kind="pulse" />}
    >
      <PulseScreen />
    </React.Suspense>
  );
}

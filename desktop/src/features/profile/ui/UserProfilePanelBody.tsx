import type * as React from "react";

import {
  auxiliaryPanelContentPaddingClass,
  auxiliaryPanelHeaderBodyOffsetClass,
} from "@/shared/layout/AuxiliaryPanelHeader";
import { cn } from "@/shared/lib/cn";

type UserProfilePanelBodyProps = {
  children: React.ReactNode;
  isDiagnosticsLikeView: boolean;
  isFloatingOverlay: boolean;
  isSplitLayout: boolean;
};

export function UserProfilePanelBody({
  children,
  isDiagnosticsLikeView,
  isFloatingOverlay,
  isSplitLayout,
}: UserProfilePanelBodyProps) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 px-4 pb-6",
        isDiagnosticsLikeView
          ? "flex flex-col overflow-hidden"
          : "overflow-y-auto",
        isSplitLayout && auxiliaryPanelContentPaddingClass,
        !isSplitLayout &&
          !isFloatingOverlay &&
          auxiliaryPanelHeaderBodyOffsetClass,
      )}
    >
      {children}
    </div>
  );
}

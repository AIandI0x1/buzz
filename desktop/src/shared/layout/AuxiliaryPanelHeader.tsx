import type * as React from "react";
import { ArrowLeft, X } from "lucide-react";

import { channelChrome } from "@/shared/layout/chromeLayout";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

type AuxiliaryPanelHeaderProps = React.ComponentProps<"div">;
type AuxiliaryPanelHeaderGroupProps = React.ComponentProps<"div"> & {
  backButtonAriaLabel?: string;
  backButtonTestId?: string;
  onBack?: () => void;
};
type AuxiliaryPanelHeaderActionsProps = {
  children: React.ReactNode;
};
type AuxiliaryPanelHeaderCloseButtonProps = {
  ariaLabel: string;
  onClose: () => void;
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
  testId?: string;
};
type AuxiliaryPanelHeaderTitleBlockProps = {
  subtitle?: React.ReactNode;
  subtitleTitle?: string;
  title: React.ReactNode;
};
type AuxiliaryPanelTitleProps = React.ComponentProps<"h2">;

export const auxiliaryPanelHeaderHeightClass = "h-13";
export const auxiliaryPanelHeaderMinHeightClass = "min-h-13";
export const auxiliaryPanelHeaderNegativeMarginClass = "-mb-13";
export const auxiliaryPanelHeaderBodyOffsetClass = "pt-13";
export const auxiliaryPanelHeaderRightPaddingClass = "pr-2";
export const auxiliaryPanelHeaderPaddingClass = `pl-5 ${auxiliaryPanelHeaderRightPaddingClass} py-2`;
export const auxiliaryPanelFloatingHeaderBaseClass =
  "flex cursor-default select-none items-center";
export const auxiliaryPanelFloatingHeaderSurfaceClass =
  "backdrop-blur-md supports-backdrop-filter:bg-background/70 dark:bg-background/70 dark:backdrop-blur-xl dark:supports-backdrop-filter:bg-background/55";
export const auxiliaryPanelFloatingHeaderBackdropClass = `pointer-events-none absolute inset-x-0 top-0 z-40 ${auxiliaryPanelHeaderHeightClass} bg-background/80 ${auxiliaryPanelFloatingHeaderSurfaceClass}`;
export const auxiliaryPanelFloatingHeaderClass = `relative z-50 ${auxiliaryPanelHeaderMinHeightClass} shrink-0 gap-3 bg-background/80 ${auxiliaryPanelHeaderPaddingClass} ${auxiliaryPanelFloatingHeaderSurfaceClass}`;
export const auxiliaryPanelFloatingHeaderSingleColumnClass = `relative ${auxiliaryPanelHeaderNegativeMarginClass} ${auxiliaryPanelHeaderMinHeightClass} shrink-0 gap-2.5 bg-background/80 ${auxiliaryPanelHeaderPaddingClass} ${auxiliaryPanelFloatingHeaderSurfaceClass}`;
export const auxiliaryPanelFloatingHeaderTransparentSingleColumnClass = `relative ${auxiliaryPanelHeaderNegativeMarginClass} ${auxiliaryPanelHeaderMinHeightClass} shrink-0 gap-2.5 bg-transparent ${auxiliaryPanelHeaderPaddingClass}`;

/** Compact title/action row for right auxiliary panels in split layouts. */
export function AuxiliaryPanelHeader({
  className,
  children,
  ...props
}: AuxiliaryPanelHeaderProps) {
  return (
    <div
      className={cn(
        "pointer-events-none relative z-30 bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/70 dark:bg-background/70 dark:backdrop-blur-xl dark:supports-backdrop-filter:bg-background/55",
        channelChrome.negativeMargin,
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "pointer-events-auto relative z-30 shrink-0 cursor-default select-none",
          auxiliaryPanelHeaderPaddingClass,
        )}
        data-tauri-drag-region
      >
        <div className="flex h-9 min-w-0 items-center gap-2.5">{children}</div>
      </div>
    </div>
  );
}

export const auxiliaryPanelContentPaddingClass = channelChrome.contentPadding;

export function AuxiliaryPanelHeaderGroup({
  backButtonAriaLabel = "Back",
  backButtonTestId,
  className,
  children,
  onBack,
  ...props
}: AuxiliaryPanelHeaderGroupProps) {
  return (
    <div
      className={cn("flex min-w-0 flex-1 items-center gap-1.5", className)}
      {...props}
    >
      {onBack ? (
        <Button
          aria-label={backButtonAriaLabel}
          // Header text needs a comfortable left inset, but a leading icon
          // should visually sit closer to the panel edge. Keep the padding
          // centralized on the header and pull only this shared button back.
          className="-ml-2 shrink-0"
          data-testid={backButtonTestId}
          onClick={onBack}
          size="icon"
          type="button"
          variant="outline"
        >
          <ArrowLeft />
        </Button>
      ) : null}
      {children}
    </div>
  );
}

export function AuxiliaryPanelHeaderActions({
  children,
}: AuxiliaryPanelHeaderActionsProps) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">{children}</div>
  );
}

export function AuxiliaryPanelHeaderCloseButton({
  ariaLabel,
  onClose,
  onPointerDown,
  testId,
}: AuxiliaryPanelHeaderCloseButtonProps) {
  return (
    <Button
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onClose}
      onPointerDown={onPointerDown}
      size="icon"
      type="button"
      variant="ghost"
    >
      <X />
    </Button>
  );
}

export function AuxiliaryPanelHeaderTitleBlock({
  subtitle,
  subtitleTitle,
  title,
}: AuxiliaryPanelHeaderTitleBlockProps) {
  if (!subtitle) {
    return <AuxiliaryPanelTitle>{title}</AuxiliaryPanelTitle>;
  }

  return (
    <div className="min-w-0 flex-1">
      <AuxiliaryPanelTitle className="translate-y-0 leading-5">
        {title}
      </AuxiliaryPanelTitle>
      <p
        className="min-w-0 truncate font-mono text-2xs text-muted-foreground"
        title={subtitleTitle}
      >
        {subtitle}
      </p>
    </div>
  );
}

export function AuxiliaryPanelTitle({
  className,
  children,
  ...props
}: AuxiliaryPanelTitleProps) {
  return (
    <h2
      className={cn(
        "min-w-0 flex-1 translate-y-px truncate text-base font-semibold leading-6 tracking-tight",
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  );
}

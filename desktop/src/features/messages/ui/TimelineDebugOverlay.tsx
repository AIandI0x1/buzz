import * as React from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

import type { VirtualTimelineRow } from "@/features/messages/lib/buildVirtualTimelineRows";

// ─────────────────────────────────────────────────────────────────────────────
// SHIP-THEN-RIP debug overlay (Phase 2 virtualization). Read-only telemetry
// panel for watching the virtualizer behave in the running app.
//
// RIP-OUT = delete this file + the single `<TimelineDebugOverlay … />` line in
// MessageTimeline.tsx. Nothing else references it; it only READS state the hook
// and virtualizer already expose, so removal leaves zero residue and there is
// zero risk to the load-bearing scroll path.
// ─────────────────────────────────────────────────────────────────────────────

type TimelineDebugOverlayProps = {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  rows: VirtualTimelineRow[];
  overscan: number;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  newMessageCount: number;
  highlightedMessageId: string | null;
  searchActiveMessageId: string | null;
  targetMessageId: string | null;
};

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 tabular-nums">
      <span className="text-[10px] uppercase tracking-wide text-emerald-300/60">
        {label}
      </span>
      <span className="font-mono text-[11px] text-emerald-100">{value}</span>
    </div>
  );
}

export function TimelineDebugOverlay({
  virtualizer,
  rows,
  overscan,
  scrollContainerRef,
  isAtBottom,
  newMessageCount,
  highlightedMessageId,
  searchActiveMessageId,
  targetMessageId,
}: TimelineDebugOverlayProps) {
  // Re-render on scroll so scrollTop / visible range stay live. The virtualizer
  // already re-renders the host on scroll, but a deferred snapshot can lag a
  // raw scroll; this local tick keeps the panel honest without touching the
  // scroll path. Listener is passive + read-only.
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }
    const onScroll = () => force();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = Math.round(virtualizer.getTotalSize());
  const scrollTop = Math.round(scrollContainerRef.current?.scrollTop ?? 0);
  const clientHeight = scrollContainerRef.current?.clientHeight ?? 0;

  const firstIndex = virtualItems[0]?.index ?? -1;
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
  const renderedCount = virtualItems.length;
  const dividerRows = rows.filter((row) => row.kind === "day-divider").length;
  const messageRows = rows.length - dividerRows;

  // Measured heights of the currently rendered window — exposes how far the
  // estimate-vs-measured correction has settled (the variable-height path).
  const sizes = virtualItems.map((item) => Math.round(item.size));
  const minSize = sizes.length ? Math.min(...sizes) : 0;
  const maxSize = sizes.length ? Math.max(...sizes) : 0;

  const activeJump =
    targetMessageId ?? searchActiveMessageId ?? highlightedMessageId ?? "—";
  const jumpKind = targetMessageId
    ? "deep-link"
    : searchActiveMessageId
      ? "find"
      : highlightedMessageId
        ? "highlight"
        : "none";

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-2 top-2 z-50 w-56 select-none rounded-lg border border-emerald-400/30 bg-black/80 px-3 py-2 font-mono shadow-lg backdrop-blur-sm"
      data-testid="timeline-debug-overlay"
    >
      <div className="mb-1.5 flex items-center justify-between border-b border-emerald-400/20 pb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
        <span>▚ virtualizer</span>
        <span className="text-emerald-300/50">debug</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <Stat label="rendered" value={`${renderedCount} / ${rows.length}`} />
        <Stat label="msg · div" value={`${messageRows} · ${dividerRows}`} />
        <Stat label="overscan" value={overscan} />
        <Stat
          label="visible idx"
          value={firstIndex < 0 ? "—" : `${firstIndex}–${lastIndex}`}
        />
        <Stat
          label="row h (min–max)"
          value={sizes.length ? `${minSize}–${maxSize}px` : "—"}
        />
        <Stat label="totalSize" value={`${totalSize}px`} />
        <Stat label="scrollTop" value={`${scrollTop}px`} />
        <Stat label="clientH" value={`${Math.round(clientHeight)}px`} />
        <Stat
          label="atBottom"
          value={
            <span
              className={isAtBottom ? "text-emerald-300" : "text-amber-300"}
            >
              {isAtBottom ? "yes" : "no"}
            </span>
          }
        />
        <Stat
          label="newCount"
          value={
            <span
              className={newMessageCount > 0 ? "text-amber-300" : undefined}
            >
              {newMessageCount}
            </span>
          }
        />
        <Stat label={`jump · ${jumpKind}`} value={truncate(activeJump)} />
      </div>
    </div>
  );
}

function truncate(value: string): string {
  if (value.length <= 10) {
    return value;
  }
  return `${value.slice(0, 6)}…${value.slice(-3)}`;
}

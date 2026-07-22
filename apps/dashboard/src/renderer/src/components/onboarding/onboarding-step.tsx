/**
 * Shared frame for a working onboarding step: a scrolling content region with the footer
 * buttons pinned to the bottom. Because every step uses this, the footer sits at the same
 * vertical position across steps (mirroring the pinned stepper at the top) — the buttons never
 * shift as content height changes, and overflow is confined to one scroll region.
 *
 * `fill` mode is for steps whose body manages its own height + internal scroll (the Offline
 * step's RegionPicker: pinned map, scrolling list). Default mode vertically centers shorter
 * content and scrolls the whole body when it's tall.
 */
export function OnboardingStep({
  children,
  footer,
  fill = false
}: {
  children: React.ReactNode;
  footer: React.ReactNode;
  fill?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 flex-col">
      {fill ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      ) : (
        // A scroll region for tall content, with -mx-3.5/px-3.5 gutters so content that
        // overhangs its own box has room instead of tripping the scroll box's overflow-x:
        // selection rings and focus outlines (ink, left side) and, crucially, the Switch's
        // transparent enlarged hit-target (after:-inset-x-3 ≈ 11px, right side, pinned flush
        // by justify-between). The negative margin keeps the inner content aligned with the
        // footer edge. my-auto centers short content while still letting the top scroll into
        // view when content is taller than the frame.
        <div className="-mx-3.5 min-h-0 min-w-0 flex-1 overflow-y-auto px-3.5">
          <div className="flex min-h-full flex-col">
            <div className="my-auto flex w-full min-w-0 flex-col">{children}</div>
          </div>
        </div>
      )}
      <div className="shrink-0 pt-8">{footer}</div>
    </div>
  );
}

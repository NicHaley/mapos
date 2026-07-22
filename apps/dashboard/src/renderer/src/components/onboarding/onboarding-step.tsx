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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">{children}</div>
      ) : (
        // overflow-x-hidden keeps a too-wide child from turning the body into a horizontal
        // scroller (which would shift the content sideways). my-auto centers short content while
        // still allowing the top to scroll into view when content is taller than the frame.
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="flex min-h-full flex-col">
            <div className="my-auto flex w-full min-w-0 flex-col">{children}</div>
          </div>
        </div>
      )}
      <div className="shrink-0 pt-8">{footer}</div>
    </div>
  );
}

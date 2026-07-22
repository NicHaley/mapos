import { type VariantProps, cva } from "class-variance-authority";

import { cn } from "@mapos/ui/lib/utils";

// The app's translucent "glass" surfaces. The variant owns the surface itself
// (fill + blur + border/ring/shadow); call sites keep layout — positioning,
// rounding shape, padding, gap — in className. `cluster` is the exception: it
// bakes full toolbar layout since every cluster site wants it identical.
const surfaceVariants = cva("", {
  variants: {
    variant: {
      // Floating translucent toolbar holding ghost icon buttons (over map / sidebar).
      cluster: "flex h-8 items-center rounded-lg bg-sidebar/60 shadow-sm backdrop-blur-sm",
      // Glass info pill over the map (coverage / status) — same sidebar glass and
      // shadow as the clusters. Shape + padding at call site.
      pill: "flex items-center bg-sidebar/60 shadow-sm backdrop-blur-sm",
      // Large translucent container surface (chat pane, place card, dialogs).
      panel: "bg-sidebar/95 backdrop-blur-md",
      // Glass popover surface (matches PopoverContent / dropdown recipe): translucent
      // fill plus a viewport-blur layer behind the content. Needs a rounded corner on
      // the element for `before:rounded-[inherit]`.
      popover:
        "relative bg-popover/70 ring-1 ring-foreground/10 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150"
    }
  },
  defaultVariants: {
    variant: "cluster"
  }
});

function Surface({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof surfaceVariants>) {
  return (
    <div data-slot="surface" className={cn(surfaceVariants({ variant }), className)} {...props} />
  );
}

export { Surface, surfaceVariants };

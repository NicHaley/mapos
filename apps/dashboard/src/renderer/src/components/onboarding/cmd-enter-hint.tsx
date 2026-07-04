import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { cn } from "@mapos/ui/lib/utils";

/**
 * The `⌘↵` shortcut hint shown inside onboarding primary buttons. `tone="primary"` tints the
 * keys for use on a filled primary button (where the default muted style would clash).
 */
export function CmdEnterHint({
  tone = "default",
  className
}: {
  tone?: "default" | "primary";
  className?: string;
}): React.JSX.Element {
  return (
    <KbdGroup className={cn("ml-1", className)}>
      <Kbd
        className={cn(tone === "primary" && "bg-primary-foreground/15 text-primary-foreground/80")}
      >
        ⌘
      </Kbd>
      <Kbd
        className={cn(tone === "primary" && "bg-primary-foreground/15 text-primary-foreground/80")}
      >
        ↵
      </Kbd>
    </KbdGroup>
  );
}

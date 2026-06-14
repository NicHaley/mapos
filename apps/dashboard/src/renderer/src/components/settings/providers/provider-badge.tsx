import { cn } from "@mapos/ui/lib/utils";
import { WrenchIcon } from "lucide-react";
import type { IconType } from "react-icons";
import { SiAnthropic, SiGithub, SiGoogle, SiOpenai } from "react-icons/si";

/** Per-brand icon + accent for the known catalog providers we recognise. */
const BRANDS: Record<string, { Icon: IconType; styles: string }> = {
  anthropic: { Icon: SiAnthropic, styles: "bg-[#d97757] text-white" },
  openai: { Icon: SiOpenai, styles: "bg-foreground/90 text-background" },
  "openai-codex": { Icon: SiOpenai, styles: "bg-foreground/90 text-background" },
  "github-copilot": { Icon: SiGithub, styles: "bg-foreground/90 text-background" },
  google: { Icon: SiGoogle, styles: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  "google-vertex": { Icon: SiGoogle, styles: "bg-blue-500/15 text-blue-600 dark:text-blue-400" }
};

const SIZES = {
  sm: { wrapper: "size-5 rounded", icon: "size-3", text: "text-[10px]" },
  md: { wrapper: "size-7 rounded-md", icon: "size-4", text: "text-xs" },
  lg: { wrapper: "size-11 rounded-lg", icon: "size-6", text: "text-base" }
} as const;

/**
 * Glanceable provider glyph. Recognised catalog providers get their brand mark; unknown catalog
 * providers fall back to a lettered chip; custom endpoints get a wrench.
 */
export function ProviderBadge({
  knownProvider,
  label,
  size = "md"
}: {
  /** Pi catalog name (e.g. "anthropic"); null/undefined for custom providers. */
  knownProvider?: string | null;
  /** Provider label, used for the lettered fallback chip. */
  label?: string;
  size?: "sm" | "md" | "lg";
}): React.JSX.Element {
  const s = SIZES[size];
  const brand = knownProvider ? BRANDS[knownProvider] : undefined;

  let content: React.ReactNode;
  let styles: string;
  if (brand) {
    content = <brand.Icon className={s.icon} />;
    styles = brand.styles;
  } else if (knownProvider) {
    content = (label ?? knownProvider).charAt(0).toUpperCase();
    styles = "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400";
  } else {
    content = <WrenchIcon className={s.icon} />;
    styles = "bg-muted text-muted-foreground";
  }

  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold",
        s.wrapper,
        s.text,
        styles
      )}
    >
      {content}
    </span>
  );
}

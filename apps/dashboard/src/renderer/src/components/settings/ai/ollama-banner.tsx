import { Button, buttonVariants } from "@mapos/ui/components/button";
import { ExternalLinkIcon } from "lucide-react";

export function OllamaBanner({ onRecheck }: { onRecheck: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2.5 text-sm">
      <div className="flex flex-col">
        <span className="font-medium">Ollama isn't running</span>
        <span className="text-xs text-muted-foreground">
          Local models require Ollama. Install it once and we'll detect it here.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <a
          href="https://ollama.com/download"
          target="_blank"
          rel="noreferrer noopener"
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          Install
          <ExternalLinkIcon className="size-3.5" />
        </a>
        <Button variant="ghost" size="sm" onClick={onRecheck}>
          Re-check
        </Button>
      </div>
    </div>
  );
}

import { Alert, AlertDescription, AlertTitle } from "@mapos/ui/components/alert";
import { Button } from "@mapos/ui/components/button";
import { ArrowLeftIcon, CheckIcon, FolderIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { CmdEnterHint } from "./cmd-enter-hint";
import type { VaultDraft } from "./vault-step";

export function DoneStep({
  vaultDraft,
  onBack,
  onComplete
}: {
  vaultDraft: VaultDraft | null;
  onBack: () => void;
  onComplete: () => Promise<{ ok: true } | { ok: false; error: string }>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleOpen(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await onComplete();
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
      }
      // On success the main process reloads the renderer — no further work needed.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  useCmdEnter(() => void handleOpen(), !busy && !!vaultDraft);

  const vaultLabel =
    vaultDraft?.kind === "create"
      ? vaultDraft.targetPath
      : vaultDraft?.kind === "existing"
        ? vaultDraft.path
        : null;

  return (
    <div className="flex flex-col items-center text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <CheckIcon className="size-7" />
      </div>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">You're all set</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Drop a file in your vault, drag the map to look around, or open the chat panel and
        ask MapOS a question.
      </p>
      {vaultLabel && vaultDraft && (
        <Alert className="mt-6 text-left has-[>svg]:grid-cols-[auto_minmax(0,1fr)]">
          <FolderIcon />
          <AlertTitle>{vaultDraft.kind === "create" ? "New vault" : "Existing vault"}</AlertTitle>
          <AlertDescription className="truncate font-mono" title={vaultLabel}>
            {vaultLabel}
          </AlertDescription>
        </Alert>
      )}
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <Button
        size="lg"
        className="mt-8 w-full"
        onClick={() => void handleOpen()}
        disabled={busy || !vaultDraft}
      >
        {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
        Open MapOS
        <CmdEnterHint tone="primary" />
      </Button>
      <Button variant="ghost" className="mt-2" onClick={onBack} disabled={busy}>
        <ArrowLeftIcon className="size-4" />
        Back
      </Button>
    </div>
  );
}

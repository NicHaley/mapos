import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@mapos/ui/components/alert-dialog";
import { Button } from "@mapos/ui/components/button";
import type { AiState, KnownProviderOption, ProviderView } from "@shared/ai-providers";
import { ArrowLeftIcon, CheckIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { AddProviderSheet } from "../settings/providers/add-provider-sheet";
import {
  type ConnectTarget,
  KnownProviderAuthSheet
} from "../settings/providers/known-provider-auth-sheet";
import { ModelSwitcher } from "../settings/providers/model-switcher";
import { ProviderEditorSheet } from "../settings/providers/provider-editor-sheet";
import { ProviderRow } from "../settings/providers/provider-row";
import { ProvidersEmptyState } from "../settings/providers/providers-empty-state";
import { CmdEnterHint } from "./cmd-enter-hint";

/** How a connect drawer is opened: a not-yet-persisted catalog entry, or an existing row by id. */
type ConnectState = { kind: "new"; name: string; label: string } | { kind: "existing"; id: string };

/**
 * Onboarding's take on the AI Models settings page: it reuses the same empty-state picker, connect
 * drawers, and provider row so the two surfaces stay consistent. Pared down for first-run — only one
 * provider is added (no "Add provider" button), and model selection uses the compact switcher rather
 * than the settings hero. Additional or custom/local endpoints are managed later in Settings.
 */
export function AiStep({
  onBack,
  onNext
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const [state, setState] = useState<AiState | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorProvider, setEditorProvider] = useState<ProviderView | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [connectTarget, setConnectTarget] = useState<ConnectState | null>(null);

  const [pendingDelete, setPendingDelete] = useState<ProviderView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState(await window.api.ai.getState());
  }, []);

  // Open the connect drawer for a catalog provider without persisting it yet — the row is written
  // only when the user actually connects (handled inside the drawer).
  const openNewConnect = useCallback((name: string, label: string) => {
    setConnectTarget({ kind: "new", name, label });
    setAddOpen(false);
    setAuthOpen(true);
  }, []);

  const openExistingConnect = useCallback((id: string) => {
    setConnectTarget({ kind: "existing", id });
    setAuthOpen(true);
  }, []);

  useEffect(() => {
    void reload();
    return window.api.ai.onChanged(() => void reload());
  }, [reload]);

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await window.api.ai.removeProvider(pendingDelete.id);
    setDeleting(false);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }
    setPendingDelete(null);
    await reload();
  }

  const active = state?.active ?? null;
  const hasConnected = state?.providers.some((p) => p.auth.configured) ?? false;
  const addedKnown = new Set(
    state?.providers.map((p) => p.knownProvider).filter((n): n is string => !!n) ?? []
  );
  // Resolve the connect-drawer target from live state so an existing row reflects connect/disconnect
  // without staleness; a "new" target carries its own catalog name/label.
  const connectDrawerTarget: ConnectTarget | null =
    !connectTarget || !state
      ? null
      : connectTarget.kind === "new"
        ? { kind: "new", name: connectTarget.name, label: connectTarget.label }
        : (() => {
            const p = state.providers.find((x) => x.id === connectTarget.id);
            return p ? { kind: "existing", provider: p } : null;
          })();

  // A model is active once a provider is connected; that's the real "ready to continue" signal.
  const primaryEnabled = !!active;
  useCmdEnter(() => onNext(), primaryEnabled);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Connect an AI provider</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Use Claude, GPT and more over the network — sign in or paste an API key. Need a custom or
        local endpoint (Ollama, LM Studio, a proxy)? Add one anytime in Settings → AI Models.
      </p>

      <div className="mt-6 flex flex-col gap-2">
        {!state ? (
          <div className="flex items-center gap-2 py-2 text-muted-foreground text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading providers…
          </div>
        ) : state.providers.length === 0 ? (
          <ProvidersEmptyState
            showHeading={false}
            onPick={openNewConnect}
            onCustom={() => {
              setEditorProvider(null);
              setEditorOpen(true);
            }}
            onBrowseAll={() => setAddOpen(true)}
          />
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-lg border">
            {state.providers.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                onEdit={() => {
                  if (p.knownProvider) {
                    openExistingConnect(p.id);
                  } else {
                    setEditorProvider(p);
                    setEditorOpen(true);
                  }
                }}
                onDelete={() => {
                  setDeleteError(null);
                  setPendingDelete(p);
                }}
              />
            ))}
          </div>
        )}

        {state && hasConnected && (
          <div className="mt-1 flex items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <div className="font-medium text-sm">Model</div>
              <div className="text-muted-foreground text-xs">
                {active ? (
                  <span className="flex items-center gap-1.5">
                    <CheckIcon className="size-3.5 text-emerald-500" />
                    Switch anytime in chat or Settings.
                  </span>
                ) : (
                  "Pick a model to finish setup."
                )}
              </div>
            </div>
            <ModelSwitcher state={state} onSelected={() => void reload()} />
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button size="lg" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button size="lg" variant="ghost" onClick={onNext}>
            Set up later
          </Button>
          <Button size="lg" disabled={!primaryEnabled} onClick={onNext}>
            Continue
            <CmdEnterHint tone="primary" />
          </Button>
        </div>
      </div>

      <AddProviderSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        addedKnownProviders={addedKnown}
        onPickKnown={(option: KnownProviderOption) => openNewConnect(option.name, option.label)}
        onChooseCustom={() => {
          setAddOpen(false);
          setEditorProvider(null);
          setEditorOpen(true);
        }}
      />

      <ProviderEditorSheet
        open={editorOpen}
        onOpenChange={setEditorOpen}
        provider={editorProvider}
        onSaved={() => void reload()}
      />

      <KnownProviderAuthSheet
        open={authOpen}
        onOpenChange={setAuthOpen}
        target={connectDrawerTarget}
        onChanged={() => void reload()}
        onConnected={() => void reload()}
      />

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(o) => {
          if (!o && !deleting) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this provider?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.label || "This provider"} will be removed from MapOS. No remote data
              is affected.
            </AlertDialogDescription>
            {deleteError ? (
              <AlertDialogDescription className="text-destructive">
                {deleteError}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (deleting) return;
                setPendingDelete(null);
                setDeleteError(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

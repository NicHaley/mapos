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
import { Loader2Icon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AddProviderSheet } from "./add-provider-sheet";
import { CapabilityBadges } from "./capability-badges";
import { ChangeModelSheet } from "./change-model-sheet";
import { type ConnectTarget, KnownProviderAuthSheet } from "./known-provider-auth-sheet";
import { ProviderBadge } from "./provider-badge";
import { ProviderEditorSheet } from "./provider-editor-sheet";

/** How a connect drawer is opened: a not-yet-persisted catalog entry, or an existing row by id. */
type ConnectState = { kind: "new"; name: string; label: string } | { kind: "existing"; id: string };

/** The popular catalog providers offered in the zero-provider empty state. */
const POPULAR_PROVIDERS: { name: string; label: string }[] = [
  { name: "anthropic", label: "Anthropic" },
  { name: "openai-codex", label: "Codex" },
  { name: "github-copilot", label: "Copilot" }
];

/**
 * Shown when no providers are configured yet — a guided path that opens the connect drawer for a
 * popular catalog provider (or a custom endpoint) so the list never dead-ends on an empty box.
 */
function ProvidersEmptyState({
  onPick,
  onCustom,
  onBrowseAll
}: {
  onPick: (name: string, label: string) => void;
  onCustom: () => void;
  onBrowseAll: () => void;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      <div className="font-medium text-sm">No providers yet</div>
      <p className="mt-0.5 text-muted-foreground text-xs">Add a provider to pick a model.</p>
      <div className="mt-5 flex items-start justify-center gap-2">
        {POPULAR_PROVIDERS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => onPick(p.name, p.label)}
            className="flex w-20 flex-col items-center gap-2 rounded-lg p-2 transition-colors hover:bg-accent/40"
          >
            <ProviderBadge knownProvider={p.name} label={p.label} size="lg" />
            <span className="text-xs font-medium leading-tight">{p.label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={onCustom}
          className="flex w-20 flex-col items-center gap-2 rounded-lg p-2 transition-colors hover:bg-accent/40"
        >
          <ProviderBadge label="Custom" size="lg" />
          <span className="text-xs font-medium leading-tight">Custom</span>
        </button>
      </div>
      <Button variant="link" size="sm" className="mt-4" onClick={onBrowseAll}>
        See all providers
      </Button>
    </div>
  );
}

/** A glanceable connection-status label for a Sources row. */
function ProviderStatus({ p }: { p: ProviderView }): React.JSX.Element {
  const ok = "font-medium text-emerald-600 text-xs dark:text-emerald-400";
  const muted = "text-muted-foreground text-xs";
  if (p.knownProvider) {
    if (p.auth.configured) {
      return <span className={ok}>{p.auth.method === "oauth" ? "Signed in" : "API key set"}</span>;
    }
    return <span className={muted}>Not connected</span>;
  }
  if (p.auth.method === "none") return <span className={muted}>No auth</span>;
  return p.auth.configured ? (
    <span className={ok}>Connected</span>
  ) : (
    <span className={muted}>No token</span>
  );
}

export function AiModelTab(): React.JSX.Element {
  const [state, setState] = useState<AiState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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

  // After a provider connects, prompt model selection if none is set yet — the second half of the
  // "configure provider → select model" flow. No curated default; the user picks explicitly. Delay
  // so the connect drawer's slide-out completes before the picker slides in (shared sheet slot).
  const promptModelAfterConnect = useCallback(async (): Promise<void> => {
    const next = await window.api.ai.getState();
    setState(next);
    if (!next.active && next.providers.some((p) => p.auth.configured)) {
      window.setTimeout(() => setPickerOpen(true), 240);
    }
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

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }

  const active = state.active;
  const activeProvider = active
    ? state.providers.find((p) => p.id === active.providerId)
    : undefined;
  const hasConnectedProvider = state.providers.some((p) => p.auth.configured);
  const addedKnown = new Set(
    state.providers.map((p) => p.knownProvider).filter((n): n is string => !!n)
  );
  // Resolve the connect-drawer target from live state so an existing row reflects connect/disconnect
  // without staleness; a "new" target carries its own catalog name/label.
  const connectDrawerTarget: ConnectTarget | null = !connectTarget
    ? null
    : connectTarget.kind === "new"
      ? { kind: "new", name: connectTarget.name, label: connectTarget.label }
      : (() => {
          const p = state.providers.find((x) => x.id === connectTarget.id);
          return p ? { kind: "existing", provider: p } : null;
        })();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-medium text-base">AI Models</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          The model MapOS uses by default. Switch anytime in a chat.
        </p>

        {/* No model hero while there are no providers — the Providers picker below is the single
            call to action, so we don't repeat "add a provider" twice. */}
        {state.providers.length > 0 &&
          (active ? (
            <div className="mt-3 rounded-lg border bg-muted/30 p-4">
              <div className="font-medium text-emerald-500 text-xs uppercase tracking-wide">
                Active model
              </div>
              <div className="mt-2.5 flex items-center gap-3">
                <ProviderBadge
                  knownProvider={activeProvider?.knownProvider}
                  label={active.providerLabel}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-base">{active.model}</div>
                  <div className="text-muted-foreground text-sm">via {active.providerLabel}</div>
                </div>
                <Button onClick={() => setPickerOpen(true)}>Change model</Button>
              </div>
              <div className="my-3 border-t" />
              <CapabilityBadges caps={active.capabilities} />
            </div>
          ) : hasConnectedProvider ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
              <div className="min-w-0">
                <div className="font-medium text-sm">No model selected</div>
                <div className="text-muted-foreground text-sm">
                  Choose a model to start using MapOS's AI.
                </div>
              </div>
              <Button onClick={() => setPickerOpen(true)}>Choose a model</Button>
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed bg-muted/30 p-4">
              <div className="font-medium text-sm">No model selected</div>
              <div className="text-muted-foreground text-sm">
                Connect a provider below to choose a model.
              </div>
            </div>
          ))}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-medium text-sm">Providers</h3>
            <p className="text-muted-foreground text-xs">
              Downloads and connected accounts. Powered by Pi.
            </p>
          </div>
          {state.providers.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <PlusIcon className="size-4" />
              Add provider
            </Button>
          )}
        </div>

        {state.providers.length === 0 ? (
          <ProvidersEmptyState
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
              <div
                key={p.id}
                className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40"
              >
                <ProviderBadge knownProvider={p.knownProvider} label={p.label} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-sm">{p.label}</div>
                  {!p.knownProvider && (
                    <div className="truncate text-muted-foreground text-xs">{p.baseUrl}</div>
                  )}
                </div>
                <ProviderStatus p={p} />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={p.knownProvider ? "Manage connection" : "Edit provider"}
                  onClick={() => {
                    if (p.knownProvider) {
                      openExistingConnect(p.id);
                    } else {
                      setEditorProvider(p);
                      setEditorOpen(true);
                    }
                  }}
                >
                  <PencilIcon className="size-4 text-muted-foreground" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete provider"
                  onClick={() => {
                    setDeleteError(null);
                    setPendingDelete(p);
                  }}
                >
                  <Trash2Icon className="size-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ChangeModelSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        state={state}
        onSelected={reload}
      />

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
        onSaved={() => void promptModelAfterConnect()}
      />

      <KnownProviderAuthSheet
        open={authOpen}
        onOpenChange={setAuthOpen}
        target={connectDrawerTarget}
        onChanged={() => void reload()}
        onConnected={() => void promptModelAfterConnect()}
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

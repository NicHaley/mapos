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
import { cn } from "@mapos/ui/lib/utils";
import { type AiState, EMBEDDED_PROVIDER_ID, type ProviderView } from "@shared/ai-providers";
import { ChevronDownIcon, Loader2Icon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AddProviderSheet } from "./add-provider-sheet";
import { CapabilityBadges } from "./capability-badges";
import { ChangeModelSheet } from "./change-model-sheet";
import { KnownProviderAuth } from "./known-provider-auth";
import { LocalAiSection } from "./local-ai-section";
import { ProviderBadge } from "./provider-badge";
import { ProviderEditorSheet } from "./provider-editor-sheet";

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
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorProvider, setEditorProvider] = useState<ProviderView | null>(null);

  const [pendingDelete, setPendingDelete] = useState<ProviderView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState(await window.api.ai.getState());
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
  const activeProvider =
    active && active.providerId !== EMBEDDED_PROVIDER_ID
      ? state.providers.find((p) => p.id === active.providerId)
      : undefined;
  const addedKnown = new Set(
    state.providers.map((p) => p.knownProvider).filter((n): n is string => !!n)
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-medium text-base">AI Models</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          The model MapOS uses by default. Switch anytime in a chat.
        </p>

        {active ? (
          <div className="mt-3 rounded-lg border bg-muted/30 p-4">
            <div className="font-medium text-emerald-500 text-xs uppercase tracking-wide">
              Active model
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              <ProviderBadge
                knownProvider={activeProvider?.knownProvider}
                label={active.providerLabel}
                local={active.providerId === EMBEDDED_PROVIDER_ID}
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
        ) : (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
            <div className="min-w-0">
              <div className="font-medium text-sm">No model selected</div>
              <div className="text-muted-foreground text-sm">
                Choose a model to start using MapOS's AI.
              </div>
            </div>
            <Button onClick={() => setPickerOpen(true)}>Choose a model</Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-medium text-sm">Sources</h3>
            <p className="text-muted-foreground text-xs">
              Downloads & connected accounts. Powered by Pi.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <PlusIcon className="size-4" />
            Add provider
          </Button>
        </div>

        <LocalAiSection active={active} onActiveChanged={reload} />

        {state.providers.map((p) => {
          const expandable = !!p.knownProvider;
          const expanded = expandedId === p.id;
          const toggle = (): void => setExpandedId((cur) => (cur === p.id ? null : p.id));
          return (
            <div key={p.id} className="overflow-hidden rounded-lg border">
              <div
                role={expandable ? "button" : undefined}
                tabIndex={expandable ? 0 : undefined}
                onClick={expandable ? toggle : undefined}
                onKeyDown={
                  expandable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle();
                        }
                      }
                    : undefined
                }
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 transition-colors",
                  expandable && "cursor-pointer hover:bg-accent/40"
                )}
              >
                <ProviderBadge knownProvider={p.knownProvider} label={p.label} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-sm">{p.label}</div>
                  {!p.knownProvider && (
                    <div className="truncate text-muted-foreground text-xs">{p.baseUrl}</div>
                  )}
                </div>
                <ProviderStatus p={p} />
                {!p.knownProvider && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Edit provider"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditorProvider(p);
                      setEditorOpen(true);
                    }}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete provider"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteError(null);
                    setPendingDelete(p);
                  }}
                >
                  <Trash2Icon className="size-4" />
                </Button>
                {expandable && (
                  <ChevronDownIcon
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground/60 transition-transform",
                      expanded && "rotate-180"
                    )}
                    aria-hidden
                  />
                )}
              </div>

              {expandable && expanded && (
                <div className="border-t bg-muted/20">
                  <KnownProviderAuth provider={p} onChanged={() => void reload()} />
                </div>
              )}
            </div>
          );
        })}
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
        onAddKnown={async (name) => {
          const result = await window.api.ai.addKnownProvider(name);
          await reload();
          if (result.ok) {
            setAddOpen(false);
            setExpandedId(result.id);
          }
        }}
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
              {pendingDelete?.label || "This provider"} will be removed from MapOS. No remote data is
              affected.
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

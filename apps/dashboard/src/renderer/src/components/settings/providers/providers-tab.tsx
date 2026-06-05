import { Alert, AlertAction, AlertTitle } from "@mapos/ui/components/alert";
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
import type { ModelCapabilities } from "@shared/ai-models";
import type { AiState, FetchedModel, ProviderView } from "@shared/ai-providers";
import {
  CheckIcon,
  ChevronDownIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ProviderBadge } from "./provider-badge";
import { AddProviderSheet } from "./add-provider-sheet";
import { CapabilityBadges } from "./capability-badges";
import { KnownProviderAuth } from "./known-provider-auth";
import { LocalAiSection } from "./local-ai-section";
import { ProviderEditorSheet } from "./provider-editor-sheet";

type ModelsFetch = { loading: boolean; error: string | null; models: FetchedModel[] | null };

function providerKind(p: ProviderView): "cloud" | "local" | "custom" {
  if (p.preset) return "local";
  return p.knownProvider ? "cloud" : "custom";
}

function authLabel(p: ProviderView): string {
  if (p.knownProvider) {
    if (p.auth.configured) return p.auth.method === "oauth" ? "Signed in" : "API key set";
    return p.auth.oauthAvailable ? "Sign in or add a key" : "API key required";
  }
  if (p.auth.method === "none") return "No auth";
  return p.auth.configured ? "Token set" : "No token";
}

export function ProvidersTab(): React.JSX.Element {
  const [state, setState] = useState<AiState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, ModelsFetch>>({});
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorProvider, setEditorProvider] = useState<ProviderView | null>(null);

  const [pendingDelete, setPendingDelete] = useState<ProviderView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState(await window.api.ai.getState());
  }, []);

  const fetchModels = useCallback(async (providerId: string) => {
    setModels((m) => ({
      ...m,
      [providerId]: { loading: true, error: null, models: m[providerId]?.models ?? null }
    }));
    const result = await window.api.ai.listModels(providerId);
    setModels((m) => ({
      ...m,
      [providerId]: result.ok
        ? { loading: false, error: null, models: result.models }
        : { loading: false, error: result.error, models: null }
    }));
  }, []);

  useEffect(() => {
    void reload();
    return window.api.ai.onChanged(() => void reload());
  }, [reload]);

  function toggleExpand(providerId: string): void {
    setExpandedId((cur) => {
      const next = cur === providerId ? null : providerId;
      if (next && !models[providerId]) void fetchModels(providerId);
      return next;
    });
  }

  async function selectModel(
    providerId: string,
    model: string,
    capabilities: ModelCapabilities
  ): Promise<void> {
    const key = `${providerId}:${model}`;
    setPendingSelect(key);
    const result = await window.api.ai.setActive(providerId, model, capabilities);
    setPendingSelect(null);
    if (result.ok) await reload();
  }

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
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }

  const active = state.active;
  const addedKnown = new Set(
    state.providers.map((p) => p.knownProvider).filter((n): n is string => !!n)
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-medium">AI model</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Choose where MapOS's AI runs. Local models run privately on this Mac; cloud and custom
          providers connect over the network.
        </p>
        {active ? (
          <Alert className="mt-3 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <AlertTitle className="truncate">
                Using <span className="font-mono">{active.model}</span> via {active.providerLabel}
              </AlertTitle>
              <div className="mt-1.5">
                <CapabilityBadges caps={active.capabilities} />
              </div>
            </div>
            <AlertAction>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.api.ai.clearActive().then(() => reload())}
              >
                Clear
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <Alert className="mt-3">
            <AlertTitle>No model selected — connect a provider and pick one.</AlertTitle>
          </Alert>
        )}
      </div>

      <LocalAiSection active={active} onActiveChanged={reload} />

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Providers</h3>
          <p className="text-xs text-muted-foreground">
            Connect a cloud or custom provider, then pick a model.
          </p>
        </div>
        {state.providers.map((p) => {
          const expanded = expandedId === p.id;
          const fetch = models[p.id];
          const canSelect = p.auth.configured;
          return (
            <div key={p.id} className="overflow-hidden rounded-lg border">
              {/* biome-ignore lint/a11y/useSemanticElements: row is a disclosure toggle; nested buttons rule out a real <button>. */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggleExpand(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleExpand(p.id);
                  }
                }}
                className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40"
              >
                <ProviderBadge kind={providerKind(p)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{p.label}</span>
                    {active?.providerId === p.id && (
                      <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {p.baseUrl} · {authLabel(p)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {/* Known providers have no editable structural fields — auth is handled inline. */}
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
                  <ChevronDownIcon
                    className={cn(
                      "size-4 text-muted-foreground/60 transition-transform",
                      expanded && "rotate-180"
                    )}
                    aria-hidden
                  />
                </div>
              </div>

              {expanded && (
                <div className="border-t bg-muted/20">
                  {/* Auth controls for known providers (sign in / paste key / disconnect). */}
                  {p.knownProvider && (
                    <div className="border-b">
                      <KnownProviderAuth provider={p} onChanged={() => void reload()} />
                    </div>
                  )}

                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">Models</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Refresh models"
                      disabled={fetch?.loading}
                      onClick={() => void fetchModels(p.id)}
                    >
                      <RefreshCwIcon className={cn("size-3.5", fetch?.loading && "animate-spin")} />
                    </Button>
                  </div>

                  {!canSelect && (
                    <div className="px-3 pb-2 text-xs text-muted-foreground">
                      Connect this provider above to select a model.
                    </div>
                  )}
                  {fetch?.loading && !fetch.models && (
                    <div className="flex items-center gap-2 px-3 pb-3 text-xs text-muted-foreground">
                      <Loader2Icon className="size-3.5 animate-spin" />
                      Fetching models…
                    </div>
                  )}
                  {fetch?.error && (
                    <div className="px-3 pb-3 text-xs text-destructive">
                      Couldn&apos;t fetch models: {fetch.error}
                    </div>
                  )}
                  {fetch?.models && fetch.models.length === 0 && (
                    <div className="px-3 pb-3 text-xs text-muted-foreground">No models found.</div>
                  )}
                  {fetch?.models && fetch.models.length > 0 && (
                    <div className="divide-y divide-border border-t">
                      {fetch.models.map((m) => {
                        const key = `${p.id}:${m.id}`;
                        const isActive = active?.providerId === p.id && active.model === m.id;
                        const isPending = pendingSelect === key;
                        return (
                          // biome-ignore lint/a11y/useSemanticElements: selectable row with nested badges.
                          <div
                            role="button"
                            key={m.id}
                            tabIndex={canSelect ? 0 : -1}
                            aria-disabled={!canSelect || undefined}
                            onClick={() => {
                              if (canSelect) void selectModel(p.id, m.id, m.capabilities);
                            }}
                            onKeyDown={(e) => {
                              if (!canSelect) return;
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                void selectModel(p.id, m.id, m.capabilities);
                              }
                            }}
                            className={cn(
                              "flex items-start gap-3 border-l-2 border-l-transparent px-3 py-2.5 transition-colors",
                              isActive ? "border-l-emerald-500 bg-accent" : canSelect && "hover:bg-accent/40",
                              canSelect ? "cursor-pointer" : "cursor-default opacity-60"
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate font-mono text-sm">{m.id}</span>
                                {(isActive || isPending) && (
                                  <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
                                )}
                              </div>
                              <div className="mt-1.5">
                                <CapabilityBadges caps={m.capabilities} source={m.capabilitySource} />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Button variant="outline" className="self-start" onClick={() => setAddOpen(true)}>
        <PlusIcon className="size-4" />
        Add provider
      </Button>

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
            await fetchModels(result.id);
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
        onSaved={(createdId) => {
          void (async () => {
            await reload();
            const id = createdId ?? editorProvider?.id;
            if (id) {
              await fetchModels(id);
              if (createdId) setExpandedId(createdId);
            }
          })();
        }}
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

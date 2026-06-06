import { Button } from "@mapos/ui/components/button";
import { cn } from "@mapos/ui/lib/utils";
import { type ActiveSelectionView, EMBEDDED_PROVIDER_ID } from "@shared/ai-providers";
import type { InstalledModel, RecommendedModel } from "@shared/local-llm";
import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  Loader2Icon,
  MonitorIcon,
  Trash2Icon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type DlState = { downloadedBytes: number; totalBytes: number };

function formatGB(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/**
 * "On this Mac" — the embedded llama.cpp runtime. Browses the curated catalog, downloads models, and
 * selects one via the shared `active` selection (so it competes with the network providers for the
 * single in-use slot). Hardware-aware: marks the best fit and flags models that may not fit.
 */
export function LocalAiSection({
  active,
  onActiveChanged
}: {
  active: ActiveSelectionView;
  onActiveChanged: () => void | Promise<void>;
}): React.JSX.Element {
  const [models, setModels] = useState<RecommendedModel[] | null>(null);
  // Downloaded .gguf files that aren't in the current catalog (e.g. left behind by a catalog
  // update). Listed so they can still be deleted.
  const [orphans, setOrphans] = useState<InstalledModel[]>([]);
  const [downloads, setDownloads] = useState<Record<string, DlState>>({});
  const [busy, setBusy] = useState<Record<string, "use" | "delete">>({});
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const loadModels = useCallback(async () => {
    const [recommended, installed] = await Promise.all([
      window.api.localLlm.listRecommended(),
      window.api.localLlm.listInstalled()
    ]);
    setModels(recommended);
    setOrphans(installed.filter((m) => !m.fromCatalog));
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    return window.api.localLlm.onDownloadProgress((d) => {
      setDownloads((m) => {
        if (d.done) {
          const next = { ...m };
          delete next[d.modelId];
          return next;
        }
        return { ...m, [d.modelId]: { downloadedBytes: d.downloadedBytes, totalBytes: d.totalBytes } };
      });
      if (d.done) void loadModels();
    });
  }, [loadModels]);

  const isActive = (id: string): boolean =>
    active?.providerId === EMBEDDED_PROVIDER_ID && active.model === id;

  async function use(m: RecommendedModel): Promise<void> {
    setBusy((b) => ({ ...b, [m.id]: "use" }));
    setError(null);
    const result = await window.api.ai.setActive(EMBEDDED_PROVIDER_ID, m.id, m.capabilities);
    setBusy((b) => {
      const next = { ...b };
      delete next[m.id];
      return next;
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await onActiveChanged();
  }

  async function download(m: RecommendedModel): Promise<void> {
    setError(null);
    setDownloads((d) => ({ ...d, [m.id]: { downloadedBytes: 0, totalBytes: m.sizeBytes } }));
    const result = await window.api.localLlm.download(m.id);
    if (!result.ok) {
      setDownloads((d) => {
        const next = { ...d };
        delete next[m.id];
        return next;
      });
      if (!/cancel/i.test(result.error)) setError(result.error);
      return;
    }
    // The progress `done` handler reloads the catalog, flipping this row to its "Use" state.
    await loadModels();
  }

  function cancel(m: RecommendedModel): void {
    void window.api.localLlm.cancelDownload(m.id);
  }

  async function remove(m: { id: string }): Promise<void> {
    setBusy((b) => ({ ...b, [m.id]: "delete" }));
    const result = await window.api.localLlm.delete(m.id);
    setBusy((b) => {
      const next = { ...b };
      delete next[m.id];
      return next;
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await loadModels();
    await onActiveChanged(); // the delete IPC clears the active selection if it was this model
  }

  const activeModel = active?.providerId === EMBEDDED_PROVIDER_ID ? active.model : null;

  return (
    <div className="overflow-hidden rounded-lg border">
      {/* biome-ignore lint/a11y/useSemanticElements: disclosure row with a nested chevron button. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
          <MonitorIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">On this Mac</span>
            {activeModel && <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />}
          </div>
        </div>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60 transition-transform",
            expanded && "rotate-180"
          )}
          aria-hidden
        />
      </div>

      {expanded && (
        <div className="border-t bg-muted/20">
          {error && <div className="px-3 pt-2 text-destructive text-xs">{error}</div>}
          {!models && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              Loading models…
            </div>
          )}
          {models && (
            <div className="divide-y divide-border">
              {models.map((m) => {
                const dl = downloads[m.id];
                const downloading = !!dl;
                const selected = isActive(m.id);
                const pct = dl && dl.totalBytes > 0 ? (dl.downloadedBytes / dl.totalBytes) * 100 : 0;
                return (
                  <div
                    key={m.id}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5",
                      selected && "bg-accent"
                    )}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {selected && <CheckIcon className="size-4 text-emerald-500" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-sm">{m.label}</span>
                        {!m.fits && (
                          <span className="text-amber-600 text-xs dark:text-amber-500">
                            May exceed memory
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-muted-foreground text-xs">
                        {formatGB(m.sizeBytes)} · {m.description}
                      </div>
                      {downloading && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-emerald-500 transition-[width]"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                            {formatGB(dl.downloadedBytes)} / {formatGB(dl.totalBytes)}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {downloading ? (
                        <Button variant="ghost" size="sm" onClick={() => cancel(m)}>
                          <XIcon className="size-4" />
                          Cancel
                        </Button>
                      ) : m.installed ? (
                        <>
                          {!selected && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!!busy[m.id]}
                              onClick={() => void use(m)}
                            >
                              {busy[m.id] === "use" && <Loader2Icon className="size-4 animate-spin" />}
                              Use
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete ${m.label}`}
                            disabled={!!busy[m.id]}
                            onClick={() => void remove(m)}
                          >
                            {busy[m.id] === "delete" ? (
                              <Loader2Icon className="size-4 animate-spin" />
                            ) : (
                              <Trash2Icon className="size-4" />
                            )}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground"
                          onClick={() => void download(m)}
                        >
                          <DownloadIcon className="size-4" />
                          Download
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {orphans.map((m) => (
                <div key={m.fileName} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="flex size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <span className="truncate font-medium text-sm">{m.label}</span>
                    <div className="mt-0.5 text-muted-foreground text-xs">
                      {formatGB(m.sizeBytes)} · No longer in the catalog
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${m.label}`}
                      disabled={!!busy[m.id]}
                      onClick={() => void remove(m)}
                    >
                      {busy[m.id] === "delete" ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <Trash2Icon className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

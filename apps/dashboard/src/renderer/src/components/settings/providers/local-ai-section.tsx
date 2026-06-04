import { Badge } from "@mapos/ui/components/badge";
import { Button } from "@mapos/ui/components/button";
import { cn } from "@mapos/ui/lib/utils";
import { type ActiveSelectionView, EMBEDDED_PROVIDER_ID } from "@shared/ai-providers";
import type { LocalLlmHardware, RecommendedModel } from "@shared/local-llm";
import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  HardDriveIcon,
  Loader2Icon,
  Trash2Icon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CapabilityBadges } from "./capability-badges";

type DlState = { downloadedBytes: number; totalBytes: number };

function formatGB(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function hardwareLine(hw: LocalLlmHardware): string {
  const gpu = hw.gpu ? hw.gpu[0].toUpperCase() + hw.gpu.slice(1) : "CPU";
  return `${hw.totalMemoryGB} GB · ${gpu}`;
}

/**
 * "On this Mac" — the embedded llama.cpp runtime. Browses the curated catalog, downloads models, and
 * selects one via the shared aiv2 `active` selection (so it competes with the network providers for
 * the single in-use slot). Hardware-aware: marks the best fit and flags models that may not fit.
 */
export function LocalAiSection({
  active,
  onActiveChanged
}: {
  active: ActiveSelectionView;
  onActiveChanged: () => void | Promise<void>;
}): React.JSX.Element {
  const [hardware, setHardware] = useState<LocalLlmHardware | null>(null);
  const [models, setModels] = useState<RecommendedModel[] | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DlState>>({});
  const [busy, setBusy] = useState<Record<string, "use" | "delete">>({});
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  const loadModels = useCallback(async () => {
    setModels(await window.api.localLlm.listRecommended());
  }, []);

  useEffect(() => {
    void window.api.localLlm.getHardware().then(setHardware).catch(() => {});
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
    const result = await window.api.aiv2.setActive(EMBEDDED_PROVIDER_ID, m.id, m.capabilities);
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

  async function downloadAndUse(m: RecommendedModel): Promise<void> {
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
    await loadModels();
    await use(m);
  }

  function cancel(m: RecommendedModel): void {
    void window.api.localLlm.cancelDownload(m.id);
  }

  async function remove(m: RecommendedModel): Promise<void> {
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
  const subtitle = activeModel
    ? `Using ${activeModel}`
    : "Runs privately on this Mac — no key, no network";

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
          <HardDriveIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">On this Mac</span>
            <Badge variant="secondary">Recommended</Badge>
            {activeModel && <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {subtitle}
            {hardware ? ` · ${hardwareLine(hardware)}` : ""}
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
          {error && <div className="px-3 pt-2 text-xs text-destructive">{error}</div>}
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
                      "flex items-start gap-3 border-l-2 border-l-transparent px-3 py-2.5",
                      selected && "border-l-emerald-500 bg-accent"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{m.label}</span>
                        {m.recommended && <Badge variant="secondary">Best fit</Badge>}
                        {!m.fits && (
                          <span className="text-xs text-amber-600 dark:text-amber-500">
                            May exceed memory
                          </span>
                        )}
                        {selected && <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {formatGB(m.sizeBytes)} · {m.description}
                      </div>
                      <div className="mt-1.5">
                        <CapabilityBadges caps={m.capabilities} />
                      </div>
                      {downloading && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-emerald-500 transition-[width]"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
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
                          {selected ? (
                            <span className="px-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                              In use
                            </span>
                          ) : (
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
                        <Button variant="outline" size="sm" onClick={() => void downloadAndUse(m)}>
                          <DownloadIcon className="size-4" />
                          Download & use
                        </Button>
                      )}
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
}

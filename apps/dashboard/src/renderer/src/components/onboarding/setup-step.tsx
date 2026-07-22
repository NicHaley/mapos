import { Button } from "@mapos/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle
} from "@mapos/ui/components/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@mapos/ui/components/sheet";
import type { McpConnectionInfo } from "@shared/types";
import { ArrowLeftIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { setAccent, useAccent } from "../../lib/accent";
import { setTheme, useTheme } from "../../lib/theme";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { AccentPicker } from "../accent-picker";
import { McpConnect } from "../settings/mcp-connect";
import { RegionPicker } from "../settings/region-picker";
import { ThemePicker } from "../theme-picker";
import { CmdEnterHint } from "./cmd-enter-hint";
import { type VaultDraft, VaultSheet } from "./vault-sheet";

export function SetupStep({
  draft,
  onDraftChange,
  onBack,
  onComplete
}: {
  draft: VaultDraft | null;
  onDraftChange: (next: VaultDraft) => void;
  onBack: () => void;
  onComplete: () => Promise<{ ok: true } | { ok: false; error: string }>;
}): React.JSX.Element {
  const theme = useTheme();
  const accent = useAccent();

  const [vaultOpen, setVaultOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [offlineOpen, setOfflineOpen] = useState(false);

  const [installedCount, setInstalledCount] = useState(0);
  const [lastClient, setLastClient] = useState<McpConnectionInfo["lastClient"] | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Installed-region count for the Offline row — listLocal() reads disk only (no manifest fetch),
  // and regions:changed keeps it live while a download runs in the drawer.
  useEffect(() => {
    const load = (): void => {
      void window.api.regions
        .listLocal()
        .then((packs) => setInstalledCount(packs.length))
        .catch(() => {});
    };
    load();
    return window.api.regions.onChanged(load);
  }, []);

  // Live "a client connected" signal for the AI-client row.
  useEffect(() => {
    void window.api.mcp.getConnectionInfo().then((info) => setLastClient(info.lastClient));
    return window.api.mcp.onClientConnected((c) => setLastClient(c));
  }, []);

  async function handleFinish(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onComplete();
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
      }
      // On success the main process reloads the renderer — nothing more to do here.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  useCmdEnter(() => void handleFinish(), !busy && !!draft);

  const vaultPath = draft?.kind === "create" ? draft.targetPath : (draft?.path ?? null);

  return (
    <div className="flex h-full min-w-0 flex-col justify-center">
      {/* No flex-1: the scroll region sizes to its content so the footer sits directly beneath
          it, and justify-center centers the content+footer group vertically. min-h-0 + default
          flex-shrink let the region shrink and scroll only when the content is taller than the
          available space — at which point there's no free space to center and the footer stays
          pinned in view. */}
      <div className="-mx-3.5 min-h-0 overflow-y-auto px-3.5">
        <div className="flex w-full flex-col">
          <header>
            <h1 className="text-2xl font-semibold tracking-tight">Set up MapOS</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Pick where your files live, then tune the rest. Everything here can be changed later
              in Settings.
            </p>
          </header>

          {!draft && (
            <div className="mt-6 flex items-start gap-3 rounded-lg border border-amber-600/25 bg-amber-500/10 px-4 py-3 text-sm">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">No vault selected</span>
                <span className="text-muted-foreground">
                  Choose where your files live to finish setup.
                </span>
              </div>
            </div>
          )}

          <ItemGroup className="mt-8 gap-0">
            <Item className="px-0">
              <ItemContent>
                <ItemTitle>Vault</ItemTitle>
                {vaultPath ? (
                  <ItemDescription className="truncate font-mono" title={vaultPath}>
                    {vaultPath}
                  </ItemDescription>
                ) : (
                  <ItemDescription>Where your notes and places are stored.</ItemDescription>
                )}
              </ItemContent>
              <ItemActions>
                <Button variant="outline" onClick={() => setVaultOpen(true)}>
                  {draft ? "Change" : "Choose…"}
                </Button>
              </ItemActions>
            </Item>
            <ItemSeparator />

            <Item className="px-0">
              <ItemContent>
                <ItemTitle>Connect an AI client</ItemTitle>
                {lastClient ? (
                  <ItemDescription className="text-emerald-700 dark:text-emerald-400">
                    Connected — {lastClient.name}
                  </ItemDescription>
                ) : (
                  <ItemDescription>Drive MapOS from Claude Code, Cursor, and more.</ItemDescription>
                )}
              </ItemContent>
              <ItemActions>
                <Button variant="outline" onClick={() => setConnectOpen(true)}>
                  {lastClient ? "Manage" : "Set up"}
                </Button>
              </ItemActions>
            </Item>
            <ItemSeparator />

            <Item className="px-0">
              <ItemContent>
                <ItemTitle>Offline maps</ItemTitle>
                {installedCount > 0 ? (
                  <ItemDescription>
                    {installedCount} {installedCount === 1 ? "region" : "regions"} downloaded.
                  </ItemDescription>
                ) : (
                  <ItemDescription>
                    Download regions to browse without a connection.
                  </ItemDescription>
                )}
              </ItemContent>
              <ItemActions>
                <Button variant="outline" onClick={() => setOfflineOpen(true)}>
                  Choose regions
                </Button>
              </ItemActions>
            </Item>
            <ItemSeparator />

            <Item className="items-start px-0">
              <ItemContent>
                <ItemTitle>Theme</ItemTitle>
                <ItemDescription>Light, dark, or match your system.</ItemDescription>
              </ItemContent>
              <ItemActions className="w-[280px]">
                <ThemePicker value={theme} onChange={setTheme} />
              </ItemActions>
            </Item>
            <ItemSeparator />

            <Item className="items-start px-0">
              <ItemContent>
                <ItemTitle>Accent color</ItemTitle>
                <ItemDescription>Tints pins and highlights across the map.</ItemDescription>
              </ItemContent>
              <ItemActions>
                <AccentPicker value={accent} onChange={setAccent} />
              </ItemActions>
            </Item>
          </ItemGroup>
        </div>
      </div>

      {/* Pinned footer: stays put while the setup content above scrolls. */}
      <div className="shrink-0 pt-6">
        {error && <p className="mb-3 text-center text-xs text-destructive">{error}</p>}
        <div className="flex items-center justify-between gap-3">
          <Button size="lg" variant="ghost" onClick={onBack} disabled={busy}>
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
          <Button size="lg" onClick={() => void handleFinish()} disabled={busy || !draft}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Finish setup
            <CmdEnterHint tone="primary" />
          </Button>
        </div>
      </div>

      <VaultSheet
        open={vaultOpen}
        onOpenChange={setVaultOpen}
        draft={draft}
        onDraftChange={onDraftChange}
      />

      <Sheet open={connectOpen} onOpenChange={setConnectOpen}>
        <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Connect an AI client</SheetTitle>
            <SheetDescription>
              MapOS is driven by an MCP client like Claude Code or Cursor.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <McpConnect />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={offlineOpen} onOpenChange={setOfflineOpen}>
        <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Offline maps</SheetTitle>
            <SheetDescription>
              Download regions to browse and search them with no connection. Add or remove them any
              time in Settings.
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
            <RegionPicker />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

import type { ActiveSelectionView, AiState, ProviderView } from "@shared/ai-providers";
import { useCallback, useEffect, useState } from "react";
import type { ConnectTarget } from "./known-provider-auth-sheet";

/** How a connect drawer is opened: a not-yet-persisted catalog entry, or an existing row by id. */
type ConnectState = { kind: "new"; name: string; label: string } | { kind: "existing"; id: string };

export type ProviderManager = {
  state: AiState | null;
  /** Refetch and return the latest state, so callers can act on it without a second fetch. */
  reload: () => Promise<AiState>;
  /** After a connect/add, pick a sensible default model (the newest of the first connected provider
   * that returns any) — but only when no default is set yet. No-op otherwise. */
  ensureDefaultModel: () => Promise<void>;

  // Add / edit / connect drawers.
  addOpen: boolean;
  setAddOpen: (open: boolean) => void;
  editorOpen: boolean;
  setEditorOpen: (open: boolean) => void;
  editorProvider: ProviderView | null;
  authOpen: boolean;
  setAuthOpen: (open: boolean) => void;
  /** The connect drawer's target, resolved from live state (existing rows reflect connect/disconnect). */
  connectDrawerTarget: ConnectTarget | null;
  /** Connect a catalog provider without persisting it yet — the row is written on actual connect. */
  openNewConnect: (name: string, label: string) => void;
  openExistingConnect: (id: string) => void;
  /** Edit a row: known providers reopen the connect drawer; custom rows open the endpoint editor. */
  editProvider: (provider: ProviderView) => void;
  /** Open the custom-endpoint editor for a brand-new provider. */
  openCustomEditor: () => void;

  // Delete confirmation.
  pendingDelete: ProviderView | null;
  requestDelete: (provider: ProviderView) => void;
  cancelDelete: () => void;
  deleting: boolean;
  deleteError: string | null;
  confirmDelete: () => Promise<void>;

  // Derived.
  active: ActiveSelectionView;
  hasConnected: boolean;
  /** Catalog names already added, so the add picker doesn't offer duplicates. */
  addedKnown: Set<string>;
};

/**
 * Page-level state and actions for managing AI providers — the connect/add/edit drawers and the
 * delete-confirmation flow. Shared by the Settings AI Models tab and the onboarding AI step so the
 * two surfaces never drift. (The per-provider sign-in/key logic lives in {@link useKnownProviderConnect};
 * this hook is the list-level orchestration around it.)
 */
export function useProviderManager(): ProviderManager {
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
    const next = await window.api.ai.getState();
    setState(next);
    return next;
  }, []);

  const ensureDefaultModel = useCallback(async () => {
    const next = await window.api.ai.getState();
    setState(next);
    if (next.active) return; // a default is already set — never override the user's choice
    for (const p of next.providers) {
      if (!p.auth.configured) continue;
      const res = await window.api.ai.listModels(p.id);
      if (!res.ok || res.models.length === 0) continue;
      // Providers list models oldest-first; the newest (top of the reversed UI list) is last.
      const newest = res.models[res.models.length - 1];
      const set = await window.api.ai.setActive(p.id, newest.id, newest.capabilities);
      if (set.ok) await reload();
      return;
    }
  }, [reload]);

  useEffect(() => {
    void reload();
    return window.api.ai.onChanged(() => void reload());
  }, [reload]);

  const openNewConnect = useCallback((name: string, label: string) => {
    setConnectTarget({ kind: "new", name, label });
    setAddOpen(false);
    setAuthOpen(true);
  }, []);

  const openExistingConnect = useCallback((id: string) => {
    setConnectTarget({ kind: "existing", id });
    setAuthOpen(true);
  }, []);

  const openCustomEditor = useCallback(() => {
    setAddOpen(false);
    setEditorProvider(null);
    setEditorOpen(true);
  }, []);

  const editProvider = useCallback(
    (provider: ProviderView) => {
      if (provider.knownProvider) {
        openExistingConnect(provider.id);
      } else {
        setEditorProvider(provider);
        setEditorOpen(true);
      }
    },
    [openExistingConnect]
  );

  const requestDelete = useCallback((provider: ProviderView) => {
    setDeleteError(null);
    setPendingDelete(provider);
  }, []);

  const cancelDelete = useCallback(() => {
    if (deleting) return;
    setPendingDelete(null);
    setDeleteError(null);
  }, [deleting]);

  const confirmDelete = useCallback(async () => {
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
    // The provider is gone, so close any edit/connect drawer that was open for it.
    setAuthOpen(false);
    setEditorOpen(false);
    await reload();
  }, [pendingDelete, reload]);

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

  const active = state?.active ?? null;
  const hasConnected = state?.providers.some((p) => p.auth.configured) ?? false;
  const addedKnown = new Set(
    state?.providers.map((p) => p.knownProvider).filter((n): n is string => !!n) ?? []
  );

  return {
    state,
    reload,
    ensureDefaultModel,
    addOpen,
    setAddOpen,
    editorOpen,
    setEditorOpen,
    editorProvider,
    authOpen,
    setAuthOpen,
    connectDrawerTarget,
    openNewConnect,
    openExistingConnect,
    editProvider,
    openCustomEditor,
    pendingDelete,
    requestDelete,
    cancelDelete,
    deleting,
    deleteError,
    confirmDelete,
    active,
    hasConnected,
    addedKnown
  };
}

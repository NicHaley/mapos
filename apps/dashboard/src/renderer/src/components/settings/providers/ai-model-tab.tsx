import type { KnownProviderOption } from "@shared/ai-providers";
import { Loader2Icon } from "lucide-react";
import { useCallback } from "react";
import { AddProviderSheet } from "./add-provider-sheet";
import { DeleteProviderDialog } from "./delete-provider-dialog";
import { KnownProviderAuthSheet } from "./known-provider-auth-sheet";
import { ProviderEditorSheet } from "./provider-editor-sheet";
import { ProviderModelsList } from "./provider-models-list";
import { ProvidersEmptyState } from "./providers-empty-state";
import { useProviderManager } from "./use-provider-manager";

export function AiModelTab(): React.JSX.Element {
  const pm = useProviderManager();

  // After a provider connects, refresh so its models appear inline under the new group.
  const reloadAfterConnect = useCallback(async (): Promise<void> => {
    await pm.reload();
  }, [pm.reload]);

  if (!pm.state) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }

  const { state, editorProvider } = pm;
  const editingExisting =
    pm.connectDrawerTarget?.kind === "existing" ? pm.connectDrawerTarget.provider : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-medium text-base">AI Models</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          Configure AI providers and set your default model.
        </p>
      </div>

      {state.providers.length === 0 ? (
        <ProvidersEmptyState
          onPick={pm.openNewConnect}
          onCustom={pm.openCustomEditor}
          onBrowseAll={() => pm.setAddOpen(true)}
        />
      ) : (
        <ProviderModelsList
          state={state}
          onEditProvider={pm.editProvider}
          onSelected={pm.reload}
          onAddProvider={() => pm.setAddOpen(true)}
        />
      )}

      <AddProviderSheet
        open={pm.addOpen}
        onOpenChange={pm.setAddOpen}
        addedKnownProviders={pm.addedKnown}
        onPickKnown={(option: KnownProviderOption) => pm.openNewConnect(option.name, option.label)}
        onChooseCustom={pm.openCustomEditor}
      />

      <ProviderEditorSheet
        open={pm.editorOpen}
        onOpenChange={pm.setEditorOpen}
        provider={editorProvider}
        onSaved={() => void reloadAfterConnect()}
        onRequestDelete={editorProvider ? () => pm.requestDelete(editorProvider) : undefined}
      />

      <KnownProviderAuthSheet
        open={pm.authOpen}
        onOpenChange={pm.setAuthOpen}
        target={pm.connectDrawerTarget}
        onChanged={() => void pm.reload()}
        onConnected={() => void reloadAfterConnect()}
        onRequestDelete={editingExisting ? () => pm.requestDelete(editingExisting) : undefined}
      />

      <DeleteProviderDialog
        pendingDelete={pm.pendingDelete}
        deleting={pm.deleting}
        deleteError={pm.deleteError}
        onCancel={pm.cancelDelete}
        onConfirm={() => void pm.confirmDelete()}
      />
    </div>
  );
}

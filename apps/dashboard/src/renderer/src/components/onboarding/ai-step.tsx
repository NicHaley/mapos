import { Button } from "@mapos/ui/components/button";
import type { KnownProviderOption } from "@shared/ai-providers";
import { ArrowLeftIcon, Loader2Icon } from "lucide-react";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { AddProviderSheet } from "../settings/providers/add-provider-sheet";
import { DeleteProviderDialog } from "../settings/providers/delete-provider-dialog";
import { KnownProviderAuthSheet } from "../settings/providers/known-provider-auth-sheet";
import { ProviderEditorSheet } from "../settings/providers/provider-editor-sheet";
import { ProviderModelsList } from "../settings/providers/provider-models-list";
import { ProvidersEmptyState } from "../settings/providers/providers-empty-state";
import { useProviderManager } from "../settings/providers/use-provider-manager";
import { CmdEnterHint } from "./cmd-enter-hint";

/**
 * Onboarding's take on the AI Models settings page: it reuses the same provider-management state
 * ({@link useProviderManager}), empty-state picker, connect drawers, and provider row so the two
 * surfaces stay consistent. Pared down for first-run — only one provider is added (no "Add provider"
 * button), and model selection uses the compact switcher rather than the settings hero. Additional
 * or custom/local endpoints are managed later in Settings.
 */
export function AiStep({
  onBack,
  onNext
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const pm = useProviderManager();
  const { state, active, editorProvider } = pm;
  const editingExisting =
    pm.connectDrawerTarget?.kind === "existing" ? pm.connectDrawerTarget.provider : null;

  // A model is active once a provider is connected; that's the real "ready to continue" signal.
  const primaryEnabled = !!active;
  useCmdEnter(() => onNext(), primaryEnabled);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Connect an AI provider</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Connect MapOS to local or cloud AI providers.
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
            onPick={pm.openNewConnect}
            onCustom={pm.openCustomEditor}
            onBrowseAll={() => pm.setAddOpen(true)}
          />
        ) : (
          <ProviderModelsList
            state={state}
            onEditProvider={pm.editProvider}
            onSelected={pm.reload}
          />
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
        onSaved={() => void pm.reload()}
        onRequestDelete={editorProvider ? () => pm.requestDelete(editorProvider) : undefined}
      />

      <KnownProviderAuthSheet
        open={pm.authOpen}
        onOpenChange={pm.setAuthOpen}
        target={pm.connectDrawerTarget}
        onChanged={() => void pm.reload()}
        onConnected={() => void pm.reload()}
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

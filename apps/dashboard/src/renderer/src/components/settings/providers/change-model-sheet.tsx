import type { AiState } from "@shared/ai-providers";
import { SettingsSheet } from "../settings-sheet";
import { ModelPickerList } from "./model-picker-list";

/**
 * Drawer wrapper around the shared model picker. Used by the settings page's "Change model" action;
 * the in-chat switcher embeds the same {@link ModelPickerList} in a popover instead.
 */
export function ChangeModelSheet({
  open,
  onOpenChange,
  state,
  onSelected
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AiState;
  onSelected: () => void | Promise<void>;
}): React.JSX.Element {
  return (
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Change model"
      description="Search models for your connected providers"
      width={460}
    >
      {/* Mount the list only while open so it fetches fresh each time the sheet is shown. The
          Command surface drops its own background here so it blends into the sheet. */}
      {open && (
        <ModelPickerList
          state={state}
          className="bg-transparent p-0"
          listClassName="max-h-[calc(100vh-12rem)]"
          onSelected={async () => {
            await onSelected();
            onOpenChange(false);
          }}
        />
      )}
    </SettingsSheet>
  );
}

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
      // Flush body so the Command fills the drawer and its list owns the scroll — keeps the scroll
      // track at the drawer's right edge and lets content reach the bottom, instead of scrolling the
      // padded body (which insets the scrollbar and clips short of the bottom).
      bodyClassName="flex min-h-0 flex-col overflow-hidden p-0"
    >
      {/* Mount the list only while open so it fetches fresh each time the sheet is shown. The
          Command surface drops its own background here so it blends into the sheet, fills the body,
          and pads the input/rows itself (the body no longer pads). */}
      {open && (
        <ModelPickerList
          state={state}
          className="size-full bg-transparent p-0 [&_[data-slot=command-group]]:px-4 [&_[data-slot=command-input-wrapper]]:px-4 [&_[data-slot=command-input-wrapper]]:pt-3"
          listClassName="max-h-none min-h-0 flex-1"
          onSelected={async () => {
            await onSelected();
            onOpenChange(false);
          }}
        />
      )}
    </SettingsSheet>
  );
}

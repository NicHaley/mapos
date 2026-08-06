import { Popover, PopoverContent, PopoverTrigger } from "@mapos/ui/components/popover";
import { EmojiPicker } from "./emoji-picker";

/**
 * The icon picker, opened from the card's overflow menu and anchored to its button.
 *
 * Icon only. Colour sits beside it in that menu as a named `Color` submenu, because a row of
 * unlabelled swatches makes the reader match a hue to an intent when "Blue" is what they wanted.
 *
 * The header row is deliberately shaped for a second tab: `icon` is a plain string, so a later
 * `lucide:map-pin` form extends the same frontmatter key, and an "Icons" tab slots in beside
 * "Emoji" without touching the data model. What it *would* need is the map rasterizer learning to
 * stroke an SVG path, and the pin image-id codec learning to carry the icon kind.
 */
export function PlaceIconPopover({
  hasIcon,
  onSelect,
  onRemove,
  open,
  onOpenChange,
  trigger
}: {
  hasIcon: boolean;
  onSelect: (emoji: string) => void;
  onRemove: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactElement;
}): React.JSX.Element {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      {/* Opens the same way as the overflow menu it is reached from — both start-aligned on the
          overflow button, so choosing "Icon" doesn't make the panel jump sides. */}
      <PopoverContent align="start" className="w-auto gap-2 p-2">
        <div className="flex items-center justify-between">
          <span className="px-1 font-medium text-sm">Emoji</span>
          {hasIcon && (
            <button
              type="button"
              onClick={() => {
                onRemove();
                onOpenChange(false);
              }}
              className="cursor-pointer rounded px-1.5 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-hover hover:text-foreground"
            >
              Remove
            </button>
          )}
        </div>
        <EmojiPicker
          onSelect={(emoji) => {
            onSelect(emoji);
            onOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

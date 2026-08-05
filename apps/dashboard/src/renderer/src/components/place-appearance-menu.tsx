import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from "@mapos/ui/components/dropdown-menu";
import { ACCENT_PALETTE, featureDefaultColor, useAccent } from "@renderer/lib/accent";
import { normalizeFeatureColor } from "@renderer/lib/map-styles";
import { CheckIcon, PaletteIcon, SmileIcon, Trash2Icon } from "lucide-react";

/**
 * The `icon` and `color` frontmatter keys a file can set, as a patch. A key set to `null` is a
 * delete (the plural frontmatter write API treats `null` as "remove"); a key left out is
 * unchanged.
 */
export type PlaceAppearance = { icon?: string | null; color?: string | null };

/** The colour options: the fixed accent hues. Monochrome is skipped — it carries no hex, so it has
 *  nothing to write; "Default" covers that case by clearing the key. */
const COLOR_OPTIONS = ACCENT_PALETTE.filter((o) => o.hex !== null);

/** A single colour row: the hue as a filled dot, its name, and a tick when it's the current one. */
function ColorItem({
  label,
  swatch,
  selected,
  onSelect
}: {
  label: string;
  swatch: string;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenuItem onClick={onSelect}>
      <span
        className="size-3.5 shrink-0 rounded-full border border-black/10"
        style={{ backgroundColor: swatch }}
      />
      <span className="flex-1">{label}</span>
      {selected && <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />}
    </DropdownMenuItem>
  );
}

/**
 * The appearance controls as menu items, for the card's overflow menu.
 *
 * The title-row glyph is the primary way in and opens the picker directly; these exist so the
 * controls are findable for anyone who doesn't guess that the glyph is clickable, and so colour has
 * a home — the picker popover is icon-only.
 *
 * Colour is a named submenu rather than a swatch strip: a row of unlabelled dots makes the reader
 * match a hue to an intent, and "Blue" is the thing they were looking for.
 */
export function PlaceAppearanceMenuItems({
  icon,
  color,
  onChange,
  onChooseIcon
}: {
  icon?: string;
  color?: string;
  onChange: (patch: PlaceAppearance) => void;
  /** Opens the icon picker popover, which is anchored to the title-row glyph. */
  onChooseIcon: () => void;
}): React.JSX.Element {
  const accent = useAccent();
  const current = normalizeFeatureColor(color);
  return (
    <>
      <DropdownMenuItem onClick={onChooseIcon}>
        <SmileIcon />
        {icon ? "Change icon" : "Add icon"}
      </DropdownMenuItem>
      {icon && (
        <DropdownMenuItem onClick={() => onChange({ icon: null })}>
          <Trash2Icon />
          Remove icon
        </DropdownMenuItem>
      )}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <PaletteIcon />
          Color
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {/* "Default" previews what an unset `color` actually draws as, so the choice reads as
              "follow the accent" rather than "no colour". */}
          <ColorItem
            label="Default"
            swatch={featureDefaultColor(accent)}
            selected={!current}
            onSelect={() => onChange({ color: null })}
          />
          <DropdownMenuSeparator />
          {COLOR_OPTIONS.map(({ id, label, hex }) => (
            <ColorItem
              key={id}
              label={label}
              swatch={hex as string}
              selected={current === hex}
              onSelect={() => onChange({ color: hex })}
            />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

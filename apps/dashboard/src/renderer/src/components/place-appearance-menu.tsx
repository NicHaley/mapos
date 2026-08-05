import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from "@mapos/ui/components/dropdown-menu";
import { ACCENT_PALETTE, featureDefaultColor, useAccent } from "@renderer/lib/accent";
import { normalizeFeatureColor } from "@renderer/lib/map-styles";
import { CheckIcon, ImageIcon, PaletteIcon, SmileIcon } from "lucide-react";

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
 * The three things a file's look is made of — icon, colour, cover photo — as one group of the
 * card's overflow menu.
 *
 * **One row per thing, each a submenu**, rather than a flat run of "Change X" / "Remove X" pairs.
 * Flat, the group was six rows that grew and shrank with what the file happened to have set, put a
 * second trash icon two rows above Delete, and left the reader scanning verbs to find the noun they
 * wanted. Nouns are what they're looking for, so nouns are the rows.
 *
 * `Remove` is disabled rather than omitted so the shape of the menu doesn't change under the
 * pointer — the appearing and disappearing rows were most of why the flat version read as messy.
 *
 * Colour is a named list rather than a swatch strip: a row of unlabelled dots makes the reader match
 * a hue to an intent, and "Blue" is the thing they were looking for.
 */
export function PlaceAppearanceMenuItems({
  icon,
  color,
  cover,
  onChange,
  onChooseIcon,
  onChooseCover,
  onRemoveCover
}: {
  icon?: string;
  color?: string;
  /** Vault-relative path of the current cover photo, when there is one. */
  cover?: string;
  onChange: (patch: PlaceAppearance) => void;
  /** Opens the icon picker popover, which is anchored to the title-row glyph. */
  onChooseIcon: () => void;
  /** Opens the OS file picker for a new cover image. */
  onChooseCover: () => void;
  onRemoveCover: () => void;
}): React.JSX.Element {
  const accent = useAccent();
  const current = normalizeFeatureColor(color);
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <SmileIcon />
          Icon
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={onChooseIcon}>
            {icon ? "Change emoji" : "Choose emoji"}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!icon} onClick={() => onChange({ icon: null })}>
            Remove
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
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
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <ImageIcon />
          Cover photo
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={onChooseCover}>
            {cover ? "Change image" : "Choose image"}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!cover} onClick={onRemoveCover}>
            Remove
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

import { Button } from "@mapos/ui/components/button";
import { Kbd } from "@mapos/ui/components/kbd";
import { Surface } from "@mapos/ui/components/surface";
import { DRAW_MODE_HINTS, type DrawSession } from "@renderer/lib/draw";
import type React from "react";

/**
 * The floating banner shown while a draw session is running. It is the only thing
 * telling the user the map has stopped behaving normally — clicks draw instead of
 * selecting — so it states the mode, how to complete it, and how to get out.
 *
 * Select sessions get a Save button because editing has no natural finish event;
 * draw sessions commit on their own and only need Cancel.
 */
export function DrawToolbar({
  session,
  canSave,
  onSave,
  onCancel
}: {
  session: DrawSession;
  /** Select mode only: whether the geometry has been edited into a saveable state. */
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const isEditing = session.mode === "select";
  return (
    <Surface
      variant="pill"
      className="pointer-events-auto flex-col items-stretch gap-2 rounded-lg px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-sidebar-foreground">
          {isEditing ? "Editing shape" : "Drawing"}
        </span>
        <span className="text-xs text-sidebar-foreground/60">{DRAW_MODE_HINTS[session.mode]}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
          <Kbd>Esc</Kbd>
        </Button>
        {isEditing && (
          <Button size="sm" disabled={!canSave} onClick={onSave}>
            Save
          </Button>
        )}
      </div>
    </Surface>
  );
}

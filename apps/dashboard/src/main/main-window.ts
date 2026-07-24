import type { BrowserWindow } from "electron";

// The app's single window, adopted by createWindow(). Held here (not passed around) because
// macOS can close and re-create the window (`activate` with no windows): long-lived closures
// that captured a BrowserWindow would keep pushing events at the destroyed one. Resolving the
// window at send time keeps every push targeting whichever window is live.
let current: BrowserWindow | null = null;

export function adoptMainWindow(win: BrowserWindow): void {
  current = win;
}

/** The live main window, or null while none exists (macOS with all windows closed). */
export function getMainWindow(): BrowserWindow | null {
  return current === null || current.isDestroyed() ? null : current;
}

/** Push a main→renderer event. Dropped silently when no window is live. */
export function sendToRenderer(channel: string, ...args: unknown[]): void {
  getMainWindow()?.webContents.send(channel, ...args);
}

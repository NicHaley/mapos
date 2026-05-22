import { Menu, type MenuItemConstructorOptions, app, shell } from "electron";
import { checkForUpdatesManually } from "./updater";

// Build the macOS app menu. On macOS the app menu is global (top of screen) and
// drives standard shortcuts (Cmd+Q, Cmd+W, Cmd+H, …). Without a custom menu
// Electron generates a default template that lacks a "Check for Updates" item,
// so we set one explicitly and inject the menu item into the app submenu.
//
// On other platforms we leave the default menu hidden (autoHideMenuBar) — the
// app's own UI surfaces the same actions.
export function setupAppMenu(): void {
  if (process.platform !== "darwin") return;

  const appName = app.getName();

  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates…",
          click: () => checkForUpdatesManually()
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
        { type: "separator" },
        { role: "window" }
      ]
    },
    {
      role: "help",
      submenu: [
        {
          label: "MapOS Website",
          click: () => void shell.openExternal("https://mapos.md")
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

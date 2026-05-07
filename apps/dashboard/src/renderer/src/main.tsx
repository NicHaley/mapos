import "@mapos/ui/globals.css";

import { createRoot } from "react-dom/client";

// Apply dark mode — respects stored preference, falls back to system.
// Always subscribe to OS changes so System mode reacts even if the user
// switched into System after launch.
const applyDark = (dark: boolean) => document.documentElement.classList.toggle("dark", dark);
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const readTheme = () =>
  (localStorage.getItem("mapos_theme") as "light" | "dark" | "system" | null) ?? "system";
const syncFromStorage = () => {
  const t = readTheme();
  applyDark(t === "system" ? mq.matches : t === "dark");
};
syncFromStorage();
mq.addEventListener("change", () => {
  if (readTheme() === "system") applyDark(mq.matches);
});
import App from "./app";
import { TooltipProvider } from "@mapos/ui/components/tooltip";

createRoot(document.getElementById("root") as HTMLElement).render(
  <TooltipProvider delay={300}>
    <App />
  </TooltipProvider>
);

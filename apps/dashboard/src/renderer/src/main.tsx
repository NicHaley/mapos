import "@mapos/ui/globals.css";

import { createRoot } from "react-dom/client";

// Apply dark mode — respects stored preference, falls back to system
const applyDark = (dark: boolean) => document.documentElement.classList.toggle("dark", dark);
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const storedTheme = localStorage.getItem("mapos_theme") as "light" | "dark" | "system" | null;
if (!storedTheme || storedTheme === "system") {
  applyDark(mq.matches);
  mq.addEventListener("change", (e) => {
    if ((localStorage.getItem("mapos_theme") ?? "system") === "system") applyDark(e.matches);
  });
} else {
  applyDark(storedTheme === "dark");
}
import App from "./app";
import { TooltipProvider } from "@mapos/ui/components/tooltip";

createRoot(document.getElementById("root") as HTMLElement).render(
  <TooltipProvider delay={300}>
    <App />
  </TooltipProvider>
);

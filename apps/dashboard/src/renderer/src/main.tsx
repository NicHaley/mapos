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
import { TooltipProvider } from "@mapos/ui/components/tooltip";
import { useEffect, useState } from "react";
import App from "./app";
import { OnboardingScreen } from "./components/onboarding/onboarding-screen";

function Root(): React.JSX.Element | null {
  const [pending, setPending] = useState<boolean | null>(null);

  useEffect(() => {
    void window.api.onboarding.getState().then((s) => setPending(s.pending));
  }, []);

  if (pending === null) return null;
  if (pending) return <OnboardingScreen />;
  return <App />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <TooltipProvider delay={300}>
    <Root />
  </TooltipProvider>
);

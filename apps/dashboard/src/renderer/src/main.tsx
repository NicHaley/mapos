import "@mapos/ui/globals.css";

import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@mapos/ui/components/tooltip";
import { useEffect, useState } from "react";
import { MapProvider } from "react-map-gl/maplibre";
import App from "./app";
import { OnboardingScreen } from "./components/onboarding/onboarding-screen";
import { MapViewportProvider } from "./contexts/map-viewport";
import { hydrateAppearance } from "./lib/appearance-boot";
import { THEME_KEY, getTheme, hydrateTheme, parseTheme } from "./lib/theme";

// Seed dark mode from onboarding staging (if any) for FOUC prevention before
// hydrateAppearance resolves the vault's appearance.json. Always subscribe to
// OS changes so System mode reacts even if the user switched into it after launch.
hydrateTheme(parseTheme(localStorage.getItem(THEME_KEY)));
const mq = window.matchMedia("(prefers-color-scheme: dark)");
mq.addEventListener("change", () => {
  if (getTheme() === "system") {
    document.documentElement.classList.toggle("dark", mq.matches);
  }
});

function Root(): React.JSX.Element | null {
  const [pending, setPending] = useState<boolean | null>(null);

  // Accent + map colour + theme hydrate from the vault's appearance.json alongside
  // the onboarding check; Root renders nothing until both resolve, so the
  // per-vault values are applied before anything paints (no flash of defaults).
  useEffect(() => {
    void Promise.all([window.api.onboarding.getState(), hydrateAppearance()]).then(([s]) =>
      setPending(s.pending)
    );
  }, []);

  if (pending === null) return null;
  if (pending) return <OnboardingScreen />;
  return (
    <MapProvider>
      <MapViewportProvider>
        <App />
      </MapViewportProvider>
    </MapProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <TooltipProvider delay={300}>
    <Root />
  </TooltipProvider>
);

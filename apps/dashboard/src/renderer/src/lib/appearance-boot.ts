import { hydrateAccent, parseAccent } from "./accent";
import { hydrateMapColor, parseMapColor } from "./map-color";
import { THEME_KEY, hydrateTheme, parseTheme } from "./theme";

/**
 * Hydrate accent + map colour + theme from the active vault's `.mapos/appearance.json`.
 * Never rejects. Root awaits this before first paint.
 *
 * During onboarding (no vault / IPC unavailable) falls back to in-memory defaults, with
 * theme optionally staged in localStorage so the onboarding pick survives the post-complete
 * reload. That staging key is promoted into appearance.json on the first successful vault read.
 */
export async function hydrateAppearance(): Promise<void> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await window.api.appearance.get();
  } catch {
    raw = null;
  }

  if (raw === null) {
    hydrateAccent(parseAccent(undefined));
    hydrateMapColor(parseMapColor(undefined));
    hydrateTheme(parseTheme(localStorage.getItem(THEME_KEY)));
    return;
  }

  hydrateAccent(parseAccent(raw.accent));
  hydrateMapColor(parseMapColor(raw.mapColor));

  if (raw.theme !== undefined) {
    hydrateTheme(parseTheme(raw.theme));
    localStorage.removeItem(THEME_KEY);
    return;
  }

  // Promote onboarding-staged theme into the vault once.
  const staged = localStorage.getItem(THEME_KEY);
  if (staged !== null) {
    const theme = parseTheme(staged);
    hydrateTheme(theme);
    try {
      const result = await window.api.appearance.set({ theme });
      if (result.ok) localStorage.removeItem(THEME_KEY);
    } catch {
      /* keep staging for next boot */
    }
    return;
  }

  hydrateTheme(parseTheme(undefined));
}

import { ACCENT_KEY, hydrateAccent, parseAccent } from "./accent";
import { MAP_COLOR_KEY, hydrateMapColor, parseMapColor } from "./map-color";
import { THEME_KEY, hydrateTheme, parseTheme } from "./theme";

/**
 * Hydrate accent + map colour + theme from the active vault's `.mapos/appearance.json`,
 * migrating values from the legacy global localStorage keys once. Never rejects.
 *
 * Root awaits this before first paint, so the hydrated values are applied with
 * no flash of defaults. During onboarding (no vault, IPC handler unregistered)
 * or on IPC failure it falls back to legacy/default values without persisting
 * or deleting anything — migration only happens against a booted vault.
 */
export async function hydrateAppearance(): Promise<void> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await window.api.appearance.get();
  } catch {
    raw = null;
  }

  const legacyAccent = localStorage.getItem(ACCENT_KEY);
  const legacyMapColor = localStorage.getItem(MAP_COLOR_KEY);
  const legacyTheme = localStorage.getItem(THEME_KEY);

  if (raw === null) {
    hydrateAccent(parseAccent(legacyAccent));
    hydrateMapColor(parseMapColor(legacyMapColor));
    hydrateTheme(parseTheme(legacyTheme));
    return;
  }

  const migrate: { accent?: string; mapColor?: string; theme?: string } = {};

  hydrateAccent(parseAccent(raw.accent !== undefined ? raw.accent : legacyAccent));
  if (raw.accent === undefined && legacyAccent !== null) {
    migrate.accent = parseAccent(legacyAccent);
  }

  hydrateMapColor(parseMapColor(raw.mapColor !== undefined ? raw.mapColor : legacyMapColor));
  if (raw.mapColor === undefined && legacyMapColor !== null) {
    migrate.mapColor = parseMapColor(legacyMapColor);
  }

  hydrateTheme(parseTheme(raw.theme !== undefined ? raw.theme : legacyTheme));
  if (raw.theme === undefined && legacyTheme !== null) {
    migrate.theme = parseTheme(legacyTheme);
  }

  if (migrate.accent === undefined && migrate.mapColor === undefined && migrate.theme === undefined)
    return;
  try {
    const result = await window.api.appearance.set(migrate);
    // Only drop the legacy values once they're safely on disk; a failed write
    // leaves them in place so the next boot retries the migration.
    if (result.ok) {
      if (migrate.accent !== undefined) localStorage.removeItem(ACCENT_KEY);
      if (migrate.mapColor !== undefined) localStorage.removeItem(MAP_COLOR_KEY);
      if (migrate.theme !== undefined) localStorage.removeItem(THEME_KEY);
    }
  } catch {
    /* retry next boot */
  }
}

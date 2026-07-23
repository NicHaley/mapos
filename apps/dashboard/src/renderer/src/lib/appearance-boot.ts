import { ACCENT_KEY, hydrateAccent, parseAccent } from "./accent";
import { hydrateMapColor, parseMapColor } from "./map-color";
import { THEME_KEY, hydrateTheme, parseTheme } from "./theme";

/**
 * Hydrate accent + map colour + theme from the active vault's `.mapos/appearance.json`.
 * Never rejects. Root awaits this before first paint.
 *
 * During onboarding (no vault / IPC unavailable) falls back to in-memory defaults, with
 * accent + theme optionally staged in localStorage so the onboarding pick survives the
 * post-complete reload. Those staging keys are promoted into appearance.json on the first
 * successful vault read.
 */
export async function hydrateAppearance(): Promise<void> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await window.api.appearance.get();
  } catch {
    raw = null;
  }

  if (raw === null) {
    hydrateAccent(parseAccent(localStorage.getItem(ACCENT_KEY)));
    hydrateMapColor(parseMapColor(undefined));
    hydrateTheme(parseTheme(localStorage.getItem(THEME_KEY)));
    return;
  }

  hydrateMapColor(parseMapColor(raw.mapColor));
  await hydrateStaged(raw, "accent", ACCENT_KEY, parseAccent, hydrateAccent);
  await hydrateStaged(raw, "theme", THEME_KEY, parseTheme, hydrateTheme);
}

/**
 * Resolve one appearance field: prefer the value already in appearance.json (clearing any
 * stale staging), else promote an onboarding-staged localStorage value into the vault once,
 * else fall back to the parsed default.
 */
async function hydrateStaged<T>(
  raw: Record<string, unknown>,
  field: "accent" | "theme",
  stagingKey: string,
  parse: (value: unknown) => T,
  hydrate: (value: T) => void
): Promise<void> {
  if (raw[field] !== undefined) {
    hydrate(parse(raw[field]));
    localStorage.removeItem(stagingKey);
    return;
  }

  const staged = localStorage.getItem(stagingKey);
  if (staged !== null) {
    const value = parse(staged);
    hydrate(value);
    try {
      const result = await window.api.appearance.set({ [field]: staged });
      if (result.ok) localStorage.removeItem(stagingKey);
    } catch {
      /* keep staging for next boot */
    }
    return;
  }

  hydrate(parse(undefined));
}

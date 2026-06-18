import type { ProviderView } from "@shared/ai-providers";
import { SettingsSheet } from "../settings-sheet";
import { KnownProviderAuth } from "./known-provider-auth";

/**
 * Drawer wrapper for a known (catalog) provider's auth. Mirrors the custom-endpoint editor: adding
 * or managing a provider opens a sheet rather than expanding the Sources row inline, so the connect
 * step (sign in / paste a key) and the disconnect/update step share one consistent surface.
 */
export function KnownProviderAuthSheet({
  open,
  onOpenChange,
  provider,
  onChanged
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider being managed; null while no row is targeted. */
  provider: ProviderView | null;
  onChanged: () => void;
}): React.JSX.Element | null {
  if (!provider) return null;
  return (
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Connect ${provider.label}`}
      description="Sign in or paste an API key. MapOS fetches available models live once connected."
    >
      <KnownProviderAuth provider={provider} onChanged={onChanged} padded={false} />
    </SettingsSheet>
  );
}

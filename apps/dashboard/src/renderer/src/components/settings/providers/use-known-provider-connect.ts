import { useEffect, useState } from "react";

export type DeviceCode = { userCode: string; verificationUri: string };

export type KnownProviderConnect = {
  busy: boolean;
  error: string | null;
  keyDraft: string;
  setKeyDraft: (v: string) => void;
  reveal: boolean;
  setReveal: (updater: (r: boolean) => boolean) => void;
  /** OAuth progress strings streamed from main ("Complete sign-in in your browser…"). */
  oauthMsg: string | null;
  oauthUrl: string | null;
  deviceCode: DeviceCode | null;
  /** Whether the typed key is long enough to save. */
  canSaveKey: boolean;
  /** Resolve to true on success so a caller (the drawer) can close itself only when connected. */
  signIn: () => Promise<boolean>;
  saveKey: () => Promise<boolean>;
  disconnect: () => Promise<boolean>;
  cancelOauth: () => void;
};

/**
 * Connect/disconnect logic for a known (Pi catalog) provider, shared by the onboarding inline panel
 * and the settings connect drawer so the two surfaces never drift. Auth lives in Pi's AuthStorage
 * keyed by provider name, independent of the `ai.json` row.
 *
 * When `persistOnConnect` is set, a successful sign-in / key save also writes the provider row (the
 * deferred-add flow: nothing is persisted until the user actually connects). Existing-row surfaces
 * leave it off since the row is already there.
 */
export function useKnownProviderConnect(
  name: string,
  { onChanged, persistOnConnect = false }: { onChanged: () => void; persistOnConnect?: boolean }
): KnownProviderConnect {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [reveal, setRevealState] = useState(false);
  const [oauthMsg, setOauthMsg] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);

  // Stream OAuth progress for this provider so the user sees "open your browser" (callback flow) or
  // a code to enter (device flow) rather than a bare spinner.
  useEffect(() => {
    return window.api.ai.onOAuthProgress((data) => {
      if (data.provider !== name) return;
      if (data.status === "awaiting-browser") {
        setOauthMsg("Complete sign-in in your browser…");
        if (data.url) setOauthUrl(data.url);
      } else if (data.status === "device-code") {
        if (data.userCode && data.verificationUri) {
          setDeviceCode({ userCode: data.userCode, verificationUri: data.verificationUri });
        }
        setOauthMsg(null);
        setOauthUrl(null);
      } else if (data.status === "starting") {
        setOauthMsg("Starting…");
      } else if (data.status === "done" || data.status === "error") {
        setOauthMsg(null);
        setOauthUrl(null);
        setDeviceCode(null);
      } else {
        setOauthMsg(data.status);
      }
    });
  }, [name]);

  // Persist the provider row only once auth succeeds, so an abandoned connect leaves nothing behind.
  async function persistIfNeeded(): Promise<void> {
    if (persistOnConnect) await window.api.ai.addKnownProvider(name);
  }

  async function signIn(): Promise<boolean> {
    setBusy(true);
    setError(null);
    setDeviceCode(null);
    const result = await window.api.ai.oauthLogin(name);
    setOauthMsg(null);
    setOauthUrl(null);
    setDeviceCode(null);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return false;
    }
    await persistIfNeeded();
    setBusy(false);
    onChanged();
    return true;
  }

  async function saveKey(): Promise<boolean> {
    if (keyDraft.trim().length === 0) return false;
    setBusy(true);
    setError(null);
    const result = await window.api.ai.setApiKey(name, keyDraft.trim());
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return false;
    }
    await persistIfNeeded();
    setBusy(false);
    setKeyDraft("");
    onChanged();
    return true;
  }

  async function disconnect(): Promise<boolean> {
    setBusy(true);
    setError(null);
    await window.api.ai.disconnect(name);
    setBusy(false);
    onChanged();
    return true;
  }

  function cancelOauth(): void {
    void window.api.ai.oauthCancel();
  }

  return {
    busy,
    error,
    keyDraft,
    setKeyDraft,
    reveal,
    setReveal: setRevealState,
    oauthMsg,
    oauthUrl,
    deviceCode,
    canSaveKey: keyDraft.trim().length > 0,
    signIn,
    saveKey,
    disconnect,
    cancelOauth
  };
}

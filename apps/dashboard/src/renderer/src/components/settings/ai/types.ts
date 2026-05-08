export type AiSettingsState = Awaited<ReturnType<typeof window.api.aiConfig.getSettingsState>>;
export type CustomEndpoint = AiSettingsState["local"]["advanced"]["endpoints"][number];

export type DetectionState = "checking" | "running" | "stopped";

/** A row the user has clicked to inspect. The detail sheet renders different content per type. */
export type SheetTarget =
  | { type: "cloud"; modelId: string }
  | { type: "local"; modelId: string }
  | { type: "custom"; endpointId: string };

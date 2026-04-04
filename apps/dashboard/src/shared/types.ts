export type PlaceRecord = {
  geometry?: string; // GeoJSON geometry JSON string; omitted when the file has no location
  title: string;
  color?: string;
  type: string;
  tags?: string[];
  // Canonical place identity in MapOS (replaces separate id field).
  filePath: string;
  /** When set, PlaceCard shows preview content without reading the file; no save/rename. */
  previewMarkdown?: string;
};

export type PlaceUpdate =
  | { event: "add" | "change"; place: PlaceRecord }
  | { event: "unlink"; filePath: string };

export type OverlayPoint = {
  id: string;
  lat: number;
  lng: number;
  title: string;
};

export type OverlayLine = {
  id: string;
  coordinates: [number, number][];
  title?: string;
};

export type OverlayPolygon = {
  id: string;
  coordinates: [number, number][][];
  title?: string;
};

export type FileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
};

export type PersistedToolCall = {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
};

export type ChatToolCallPayload = {
  id: string;
  name: string;
  input: unknown;
};

export type ChatToolResultPayload = {
  tool_use_id: string;
  content: string;
  isError: boolean;
};

export type PersistedMessage = {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: PersistedToolCall[];
  timestamp: string;
};

export type ConversationMeta = {
  id: string;
  created_at: string;
  updated_at: string;
  messageCount: number;
  preview: string;
};

export type VaultOperation = {
  path: string;
  previousContent: string | null; // null = file was created this turn (undo = delete it)
};

export type UndoEntry = {
  operations: VaultOperation[];
};

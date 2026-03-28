export type PlaceRecord = {
  geometry: string; // GeoJSON geometry JSON string (Point, LineString, Polygon, …)
  title: string;
  color?: string;
  type: string;
  tags?: string[];
  // Canonical place identity in MapOS (replaces separate id field).
  filePath: string;
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

export type PersistedMessage = {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  timestamp: string;
};

export type ConversationMeta = {
  id: string;
  created_at: string;
  updated_at: string;
  messageCount: number;
  preview: string;
};

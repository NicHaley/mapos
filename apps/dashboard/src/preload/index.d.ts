import type { ElectronAPI } from "@electron-toolkit/preload";
import type {
  ConversationMeta,
  FileNode,
  OverlayLine,
  OverlayPoint,
  OverlayPolygon,
  PersistedMessage,
  PlaceRecord,
  PlaceUpdate
} from "../shared/types";

type ViewportState = {
  north: number;
  south: number;
  east: number;
  west: number;
  centerLat: number;
  centerLng: number;
  zoom: number;
};

declare global {
  interface Window {
    electron: ElectronAPI;
    api: {
      places: {
        requestInitial: () => void;
        queryBounds: (bounds: {
          north: number;
          south: number;
          east: number;
          west: number;
        }) => Promise<PlaceRecord[]>;
        getByPath: (filePath: string) => Promise<PlaceRecord | null>;
        onInitial: (cb: (places: PlaceRecord[]) => void) => void;
        onUpdated: (cb: (update: PlaceUpdate) => void) => void;
        removeListeners: () => void;
      };
      map: {
        onOverlay: (
          cb: (data: {
            layerName: string;
            points: OverlayPoint[];
            lines: OverlayLine[];
            polygons: OverlayPolygon[];
          }) => void
        ) => void;
        onOverlayClear: (cb: () => void) => void;
        sendViewport: (data: ViewportState) => void;
        onPanTo: (cb: (data: { lat: number; lng: number; zoom?: number }) => void) => void;
        removeListeners: () => void;
      };
      fs: {
        listDir: () => Promise<FileNode[]>;
        readFile: (filePath: string) => Promise<{ raw: string; body: string } | { error: string }>;
        writeFile: (
          filePath: string,
          content: string
        ) => Promise<{ success: boolean; error?: string }>;
        writePlaceBody: (
          filePath: string,
          body: string
        ) => Promise<{ success: boolean; error?: string }>;
        renameFile: (
          oldPath: string,
          newName: string
        ) => Promise<{ success: true; newPath: string } | { success: false; error: string }>;
        onChange: (cb: () => void) => void;
        removeListeners: () => void;
      };
      chat: {
        send: (message: string) => void;
        abort: () => void;
        reset: () => void;
        loadHistory: () => Promise<PersistedMessage[]>;
        listConversations: () => Promise<ConversationMeta[]>;
        switchConversation: (id: string) => Promise<PersistedMessage[]>;
        deleteConversation: (id: string) => Promise<void>;
        onChunk: (cb: (text: string) => void) => void;
        onThinkingChunk: (cb: (text: string) => void) => void;
        onDone: (cb: () => void) => void;
        onError: (cb: (msg: string) => void) => void;
        removeListeners: () => void;
      };
    };
  }
}

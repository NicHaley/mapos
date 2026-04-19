import type { ElectronAPI } from "@electron-toolkit/preload";
import type {
  ChatToolCallPayload,
  ChatToolResultPayload,
  ConversationLoadResult,
  ConversationMeta,
  FileNode,
  MapOverlayPayload,
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
        queryFolderAll: (folderPath: string) => Promise<PlaceRecord[]>;
        queryFolderBounds: (args: {
          folderPath: string;
          bounds: { north: number; south: number; east: number; west: number };
        }) => Promise<PlaceRecord[]>;
        getByPath: (filePath: string) => Promise<PlaceRecord | null>;
        onInitial: (cb: (places: PlaceRecord[]) => void) => void;
        onUpdated: (cb: (update: PlaceUpdate) => void) => void;
        removeListeners: () => void;
      };
      map: {
        onOverlay: (cb: (data: MapOverlayPayload) => void) => void;
        onOverlayClear: (cb: () => void) => void;
        sendViewport: (data: ViewportState) => void;
        onPanTo: (cb: (data: { lat: number; lng: number; zoom?: number }) => void) => void;
        removeListeners: () => void;
        removeOverlayListeners: () => void;
      };
      fs: {
        listDir: () => Promise<FileNode[]>;
        readFile: (
          filePath: string
        ) => Promise<
          { raw: string; body: string; frontmatter: Record<string, unknown> } | { error: string }
        >;
        writeFile: (
          filePath: string,
          content: string
        ) => Promise<{ success: boolean; error?: string }>;
        writePlaceBody: (
          filePath: string,
          body: string
        ) => Promise<{ success: boolean; error?: string }>;
        writeFrontmatterProperty: (
          filePath: string,
          key: string,
          value: unknown
        ) => Promise<{ success: boolean; error?: string }>;
        reorderFrontmatter: (
          filePath: string,
          keyOrder: string[]
        ) => Promise<{ success: boolean; error?: string }>;
        renameFile: (
          oldPath: string,
          newName: string
        ) => Promise<{ success: true; newPath: string } | { success: false; error: string }>;
        moveInto: (
          sourcePath: string,
          destinationFolderPath: string
        ) => Promise<{ success: true; newPath: string } | { success: false; error: string }>;
        deletePath: (
          targetPath: string
        ) => Promise<{ success: true } | { success: false; error: string }>;
        revealInFinder: (targetPath: string) => Promise<void>;
        createNoteFile: (args: {
          parentFolderPath: string | null;
          lat?: number;
          lng?: number;
          includePlaceFrontmatterDefaults?: boolean;
        }) => Promise<{ success: true; filePath: string } | { success: false; error: string }>;
        getVaultRoot: () => Promise<string>;
        createFolder: (args: {
          parentFolderPath: string;
          folderName: string;
        }) => Promise<{ success: true; folderPath: string } | { success: false; error: string }>;
        readGeoJson: (filePath: string) => Promise<Record<string, unknown> | null>;
        geoJsonFilesInFolder: (folderPath: string) => Promise<string[]>;
        onChange: (cb: () => void) => void;
        removeListeners: () => void;
      };
      mapos: {
        getVaultsConfig: () => Promise<{ vaults: string[]; activeVaultPath: string }>;
        setFolderAsVault: () => Promise<
          { canceled: true } | { ok: false; error: string } | { ok: true; vaults: string[] }
        >;
        createNewVault: () => Promise<
          | { canceled: true }
          | { ok: false; error: string }
          | { ok: true; path: string; vaults: string[] }
        >;
        switchVault: (vaultPath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
      };
      properties: {
        listAllKeys: () => Promise<string[]>;
        valuesForKey: (key: string) => Promise<string[]>;
      };
      chat: {
        send: (message: string) => void;
        abort: () => void;
        reset: () => void;
        clearOverlay: () => void;
        loadHistory: () => Promise<ConversationLoadResult>;
        listConversations: () => Promise<ConversationMeta[]>;
        switchConversation: (id: string) => Promise<ConversationLoadResult>;
        deleteConversation: (id: string) => Promise<void>;
        onChunk: (cb: (text: string) => void) => void;
        onThinkingChunk: (cb: (text: string) => void) => void;
        onDone: (cb: (data: { canUndo: boolean }) => void) => void;
        undo: () => Promise<{ success: boolean; error?: string; errors?: string[] }>;
        onError: (cb: (msg: string) => void) => void;
        onToolCall: (cb: (data: ChatToolCallPayload) => void) => void;
        onToolResult: (cb: (data: ChatToolResultPayload) => void) => void;
        removeListeners: () => void;
      };
    };
  }
}

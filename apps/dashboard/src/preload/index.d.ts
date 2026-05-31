import type {
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest,
  TileStyleRequest
} from "@mapos/contracts";
import type { ElectronAPI } from "@electron-toolkit/preload";
import type {
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatToolCallPayload,
  ChatToolResultPayload,
  ConversationLoadResult,
  ConversationMeta,
  FileNode,
  InstalledRegionPack,
  MapOverlayPayload,
  OverlayLine,
  OverlayPoint,
  OverlayPolygon,
  PlaceRecord,
  PlaceUpdate,
  PropertyType,
  RegionDownloadProgress,
  RegionManifest
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
          geometryWkt?: string;
          includePlaceFrontmatterDefaults?: boolean;
        }) => Promise<{ success: true; filePath: string } | { success: false; error: string }>;
        getVaultRoot: () => Promise<string>;
        createFolder: (args: {
          parentFolderPath: string;
          folderName: string;
        }) => Promise<{ success: true; folderPath: string } | { success: false; error: string }>;
        readGeoJson: (filePath: string) => Promise<Record<string, unknown> | null>;
        geoJsonFilesInFolder: (folderPath: string) => Promise<string[]>;
        writeGeoJsonProperty: (
          filePath: string,
          key: string,
          value: unknown
        ) => Promise<{ success: boolean; error?: string }>;
        onChange: (cb: () => void) => void;
        /** Returns a cleanup function; call it to unregister. */
        onFileContentChanged: (cb: (payload: { filePath: string }) => void) => () => void;
        removeListeners: () => void;
      };
      mapos: {
        getVaultsConfig: () => Promise<{ vaults: string[]; activeVaultPath: string }>;
        setFolderAsVault: () => Promise<
          { canceled: true } | { ok: false; error: string } | { ok: true; vaults: string[] }
        >;
        createNewVault: (name: string) => Promise<
          | { canceled: true }
          | { ok: false; error: string }
          | { ok: true; path: string; vaults: string[] }
        >;
        switchVault: (vaultPath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
        renameVault: (
          newName: string
        ) => Promise<{ ok: true; newPath: string } | { ok: false; error: string }>;
        deleteVault: () => Promise<{ ok: true } | { ok: false; error: string }>;
      };
      properties: {
        listAllKeys: () => Promise<Array<{ key: string; type: PropertyType }>>;
        valuesForKey: (key: string) => Promise<string[]>;
      };
      window: {
        isFullscreen: () => Promise<boolean>;
        /** Returns a cleanup function; call it to unregister. */
        onFullscreenChange: (cb: (isFullscreen: boolean) => void) => () => void;
      };
      aiConfig: {
        getStatus: () => Promise<{
          configured: boolean;
          activeProvider: "anthropic" | "local";
          model: string;
        }>;
        getSettingsState: () => Promise<{
          provider: "anthropic" | "local";
          anthropic: { model: string; hasApiKey: boolean };
          local: {
            mode: "magic" | "advanced";
            magic: { model: string };
            advanced: {
              endpoints: Array<{
                id: string;
                label: string;
                baseUrl: string;
                model: string;
                hasAuthToken: boolean;
              }>;
              activeId: string | null;
            };
          };
        }>;
        update: (update: {
          provider?: "anthropic" | "local";
          anthropic?: { model?: string; apiKey?: string | null };
          local?: {
            mode?: "magic" | "advanced";
            magic?: { model?: string };
            advanced?: { activeId?: string | null };
          };
        }) => Promise<{ ok: true } | { ok: false; error: string }>;
        testConnection: (draft: {
          provider: "anthropic" | "local";
          apiKey?: string;
          baseUrl?: string;
          authToken?: string;
          model?: string;
        }) => Promise<{ ok: true } | { ok: false; error: string }>;
        addCustomEndpoint: (input: {
          label?: string;
          baseUrl?: string;
          model?: string;
          authToken?: string | null;
        }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
        updateCustomEndpoint: (
          id: string,
          patch: {
            label?: string;
            baseUrl?: string;
            model?: string;
            authToken?: string | null;
          }
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
        removeCustomEndpoint: (
          id: string
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
        ollamaDetect: (baseUrl: string) => Promise<{ running: boolean; baseUrl: string }>;
        ollamaListInstalled: (baseUrl: string) => Promise<string[]>;
        ollamaPull: (
          baseUrl: string,
          modelId: string
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
        ollamaCancelPull: (baseUrl: string, modelId: string) => Promise<{ ok: true }>;
        ollamaDelete: (
          baseUrl: string,
          modelId: string
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
        /** Returns a cleanup function. */
        onPullProgress: (
          cb: (data: { modelId: string; percent?: number; status?: string }) => void
        ) => () => void;
        /** Returns a cleanup function. */
        onChanged: (cb: () => void) => () => void;
      };
      updater: {
        install: () => Promise<void>;
        retry: () => Promise<void>;
        /** Returns a cleanup function. */
        onAvailable: (cb: (data: { version: string; releaseDate: string }) => void) => () => void;
        /** Returns a cleanup function. */
        onDownloaded: (cb: (data: { version: string }) => void) => () => void;
        /** Returns a cleanup function. */
        onProgress: (cb: (data: { percent: number }) => void) => () => void;
        /** Returns a cleanup function. */
        onError: (cb: (data: { message: string }) => void) => () => void;
      };
      chat: {
        send: (convId: string, message: string) => void;
        abort: (convId: string) => void;
        clearOverlay: (convId: string) => void;
        loadConversation: (convId: string) => Promise<ConversationLoadResult>;
        listConversations: () => Promise<ConversationMeta[]>;
        deleteConversation: (id: string) => Promise<void>;
        onChunk: (cb: (data: ChatChunkPayload) => void) => void;
        onThinkingChunk: (cb: (data: ChatChunkPayload) => void) => void;
        onDone: (cb: (data: ChatDonePayload) => void) => void;
        undo: (
          convId: string
        ) => Promise<{ success: boolean; error?: string; errors?: string[] }>;
        onError: (cb: (data: ChatErrorPayload) => void) => void;
        onToolCall: (cb: (data: ChatToolCallPayload) => void) => void;
        onToolResult: (cb: (data: ChatToolResultPayload) => void) => void;
        removeListeners: () => void;
      };
      services: {
        geocodingForward: (req: GeocodeForwardRequest) => Promise<GeocodeResult[]>;
        geocodingReverse: (req: GeocodeReverseRequest) => Promise<GeocodeResult[]>;
        tilesStyleUrl: (req: TileStyleRequest) => Promise<string>;
      };
      regions: {
        getManifest: (force?: boolean) => Promise<RegionManifest>;
        listLocal: () => Promise<InstalledRegionPack[]>;
        download: (region: string, version?: string) => Promise<void>;
        cancelDownload: (region: string) => Promise<void>;
        delete: (region: string) => Promise<void>;
        onProgress: (cb: (data: RegionDownloadProgress) => void) => () => void;
        onChanged: (cb: () => void) => () => void;
      };
    };
  }
}

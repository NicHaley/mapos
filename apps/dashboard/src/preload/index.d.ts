import type { ElectronAPI } from "@electron-toolkit/preload";
import type {
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest,
  TileStyleRequest
} from "@mapos/contracts";
import type { ModelCapabilities } from "../shared/ai-models";
import type {
  AiState,
  FetchedModel,
  KnownProviderOption,
  ProviderInput
} from "../shared/ai-providers";
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
  MapOverlayLayer,
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
      app: {
        getVersion: () => Promise<string>;
      };
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
        onOverlayAdd: (cb: (layer: MapOverlayLayer) => void) => void;
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
          | { raw: string; body: string; frontmatter: Record<string, unknown>; cover?: string }
          | { error: string }
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
        writeFrontmatterProperties: (
          filePath: string,
          properties: Record<string, unknown>
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
        importAttachment: (args: {
          suggestedName?: string;
          bytes: Uint8Array;
        }) => Promise<
          { success: true; relPath: string; absPath: string } | { success: false; error: string }
        >;
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
        createNewVault: (
          name: string
        ) => Promise<
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
      ai: {
        getState: () => Promise<AiState>;
        getStatus: () => Promise<{
          configured: boolean;
          activeProvider: "anthropic" | "local";
          model: string;
        }>;
        addProvider: (
          input: ProviderInput
        ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
        updateProvider: (
          id: string,
          patch: ProviderInput
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
        removeProvider: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
        setActive: (
          providerId: string,
          model: string,
          capabilities: ModelCapabilities
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
        clearActive: () => Promise<{ ok: true }>;
        listModels: (
          providerId: string
        ) => Promise<{ ok: true; models: FetchedModel[] } | { ok: false; error: string }>;
        listKnownProviders: () => Promise<KnownProviderOption[]>;
        addKnownProvider: (
          provider: string
        ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
        setApiKey: (
          provider: string,
          key: string
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
        oauthLogin: (provider: string) => Promise<{ ok: true } | { ok: false; error: string }>;
        oauthCancel: () => Promise<{ ok: true }>;
        disconnect: (provider: string) => Promise<{ ok: true }>;
        /** Returns a cleanup function. */
        onOAuthProgress: (
          cb: (data: {
            provider: string;
            status: string;
            url?: string;
            userCode?: string;
            verificationUri?: string;
          }) => void
        ) => () => void;
        /** Returns a cleanup function. */
        onChanged: (cb: () => void) => () => void;
      };
      updater: {
        install: () => Promise<void>;
        retry: () => Promise<void>;
        check: () => Promise<
          | { ok: true; current: string; latest: string; available: boolean }
          | { ok: false; current: string; error: string }
        >;
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
        loadConversation: (convId: string) => Promise<ConversationLoadResult>;
        listConversations: () => Promise<ConversationMeta[]>;
        deleteConversation: (id: string) => Promise<void>;
        onChunk: (cb: (data: ChatChunkPayload) => void) => void;
        onThinkingChunk: (cb: (data: ChatChunkPayload) => void) => void;
        onDone: (cb: (data: ChatDonePayload) => void) => void;
        undo: (convId: string) => Promise<{ success: boolean; error?: string; errors?: string[] }>;
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
      wiki: {
        imageLookup: (qid: string) => Promise<{
          thumbUrl: string;
          fileName: string;
          pageUrl: string;
        } | null>;
        importImage: (
          qid: string
        ) => Promise<
          { success: true; relPath: string; pageUrl: string } | { success: false; error: string }
        >;
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

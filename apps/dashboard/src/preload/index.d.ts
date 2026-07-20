import type { ElectronAPI } from "@electron-toolkit/preload";
import type {
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest,
  TileStyleRequest
} from "@mapos/contracts";
import type {
  FileNode,
  InstalledRegionPack,
  MapOverlayLayer,
  McpConnectionInfo,
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

type NavTabInfo = { path: string; kind: "place" | "folder"; title: string };

declare global {
  interface Window {
    electron: ElectronAPI;
    api: {
      app: {
        getVersion: () => Promise<string>;
      };
      clipboard: {
        writeText: (text: string) => Promise<void>;
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
      nav: {
        sendNavState: (data: {
          active: NavTabInfo | null;
          activeIndex: number;
          tabs: NavTabInfo[];
        }) => void;
        onOpenFile: (cb: (data: { path: string }) => void) => void;
        removeListeners: () => void;
      };
      geo: {
        onLocateRequest: (cb: (data: { id: string; reveal: boolean }) => void) => void;
        sendLocateReply: (
          data:
            | { id: string; ok: true; lat: number; lng: number; accuracy: number }
            | { id: string; ok: false; error: string }
        ) => void;
        removeListeners: () => void;
      };
      fs: {
        listDir: () => Promise<FileNode[]>;
        readFile: (filePath: string) => Promise<
          | {
              raw: string;
              body: string;
              frontmatter: Record<string, unknown>;
              cover?: string;
              coverSource?: string;
            }
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
      appearance: {
        get: () => Promise<Record<string, unknown>>;
        set: (patch: {
          accent?: string | null;
          mapColor?: string | null;
          theme?: string | null;
        }) => Promise<{ ok: true } | { ok: false; error: string }>;
      };
      onboarding: {
        getState: () => Promise<{ pending: boolean }>;
        pickCreateLocation: (
          name: string
        ) => Promise<
          | { canceled: true }
          | { ok: false; error: string }
          | { ok: true; targetPath: string; parentPath: string }
        >;
        pickExistingVault: () => Promise<
          { canceled: true } | { ok: false; error: string } | { ok: true; path: string }
        >;
        complete: (
          draft:
            | { kind: "create"; targetPath: string; name: string }
            | { kind: "existing"; path: string }
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
      };
      mapos: {
        getVaultsConfig: () => Promise<{ vaults: string[]; activeVaultPath: string }>;
        setFolderAsVault: () => Promise<
          | { canceled: true }
          | { ok: false; error: string }
          | { ok: true; path: string; vaults: string[] }
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
      mcp: {
        getConnectionInfo: () => Promise<McpConnectionInfo>;
        setEnabled: (enabled: boolean) => Promise<McpConnectionInfo>;
        regenerateToken: () => Promise<McpConnectionInfo>;
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
      system: {
        openLocationSettings: () => Promise<{ ok: boolean }>;
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

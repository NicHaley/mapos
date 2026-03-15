import type { ElectronAPI } from "@electron-toolkit/preload";

type PlaceRecord = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  status: string;
  type: string;
  category?: string;
  tags?: string[];
  filePath: string;
};

type PlaceUpdate =
  | { event: "add" | "change"; place: PlaceRecord }
  | { event: "unlink"; filePath: string };

type OverlayPoint = {
  id: string;
  lat: number;
  lng: number;
  title: string;
};

type OverlayLine = {
  id: string;
  coordinates: [number, number][];
  title?: string;
};

type OverlayPolygon = {
  id: string;
  coordinates: [number, number][][];
  title?: string;
};

type FileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
};

declare global {
  interface Window {
    electron: ElectronAPI;
    api: {
      places: {
        requestInitial: () => void;
        queryBounds: (bounds: { north: number; south: number; east: number; west: number }) => Promise<PlaceRecord[]>;
        onInitial: (cb: (places: PlaceRecord[]) => void) => void;
        onUpdated: (cb: (update: PlaceUpdate) => void) => void;
        removeListeners: () => void;
      };
      map: {
        onOverlay: (cb: (data: { layerName: string; points: OverlayPoint[]; lines: OverlayLine[]; polygons: OverlayPolygon[] }) => void) => void;
        onOverlayClear: (cb: () => void) => void;
        removeListeners: () => void;
      };
      fs: {
        listDir: () => Promise<FileNode[]>;
        onChange: (cb: () => void) => void;
        removeListeners: () => void;
      };
      chat: {
        send: (message: string) => void;
        abort: () => void;
        reset: () => void;
        onChunk: (cb: (text: string) => void) => void;
        onDone: (cb: () => void) => void;
        onError: (cb: (msg: string) => void) => void;
        removeListeners: () => void;
      };
    };
  }
}

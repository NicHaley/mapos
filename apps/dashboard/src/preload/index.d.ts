import { ElectronAPI } from '@electron-toolkit/preload'

type PlaceRecord = {
  id: string
  lat: number
  lng: number
  title: string
  status: string
  type: string
  category?: string
  tags?: string[]
  filePath: string
}

type PlaceUpdate =
  | { event: 'add' | 'change'; place: PlaceRecord }
  | { event: 'unlink'; filePath: string }

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      places: {
        requestInitial: () => void
        onInitial: (cb: (places: PlaceRecord[]) => void) => void
        onUpdated: (cb: (update: PlaceUpdate) => void) => void
        removeListeners: () => void
      }
    }
  }
}

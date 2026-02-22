import { useCallback, useEffect, useState } from 'react'
import MapGL, { Marker } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'

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

const STATUS_COLORS: Record<string, string> = {
  'want-to-go': '#3b82f6',
  visited: '#22c55e',
  maybe: '#f59e0b'
}

export default function MapView(): React.JSX.Element {
  const [places, setPlaces] = useState<Map<string, PlaceRecord>>(new Map())

  const applyUpdate = useCallback((update: PlaceUpdate) => {
    setPlaces((prev) => {
      const next = new Map(prev)
      if (update.event === 'unlink') next.delete(update.filePath)
      else next.set(update.place.filePath, update.place)
      return next
    })
  }, [])

  useEffect(() => {
    window.api.places.onInitial((initialPlaces) => {
      const m = new Map<string, PlaceRecord>()
      initialPlaces.forEach((p) => m.set(p.filePath, p))
      setPlaces(m)
    })
    window.api.places.onUpdated(applyUpdate as (u: unknown) => void)
    window.api.places.requestInitial()
    return () => {
      window.api.places.removeListeners()
    }
  }, [applyUpdate])

  return (
    <MapGL
      initialViewState={{ longitude: 0, latitude: 20, zoom: 2 }}
      style={{ width: '100vw', height: '100vh' }}
      mapStyle="https://tiles.openfreemap.org/styles/liberty"
    >
      {Array.from(places.values()).map((place) => (
        <Marker key={place.filePath} longitude={place.lng} latitude={place.lat} anchor="center">
          <div
            title={place.title}
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              backgroundColor: STATUS_COLORS[place.status] ?? '#6b7280',
              border: '2px solid white',
              boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
              cursor: 'pointer'
            }}
          />
        </Marker>
      ))}
    </MapGL>
  )
}

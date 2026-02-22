import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import chokidar from 'chokidar'
import matter from 'gray-matter'

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

async function parsePlaceFile(filePath: string): Promise<PlaceRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const { data, content } = matter(raw)
    if (typeof data.lat !== 'number' || typeof data.lng !== 'number') return null
    if (data.type === 'collection') return null
    const titleMatch = content.match(/^#\s+(.+)$/m)
    const title = titleMatch ? titleMatch[1].trim() : (data.id ?? filePath)
    return {
      id: data.id ?? '',
      lat: data.lat,
      lng: data.lng,
      title,
      status: data.status ?? '',
      type: data.type ?? 'place',
      category: data.category,
      tags: data.tags,
      filePath
    }
  } catch {
    return null
  }
}

function setupPlacesWatcher(mainWindow: BrowserWindow): void {
  const MAPOS_DIR = join(homedir(), 'MapOS')
  if (!existsSync(MAPOS_DIR)) {
    mkdirSync(MAPOS_DIR, { recursive: true })
  }

  const places = new Map<string, PlaceRecord>()
  let initialScanDone = false
  let pendingInitialSenders: Electron.WebContents[] = []

  const watcher = chokidar.watch(`${MAPOS_DIR}/**/*.md`, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 300 }
  })

  watcher.on('add', async (filePath) => {
    const place = await parsePlaceFile(filePath)
    if (place) {
      places.set(filePath, place)
      if (initialScanDone && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('places:updated', { event: 'add', place })
      }
    }
  })

  watcher.on('change', async (filePath) => {
    const place = await parsePlaceFile(filePath)
    if (place) {
      places.set(filePath, place)
    } else {
      places.delete(filePath)
    }
    if (initialScanDone && !mainWindow.isDestroyed()) {
      if (place) {
        mainWindow.webContents.send('places:updated', { event: 'change', place })
      } else {
        mainWindow.webContents.send('places:updated', { event: 'unlink', filePath })
      }
    }
  })

  watcher.on('unlink', (filePath) => {
    places.delete(filePath)
    if (initialScanDone && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('places:updated', { event: 'unlink', filePath })
    }
  })

  watcher.on('ready', () => {
    initialScanDone = true
    const allPlaces = Array.from(places.values())
    for (const sender of pendingInitialSenders) {
      if (!sender.isDestroyed()) {
        sender.send('places:initial', allPlaces)
      }
    }
    pendingInitialSenders = []
  })

  ipcMain.on('places:request-initial', (event) => {
    if (initialScanDone) {
      event.sender.send('places:initial', Array.from(places.values()))
    } else {
      pendingInitialSenders.push(event.sender)
    }
  })
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (is.dev) mainWindow.webContents.openDevTools()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' blob:",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https://tiles.openfreemap.org https://*.openfreemap.org",
            "connect-src 'self' https://tiles.openfreemap.org https://*.openfreemap.org",
            "worker-src 'self' blob:",
            "font-src 'self' data:"
          ].join('; ')
        ]
      }
    })
  })

  const mainWindow = createWindow()
  setupPlacesWatcher(mainWindow)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getChildren, getReclaimItem, pathsOverlap, reclaimItemMatches, scanPath } from './scanner.js'
import { analyzeDuplicates, fileMatches } from './duplicates.js'
import { listBenchmarkDrives, runBenchmark } from './benchmark.js'
import type { DuplicateCleanupRequest, DuplicateCleanupResult, ReclaimItem, ReclaimResult } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rendererHost = 'app.diskloom.local'
const rendererOrigin = `https://${rendererHost}`

function registerRendererProtocol() {
  const rendererRoot = path.resolve(__dirname, '../dist')
  protocol.handle('https', (request) => {
    const url = new URL(request.url)
    if (url.hostname !== rendererHost) {
      return net.fetch(request, { bypassCustomProtocolHandlers: true })
    }

    let pathname: string
    try { pathname = decodeURIComponent(url.pathname) }
    catch { return new Response('Bad request', { status: 400 }) }
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const filePath = path.resolve(rendererRoot, relativePath)
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${path.sep}`)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0c10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.VITE_DEV_SERVER_URL) void win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else void win.loadURL(rendererOrigin)
}

app.whenReady().then(() => {
  if (!process.env.VITE_DEV_SERVER_URL) registerRendererProtocol()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  electronVersion: process.versions.electron,
}))

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: os.homedir() })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('scan', async (event, target: string) => {
  const result = await scanPath(target, (progress) => event.sender.send('scan-progress', progress))
  return result
})
ipcMain.handle('get-children', (_event, scanId: string, target: string, offset?: number, limit?: number) => getChildren(scanId, target, offset, limit))
ipcMain.handle('get-reclaim-item', (_event, scanId: string, target: string) => getReclaimItem(scanId, target))
ipcMain.handle('trash-reclaim', async (_event, requested: ReclaimItem[]): Promise<ReclaimResult> => {
  const items = Array.isArray(requested) ? requested.filter((item) => item && typeof item.path === 'string' && typeof item.fingerprint === 'string').slice(0, 10_000) : []
  const outcomes: ReclaimResult['outcomes'] = []
  const approved: ReclaimItem[] = []
  const normalized = items.map((item) => ({ item, resolved: path.resolve(item.path) }))
  for (const { item, resolved } of normalized) {
    const overlap = approved.some((parent) => pathsOverlap(parent.path, resolved))
    if (overlap) { outcomes.push({ path: item.path, status: 'skipped', size: item.size, reason: 'This selection overlaps another selected item.' }); continue }
    if (!await reclaimItemMatches(item)) { outcomes.push({ path: item.path, status: 'skipped', size: item.size, reason: 'The item changed or is missing.' }); continue }
    approved.push(item)
  }
  for (const item of approved) {
    try { await shell.trashItem(item.path); outcomes.push({ path: item.path, status: 'trashed', size: item.size }) }
    catch (error) { outcomes.push({ path: item.path, status: 'failed', size: item.size, reason: error instanceof Error ? error.message : 'Could not move item to Trash.' }) }
  }
  return { outcomes, reclaimedBytes: outcomes.filter((item) => item.status === 'trashed').reduce((sum, item) => sum + item.size, 0) }
})
ipcMain.handle('reveal', (_event, target: string) => shell.showItemInFolder(target))
ipcMain.handle('open-path', (_event, target: string) => shell.openPath(target))
ipcMain.handle('trash', async (_event, target: string) => shell.trashItem(target))

let duplicateController: AbortController | null = null
ipcMain.handle('analyze-duplicates', async (event, target: string) => {
  duplicateController?.abort()
  const controller = new AbortController()
  duplicateController = controller
  try { return await analyzeDuplicates(target, controller.signal, (value) => event.sender.send('duplicate-progress', value)) }
  finally { if (duplicateController === controller) duplicateController = null }
})
ipcMain.handle('cancel-duplicate-analysis', () => { duplicateController?.abort() })
ipcMain.handle('trash-duplicates', async (_event, request: DuplicateCleanupRequest): Promise<DuplicateCleanupResult> => {
  const outcomes: DuplicateCleanupResult['outcomes'] = []
  for (const group of request.groups) {
    if (!group.retained || group.selected.some((file) => file.path === group.retained.path)) {
      outcomes.push(...group.selected.map((file) => ({ path: file.path, status: 'skipped' as const, reason: 'No protected copy was retained.' })))
      continue
    }
    if (!await fileMatches(group.retained)) {
      outcomes.push(...group.selected.map((file) => ({ path: file.path, status: 'skipped' as const, reason: 'The retained copy changed or is missing.' })))
      continue
    }
    for (const file of group.selected) {
      if (!await fileMatches(file)) { outcomes.push({ path: file.path, status: 'skipped', reason: 'File changed or is missing.' }); continue }
      try { await shell.trashItem(file.path); outcomes.push({ path: file.path, status: 'trashed' }) }
      catch (error) { outcomes.push({ path: file.path, status: 'failed', reason: error instanceof Error ? error.message : 'Could not move file to Trash.' }) }
    }
  }
  return { outcomes }
})

let benchmarkController: AbortController | null = null
ipcMain.handle('list-benchmark-drives', () => listBenchmarkDrives())
ipcMain.handle('get-system-memory', () => os.totalmem())
ipcMain.handle('run-benchmark', async (event, request: { target: string; sizeMiB: number; runs: number }) => {
  benchmarkController?.abort()
  const controller = new AbortController()
  benchmarkController = controller
  try { return await runBenchmark(request, controller.signal, (value) => event.sender.send('benchmark-progress', value)) }
  finally { if (benchmarkController === controller) benchmarkController = null }
})
ipcMain.handle('cancel-benchmark', () => { benchmarkController?.abort() })

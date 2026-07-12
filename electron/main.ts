import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { scanPath } from './scanner.js'
import { analyzeDuplicates, fileMatches } from './duplicates.js'
import type { DuplicateCleanupRequest, DuplicateCleanupResult } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
  else void win.loadFile(path.join(__dirname, '../dist/index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: os.homedir() })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('scan', async (event, target: string) => {
  const result = await scanPath(target, (progress) => event.sender.send('scan-progress', progress))
  return result
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

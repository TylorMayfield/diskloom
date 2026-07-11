import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { scanPath } from './scanner.js'

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

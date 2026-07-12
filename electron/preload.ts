import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('diskDaddy', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  scan: (path: string) => ipcRenderer.invoke('scan', path),
  reveal: (path: string) => ipcRenderer.invoke('reveal', path),
  openPath: (path: string) => ipcRenderer.invoke('open-path', path),
  trash: (path: string) => ipcRenderer.invoke('trash', path),
  analyzeDuplicates: (path: string) => ipcRenderer.invoke('analyze-duplicates', path),
  cancelDuplicateAnalysis: () => ipcRenderer.invoke('cancel-duplicate-analysis'),
  trashDuplicates: (request: unknown) => ipcRenderer.invoke('trash-duplicates', request),
  onProgress: (listener: (progress: { path: string; items: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { path: string; items: number }) => listener(progress)
    ipcRenderer.on('scan-progress', handler)
    return () => ipcRenderer.removeListener('scan-progress', handler)
  },
  onDuplicateProgress: (listener: (progress: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: unknown) => listener(progress)
    ipcRenderer.on('duplicate-progress', handler)
    return () => ipcRenderer.removeListener('duplicate-progress', handler)
  },
})

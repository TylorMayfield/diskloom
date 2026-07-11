export type DiskNode = {
  name: string
  path: string
  size: number
  kind: 'folder' | 'file' | 'other'
  children?: DiskNode[]
  inaccessible?: boolean
}

export type ScanResult = {
  id?: number
  root: DiskNode
  startedAt: string
  durationMs: number
  itemCount: number
  inaccessibleCount: number
}

declare global {
  interface Window {
    diskDaddy: {
      pickFolder(): Promise<string | null>
      scan(path: string): Promise<ScanResult>
      reveal(path: string): Promise<void>
      openPath(path: string): Promise<void>
      trash(path: string): Promise<void>
      onProgress(listener: (progress: { path: string; items: number }) => void): () => void
    }
  }
}

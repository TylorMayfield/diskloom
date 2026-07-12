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

export type DuplicateFile = {
  name: string
  path: string
  parentPath: string
  size: number
  modifiedAt: string
  createdAt?: string
  fingerprint: string
}
export type DuplicateGroup = { id: string; size: number; hash: string; wastedSpace: number; files: DuplicateFile[] }
export type DuplicateAnalysisResult = { groups: DuplicateGroup[]; totalWastedSpace: number; duplicateFileCount: number; scannedFileCount: number; hashedFileCount: number }
export type DuplicateProgress = { phase: 'discovering' | 'hashing'; currentPath: string; filesProcessed: number; totalFiles?: number; bytesHashed: number; totalBytes?: number }
export type DuplicateCleanupGroup = { groupId: string; retained: DuplicateFile; selected: DuplicateFile[] }
export type DuplicateCleanupRequest = { groups: DuplicateCleanupGroup[] }
export type DuplicateCleanupOutcome = { path: string; status: 'trashed' | 'skipped' | 'failed'; reason?: string }
export type DuplicateCleanupResult = { outcomes: DuplicateCleanupOutcome[] }
export type BenchmarkProgress = { completed: number; total: number; current: string }
export type BenchmarkResult = { id: string; label: string; detail: string; read: number; write: number; readVariation: number; writeVariation: number; readIops?: number; writeIops?: number }
export type BenchmarkReport = { target: string; sizeMiB: number; runs: number; totalMemoryBytes: number; completedAt: string; results: BenchmarkResult[] }
export type BenchmarkDrive = { id: string; name: string; mountPoint: string; totalBytes: number; freeBytes: number; readOnly: boolean }
export type AppInfo = { version: string; platform: NodeJS.Platform; arch: string; electronVersion: string }

export type DiskloomApi = {
      getAppInfo(): Promise<AppInfo>
      pickFolder(): Promise<string | null>
      scan(path: string): Promise<ScanResult>
      reveal(path: string): Promise<void>
      openPath(path: string): Promise<void>
      trash(path: string): Promise<void>
      analyzeDuplicates(path: string): Promise<DuplicateAnalysisResult>
      cancelDuplicateAnalysis(): Promise<void>
      trashDuplicates(request: DuplicateCleanupRequest): Promise<DuplicateCleanupResult>
      onProgress(listener: (progress: { path: string; items: number }) => void): () => void
      onDuplicateProgress(listener: (progress: DuplicateProgress) => void): () => void
      runBenchmark(request: { target: string; sizeMiB: number; runs: number }): Promise<BenchmarkReport>
      listBenchmarkDrives(): Promise<BenchmarkDrive[]>
      getSystemMemory(): Promise<number>
      cancelBenchmark(): Promise<void>
      onBenchmarkProgress(listener: (progress: BenchmarkProgress) => void): () => void
}

declare global {
  interface Window {
    diskloom: DiskloomApi
    /** Temporary migration alias for renderer hot reloads using the pre-Diskloom bridge. */
    diskDaddy?: DiskloomApi
  }
}

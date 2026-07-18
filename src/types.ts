export type DiskNode = {
  name: string
  path: string
  size: number
  kind: 'folder' | 'file' | 'other'
  children?: DiskNode[]
  inaccessible?: boolean
  childCount?: number
}

export type ScanResult = {
  id: string
  root: DiskNode
  startedAt: string
  durationMs: number
  itemCount: number
  inaccessibleCount: number
  excludedCount: number
  unknownCount: number
  accessibleSize: number
  accounting: 'allocated'
  unaccountedSize: number | null
}

export type ChildPage = { parentPath: string; children: DiskNode[]; offset: number; total: number; hasMore: boolean }
export type ReclaimItem = { name: string; path: string; size: number; kind: 'file' | 'folder'; scannedAt: string; fingerprint: string; warning?: string }
export type ReclaimOutcome = { path: string; status: 'trashed' | 'skipped' | 'failed'; size: number; reason?: string }
export type ReclaimResult = { outcomes: ReclaimOutcome[]; reclaimedBytes: number }

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
export type ScanLocation = { id: string; name: string; path: string; kind: 'home' | 'volume'; totalBytes?: number; freeBytes?: number }
export type AppInfo = { version: string; platform: 'aix' | 'darwin' | 'freebsd' | 'linux' | 'openbsd' | 'sunos' | 'win32'; arch: string; tauriVersion: string }

export type DiskloomApi = {
      getAppInfo(): Promise<AppInfo>
      pickFolder(): Promise<string | null>
      listScanLocations(): Promise<ScanLocation[]>
      scan(path: string): Promise<ScanResult>
      cancelScan(): Promise<void>
      getChildren(scanId: string, path: string, offset?: number, limit?: number): Promise<ChildPage>
      getReclaimItem(scanId: string, path: string): Promise<ReclaimItem>
      trashReclaim(items: ReclaimItem[]): Promise<ReclaimResult>
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
  }
}

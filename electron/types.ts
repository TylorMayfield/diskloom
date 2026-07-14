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

export type DuplicateGroup = {
  id: string
  size: number
  hash: string
  wastedSpace: number
  files: DuplicateFile[]
}

export type DuplicateAnalysisResult = {
  groups: DuplicateGroup[]
  totalWastedSpace: number
  duplicateFileCount: number
  scannedFileCount: number
  hashedFileCount: number
}

export type DuplicateProgress = {
  phase: 'discovering' | 'hashing'
  currentPath: string
  filesProcessed: number
  totalFiles?: number
  bytesHashed: number
  totalBytes?: number
}

export type DuplicateCleanupGroup = {
  groupId: string
  retained: DuplicateFile
  selected: DuplicateFile[]
}

export type DuplicateCleanupRequest = { groups: DuplicateCleanupGroup[] }
export type DuplicateCleanupOutcome = {
  path: string
  status: 'trashed' | 'skipped' | 'failed'
  reason?: string
}
export type DuplicateCleanupResult = { outcomes: DuplicateCleanupOutcome[] }

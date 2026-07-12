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

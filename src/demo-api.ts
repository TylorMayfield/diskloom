import type { DiskNode, DiskloomApi, DuplicateAnalysisResult } from './types'

const now = '2026-07-17T16:30:00.000Z'
const mb = 1024 * 1024

const children: DiskNode[] = [
  { name: 'Videos', path: 'Demo Storage/Videos', size: 24 * mb, kind: 'folder', childCount: 1, children: [{ name: 'product-demo.mov', path: 'Demo Storage/Videos/product-demo.mov', size: 24 * mb, kind: 'file', childCount: 0 }] },
  { name: 'Photos', path: 'Demo Storage/Photos', size: 8 * mb, kind: 'folder', childCount: 1, children: [{ name: 'hero-image.png', path: 'Demo Storage/Photos/hero-image.png', size: 8 * mb, kind: 'file', childCount: 0 }] },
  { name: 'Projects', path: 'Demo Storage/Projects', size: 11 * mb, kind: 'folder', childCount: 2, children: [{ name: 'brand-assets.zip', path: 'Demo Storage/Projects/brand-assets.zip', size: 6 * mb, kind: 'file', childCount: 0 }, { name: 'app-source.tsx', path: 'Demo Storage/Projects/app-source.tsx', size: 5 * mb, kind: 'file', childCount: 0 }] },
  { name: 'Downloads', path: 'Demo Storage/Downloads', size: 6 * mb + 4096, kind: 'folder', childCount: 2, children: [{ name: 'brand-assets.zip', path: 'Demo Storage/Downloads/brand-assets.zip', size: 6 * mb, kind: 'file', childCount: 0 }, { name: 'project-notes.txt', path: 'Demo Storage/Downloads/project-notes.txt', size: 4096, kind: 'file', childCount: 0 }] },
  { name: 'Documents', path: 'Demo Storage/Documents', size: 3 * mb + 4096, kind: 'folder', childCount: 2, children: [{ name: 'budget.xlsx', path: 'Demo Storage/Documents/budget.xlsx', size: 3 * mb, kind: 'file', childCount: 0 }, { name: 'project-notes.txt', path: 'Demo Storage/Documents/project-notes.txt', size: 4096, kind: 'file', childCount: 0 }] },
]

const root: DiskNode = { name: 'Demo Storage', path: 'Demo Storage', size: children.reduce((sum, child) => sum + child.size, 0), kind: 'folder', children, childCount: children.length }

const find = (node: DiskNode, path: string): DiskNode | undefined => node.path === path ? node : node.children?.map((child) => find(child, path)).find(Boolean)

const duplicates: DuplicateAnalysisResult = {
  groups: [
    { id: 'brand-assets', size: 6 * mb, hash: 'demo-a', wastedSpace: 6 * mb, files: [
      { name: 'brand-assets.zip', path: 'Demo Storage/Downloads/brand-assets.zip', parentPath: 'Demo Storage/Downloads', size: 6 * mb, createdAt: now, modifiedAt: now, fingerprint: 'demo-a1' },
      { name: 'brand-assets.zip', path: 'Demo Storage/Projects/brand-assets.zip', parentPath: 'Demo Storage/Projects', size: 6 * mb, createdAt: now, modifiedAt: now, fingerprint: 'demo-a2' },
    ] },
    { id: 'project-notes', size: 4096, hash: 'demo-b', wastedSpace: 4096, files: [
      { name: 'project-notes.txt', path: 'Demo Storage/Documents/project-notes.txt', parentPath: 'Demo Storage/Documents', size: 4096, createdAt: now, modifiedAt: now, fingerprint: 'demo-b1' },
      { name: 'project-notes.txt', path: 'Demo Storage/Downloads/project-notes.txt', parentPath: 'Demo Storage/Downloads', size: 4096, createdAt: now, modifiedAt: now, fingerprint: 'demo-b2' },
    ] },
  ],
  totalWastedSpace: 6 * mb + 4096,
  duplicateFileCount: 2,
  scannedFileCount: 8,
  hashedFileCount: 4,
}

const noopSubscription = () => () => undefined

export const demoApi: DiskloomApi = {
  getAppInfo: async () => ({ version: '2.0.9', platform: 'linux', arch: 'x64', tauriVersion: '2' }),
  pickFolder: async () => root.path,
  listScanLocations: async () => [
    { id: 'home', name: 'Home folder', path: 'Home', kind: 'home' },
    { id: 'storage', name: 'Demo Storage', path: root.path, kind: 'volume', totalBytes: 512 * 1024 ** 3, freeBytes: 328 * 1024 ** 3 },
  ],
  scan: async () => ({ id: 'demo-scan', root, startedAt: now, durationMs: 184, itemCount: 13, inaccessibleCount: 0, excludedCount: 0, unknownCount: 0, accessibleSize: root.size, accounting: 'allocated', unaccountedSize: null }),
  getChildren: async (_scanId, path, offset = 0, limit = 60) => {
    const items = find(root, path)?.children ?? []
    return { parentPath: path, children: items.slice(offset, offset + limit), offset, total: items.length, hasMore: offset + limit < items.length }
  },
  getReclaimItem: async () => { throw new Error('Not available in demo mode.') },
  trashReclaim: async () => ({ outcomes: [], reclaimedBytes: 0 }),
  reveal: async () => undefined,
  openPath: async () => undefined,
  trash: async () => undefined,
  analyzeDuplicates: async () => duplicates,
  cancelDuplicateAnalysis: async () => undefined,
  trashDuplicates: async () => ({ outcomes: [] }),
  onProgress: noopSubscription,
  onDuplicateProgress: noopSubscription,
  runBenchmark: async (request) => ({ target: request.target, sizeMiB: request.sizeMiB, runs: request.runs, totalMemoryBytes: 16 * 1024 ** 3, completedAt: now, results: [] }),
  listBenchmarkDrives: async () => [{ id: 'demo', name: 'Demo Storage', mountPoint: root.path, totalBytes: 512 * 1024 ** 3, freeBytes: 328 * 1024 ** 3, readOnly: false }],
  getSystemMemory: async () => 16 * 1024 ** 3,
  cancelBenchmark: async () => undefined,
  onBenchmarkProgress: noopSubscription,
}

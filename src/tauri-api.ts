import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { BenchmarkProgress, ChildPage, DiskloomApi, DuplicateAnalysisResult, DuplicateCleanupRequest, DuplicateCleanupResult, DuplicateProgress, ReclaimItem, ReclaimResult, ScanResult } from './types'

const command = async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
  try { return await invoke<T>(name, args) }
  catch (cause) { throw cause instanceof Error ? cause : new Error(typeof cause === 'string' ? cause : 'The desktop command failed.') }
}

const subscribe = <T>(event: string, listener: (payload: T) => void) => {
  let disposed = false
  let unlisten: UnlistenFn | undefined
  void listen<T>(event, ({ payload }) => listener(payload)).then((fn) => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => { disposed = true; unlisten?.() }
}

const api: DiskloomApi = {
  getAppInfo: () => command('get_app_info'),
  pickFolder: () => command('pick_folder'),
  listScanLocations: () => command('list_scan_locations'),
  scan: (path) => command<ScanResult>('scan', { path }),
  cancelScan: () => command('cancel_scan'),
  getChildren: (scanId, path, offset, limit) => command<ChildPage>('get_children', { scanId, path, offset, limit }),
  getReclaimItem: (scanId, path) => command('get_reclaim_item', { scanId, path }),
  trashReclaim: (items) => command<ReclaimResult>('trash_reclaim', { items }),
  reveal: (path) => command('reveal', { path }),
  openPath: (path) => command('open_path', { path }),
  trash: (path) => command('trash', { path }),
  analyzeDuplicates: (path) => command<DuplicateAnalysisResult>('analyze_duplicates', { path }),
  cancelDuplicateAnalysis: () => command('cancel_duplicate_analysis'),
  trashDuplicates: (request: DuplicateCleanupRequest) => command<DuplicateCleanupResult>('trash_duplicates', { request }),
  runBenchmark: (request) => command('run_benchmark', { request }),
  listBenchmarkDrives: () => command('list_benchmark_drives'),
  getSystemMemory: () => command('get_system_memory'),
  cancelBenchmark: () => command('cancel_benchmark'),
  onProgress: (listener) => subscribe('scan-progress', listener),
  onDuplicateProgress: (listener: (progress: DuplicateProgress) => void) => subscribe('duplicate-progress', listener),
  onBenchmarkProgress: (listener: (progress: BenchmarkProgress) => void) => subscribe('benchmark-progress', listener),
}

let demoMode = false

export async function configureDiskloomApi() {
  demoMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has('demo')
  window.diskloom = demoMode ? (await import('./demo-api')).demoApi : api
}

document.addEventListener('click', (event) => {
  const anchor = (event.target as Element | null)?.closest('a[target="_blank"]')
  if (!(anchor instanceof HTMLAnchorElement) || !/^https?:$/.test(new URL(anchor.href).protocol)) return
  event.preventDefault()
  if (!demoMode) void invoke('open_external', { url: anchor.href })
})

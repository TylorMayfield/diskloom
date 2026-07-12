import { constants } from 'node:fs'
import { access, open, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type BenchmarkRequest = { target: string; sizeMiB: number; runs: number }
export type BenchmarkResult = { id: string; label: string; detail: string; read: number; write: number; readVariation: number; writeVariation: number; readIops?: number; writeIops?: number }
export type BenchmarkProgress = { completed: number; total: number; current: string }
export type BenchmarkDrive = { id: string; name: string; mountPoint: string; totalBytes: number; freeBytes: number; readOnly: boolean }

const throwIfAborted = (signal: AbortSignal) => { if (signal.aborted) throw new Error('Benchmark cancelled.') }

export async function listBenchmarkDrives(): Promise<BenchmarkDrive[]> {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_LogicalDisk | Where-Object {$_.DriveType -in 2,3} | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress'
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 1024 * 1024 })
    const parsed = JSON.parse(stdout.trim() || '[]') as Record<string, string | number | null> | Record<string, string | number | null>[]
    return (Array.isArray(parsed) ? parsed : [parsed]).map((drive) => {
      const mountPoint = `${drive.DeviceID}\\`
      return { id: mountPoint.toLowerCase(), name: String(drive.VolumeName || drive.DeviceID), mountPoint, totalBytes: Number(drive.Size || 0), freeBytes: Number(drive.FreeSpace || 0), readOnly: false }
    })
  }

  const { stdout } = await execFileAsync('df', ['-kP'], { maxBuffer: 4 * 1024 * 1024 })
  const drives: BenchmarkDrive[] = []
  for (const line of stdout.split('\n').slice(1)) {
    const match = line.match(/^(\S+)\s+(\d+)\s+\d+\s+(\d+)\s+\d+%\s+(.+)$/)
    if (!match) continue
    const [, device, totalKiB, freeKiB, mountPoint] = match
    const physical = process.platform === 'darwin'
      ? device.startsWith('/dev/') && (mountPoint === '/' || mountPoint.startsWith('/Volumes/'))
      : (device.startsWith('/dev/') || device === 'overlay') && (mountPoint === '/' || /^\/(media|mnt|run\/media)(\/|$)/.test(mountPoint))
    if (!physical || drives.some((drive) => drive.mountPoint === mountPoint)) continue
    let readOnly = false
    try { await access(mountPoint, constants.W_OK) } catch { readOnly = process.platform !== 'darwin' || mountPoint !== '/' }
    const baseName = path.basename(device).replace(/^disk\d+s?\d*$/, '')
    const name = mountPoint === '/' ? 'System drive' : path.basename(mountPoint) || baseName || device
    drives.push({ id: `${device}:${mountPoint}`, name, mountPoint, totalBytes: Number(totalKiB) * 1024, freeBytes: Number(freeKiB) * 1024, readOnly })
  }
  return drives.sort((a, b) => (a.mountPoint === '/' ? -1 : b.mountPoint === '/' ? 1 : a.name.localeCompare(b.name)))
}

async function resolveTestDirectory(target: string) {
  try { await access(target, constants.W_OK); return target }
  catch {
    // Modern macOS exposes / as a sealed, read-only system volume. Its temporary
    // directory lives on the writable data volume backed by the same disk.
    if (process.platform === 'darwin' && path.resolve(target) === '/') {
      const temporaryDirectory = os.tmpdir()
      try { await access(temporaryDirectory, constants.W_OK); return temporaryDirectory }
      catch { /* handled by the actionable error below */ }
    }
    throw new Error(`This drive is read-only, so its write performance cannot be benchmarked.`)
  }
}

export async function runBenchmark(request: BenchmarkRequest, signal: AbortSignal, progress: (value: BenchmarkProgress) => void) {
  const size = Math.max(32, Math.min(64 * 1024, request.sizeMiB)) * 1024 * 1024
  const runs = Math.max(1, Math.min(5, request.runs))
  const testDirectory = await resolveTestDirectory(request.target)
  const tests = [
    { id: 'seq1m-q8', label: 'SEQ1M', detail: 'Q8T1', block: 1024 * 1024, random: false, queue: 8 },
    { id: 'seq1m-q1', label: 'SEQ1M', detail: 'Q1T1', block: 1024 * 1024, random: false, queue: 1 },
    { id: 'rnd4k-q32', label: 'RND4K', detail: 'Q32T1', block: 4 * 1024, random: true, queue: 32 },
    { id: 'rnd4k-q1', label: 'RND4K', detail: 'Q1T1', block: 4 * 1024, random: true, queue: 1 },
  ]
  const shuffledTests = [...tests]
  for (let index = shuffledTests.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1)); [shuffledTests[index], shuffledTests[swap]] = [shuffledTests[swap], shuffledTests[index]]
  }
  const total = tests.length * (runs + 1) * 2
  let completed = 0
  const results: BenchmarkResult[] = []
  const testPaths: string[] = []
  let activeHandle: Awaited<ReturnType<typeof open>> | undefined
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }
  const variation = (values: number[]) => {
    if (values.length < 2) return 0
    const center = median(values)
    const deviations = values.map((value) => Math.abs(value - center))
    return center ? median(deviations) / center * 100 : 0
  }
  const random = (seed: number) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296 }
  try {
    const seed = Buffer.alloc(Math.min(size, 1024 * 1024))
    for (let i = 0; i < seed.length; i += 4096) seed.writeUInt32LE(Math.floor(Math.random() * 0xffffffff), i)

    for (const test of shuffledTests) {
      const testPath = path.join(testDirectory, `.diskloom-benchmark-${process.pid}-${Date.now()}-${test.id}.tmp`)
      testPaths.push(testPath)
      const bytesPerPass = test.random ? Math.min(size, 32 * 1024 * 1024) : size
      const operations = Math.max(1, Math.floor(bytesPerPass / test.block))
      const blocksInFile = Math.max(1, Math.floor(size / test.block))
      const buffer = test.block === seed.length ? seed : Buffer.alloc(test.block, 0x5a)
      const writes: number[] = []; const reads: number[] = []
      const positions = (pass: number) => {
        if (!test.random) return Array.from({ length: operations }, (_, index) => index * test.block)
        const next = random((pass + 2) * 0x9e3779b1 + test.queue)
        return Array.from({ length: operations }, (_, index) => {
          const bucketStart = index / operations * blocksInFile
          const bucketEnd = (index + 1) / operations * blocksInFile
          return Math.min(blocksInFile - 1, Math.floor(bucketStart + next() * Math.max(1, bucketEnd - bucketStart))) * test.block
        }).sort(() => next() - .5)
      }

      let handle = await open(testPath, constants.O_CREAT | constants.O_TRUNC | constants.O_RDWR, 0o600)
      activeHandle = handle
      await handle.truncate(size)
      for (let pass = -1; pass < runs; pass++) {
        throwIfAborted(signal); progress({ completed, total, current: `${pass < 0 ? 'Warming up' : 'Writing'} ${test.label} ${test.detail}` })
        let started = performance.now()
        const passPositions = positions(pass)
        for (let op = 0; op < operations; op += test.queue) {
          throwIfAborted(signal)
          const batch = Array.from({ length: Math.min(test.queue, operations - op) }, (_, offset) => {
            return handle.write(buffer, 0, test.block, passPositions[op + offset])
          })
          await Promise.all(batch)
        }
        await handle.sync()
        const throughput = bytesPerPass / 1024 / 1024 / ((performance.now() - started) / 1000)
        if (pass >= 0) writes.push(throughput)
        completed++; progress({ completed, total, current: `${test.label} write ${pass < 0 ? 'warm-up' : `${pass + 1}/${runs}`} complete` })
      }
      await handle.close()
      activeHandle = undefined

      handle = await open(testPath, constants.O_RDONLY)
      activeHandle = handle
      const readBuffers = Array.from({ length: test.queue }, () => Buffer.alloc(test.block))
      for (let pass = -1; pass < runs; pass++) {
        throwIfAborted(signal); progress({ completed, total, current: `${pass < 0 ? 'Warming up' : 'Reading'} ${test.label} ${test.detail}` })
        const started = performance.now()
        const passPositions = positions(pass)
        for (let op = 0; op < operations; op += test.queue) {
          throwIfAborted(signal)
          const batch = Array.from({ length: Math.min(test.queue, operations - op) }, (_, offset) => {
            return handle.read(readBuffers[offset], 0, test.block, passPositions[op + offset])
          })
          await Promise.all(batch)
        }
        const throughput = bytesPerPass / 1024 / 1024 / ((performance.now() - started) / 1000)
        if (pass >= 0) reads.push(throughput)
        completed++; progress({ completed, total, current: `${test.label} read ${pass < 0 ? 'warm-up' : `${pass + 1}/${runs}`} complete` })
      }
      await handle.close()
      activeHandle = undefined
      await rm(testPath, { force: true })
      const read = median(reads); const write = median(writes)
      results.push({ id: test.id, label: test.label, detail: test.detail, read, write, readVariation: variation(reads), writeVariation: variation(writes), ...(test.random ? { readIops: read * 256, writeIops: write * 256 } : {}) })
    }
    results.sort((a, b) => tests.findIndex((test) => test.id === a.id) - tests.findIndex((test) => test.id === b.id))
    return { target: request.target, sizeMiB: size / 1024 / 1024, runs, totalMemoryBytes: os.totalmem(), completedAt: new Date().toISOString(), results }
  } finally {
    await activeHandle?.close().catch(() => undefined)
    await Promise.all(testPaths.map((testPath) => rm(testPath, { force: true }).catch(() => undefined)))
  }
}

import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { DuplicateAnalysisResult, DuplicateFile, DuplicateGroup, DuplicateProgress } from './types.js'

const HASH_CONCURRENCY = 3

const fingerprint = (size: number, mtimeMs: number) => `${size}:${Math.trunc(mtimeMs)}`

async function hashFile(file: DuplicateFile, signal: AbortSignal, onBytes: (bytes: number) => void) {
  const hash = createHash('sha256')
  const stream = createReadStream(file.path, { highWaterMark: 1024 * 1024 })
  const abort = () => stream.destroy(new Error('Duplicate analysis cancelled'))
  signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new Error('Duplicate analysis cancelled')
      hash.update(chunk as Buffer)
      onBytes((chunk as Buffer).length)
    }
    return hash.digest('hex')
  } finally { signal.removeEventListener('abort', abort) }
}

export async function analyzeDuplicates(rootPath: string, signal: AbortSignal, progress: (value: DuplicateProgress) => void): Promise<DuplicateAnalysisResult> {
  const files: DuplicateFile[] = []
  const physicalFiles = new Set<string>()
  const pending = [path.resolve(rootPath)]
  let discovered = 0
  while (pending.length) {
    if (signal.aborted) throw new Error('Duplicate analysis cancelled')
    const target = pending.pop()!
    let stat
    try { stat = await fs.lstat(target) } catch { continue }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      let entries: string[]
      try { entries = await fs.readdir(target) } catch { continue }
      for (const entry of entries) pending.push(path.join(target, entry))
      continue
    }
    if (!stat.isFile()) continue
    discovered++
    if (stat.size > 0) {
      const physicalId = `${stat.dev}:${stat.ino}`
      if (!physicalFiles.has(physicalId)) {
        physicalFiles.add(physicalId)
        files.push({
          name: path.basename(target), path: target, parentPath: path.dirname(target), size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          createdAt: stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : undefined,
          fingerprint: fingerprint(stat.size, stat.mtimeMs),
        })
      }
    }
    if (discovered % 100 === 0) progress({ phase: 'discovering', currentPath: target, filesProcessed: discovered, bytesHashed: 0 })
  }

  const bySize = new Map<number, DuplicateFile[]>()
  progress({ phase: 'discovering', currentPath: rootPath, filesProcessed: discovered, bytesHashed: 0 })
  for (const file of files) bySize.set(file.size, [...(bySize.get(file.size) ?? []), file])
  const candidates = [...bySize.values()].filter((group) => group.length > 1).flat()
  const totalBytes = candidates.reduce((sum, file) => sum + file.size, 0)
  let next = 0, hashed = 0, bytesHashed = 0
  const matches = new Map<string, { hash: string; files: DuplicateFile[] }>()
  const worker = async () => {
    while (next < candidates.length) {
      const file = candidates[next++]
      let digest: string
      try { digest = await hashFile(file, signal, (bytes) => { bytesHashed += bytes }) } catch (error) {
        if (signal.aborted) throw error
        continue
      }
      hashed++
      const key = `${file.size}:${digest}`
      const match = matches.get(key) ?? { hash: digest, files: [] }
      match.files.push(file); matches.set(key, match)
      progress({ phase: 'hashing', currentPath: file.path, filesProcessed: hashed, totalFiles: candidates.length, bytesHashed, totalBytes })
    }
  }
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, candidates.length) }, worker))
  const groups: DuplicateGroup[] = [...matches.values()].filter((match) => match.files.length > 1).map((match) => ({
    id: `${match.files[0].size}:${match.hash}`,
    size: match.files[0].size,
    hash: match.hash,
    wastedSpace: match.files[0].size * (match.files.length - 1),
    files: match.files.sort((a, b) => a.path.localeCompare(b.path)),
  })).sort((a, b) => b.wastedSpace - a.wastedSpace)
  return {
    groups,
    totalWastedSpace: groups.reduce((sum, group) => sum + group.wastedSpace, 0),
    duplicateFileCount: groups.reduce((sum, group) => sum + group.files.length - 1, 0),
    scannedFileCount: discovered,
    hashedFileCount: hashed,
  }
}

export async function fileMatches(file: DuplicateFile) {
  try {
    const stat = await fs.lstat(file.path)
    return stat.isFile() && !stat.isSymbolicLink() && fingerprint(stat.size, stat.mtimeMs) === file.fingerprint
  } catch { return false }
}

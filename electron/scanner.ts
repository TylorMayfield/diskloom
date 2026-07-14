import { promises as fs } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { ChildPage, DiskNode, ReclaimItem, ScanResult } from './types.js'

const MAX_IO = 48
const INITIAL_CHILDREN = 40
const INITIAL_DEPTH = 3
const MAX_SESSIONS = 2

type IndexedNode = Omit<DiskNode, 'children'> & {
  children: string[]
  mtimeMs: number
  device: number
  inode: number
  revision: string
}

type ScanSession = { id: string; rootPath: string; nodes: Map<string, IndexedNode>; createdAt: number }
const sessions = new Map<string, ScanSession>()

class Semaphore {
  private active = 0
  private waiting: Array<() => void> = []

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_IO) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    try { return await operation() }
    finally { this.active--; this.waiting.shift()?.() }
  }
}

const allocatedSize = (stat: Stats) => process.platform === 'win32' ? stat.size : stat.blocks * 512

const statRevision = (stat: Stats, kind: DiskNode['kind']) => `${kind}:${stat.dev}:${stat.ino}:${stat.size}:${Math.trunc(stat.mtimeMs)}`
const folderRevision = (stat: Stats, children: IndexedNode[]) => {
  const hash = createHash('sha256').update(statRevision(stat, 'folder'))
  for (const child of children.slice().sort((a, b) => a.name.localeCompare(b.name))) hash.update('\0').update(child.name).update('\0').update(child.revision)
  return hash.digest('hex')
}

function publicNode(session: ScanSession, node: IndexedNode, depth = 0): DiskNode {
  const children = depth < INITIAL_DEPTH
    ? node.children.slice(0, INITIAL_CHILDREN).map((childPath) => publicNode(session, session.nodes.get(childPath)!, depth + 1))
    : undefined
  return {
    name: node.name, path: node.path, size: node.size, kind: node.kind,
    inaccessible: node.inaccessible, childCount: node.children.length,
    ...(children?.length ? { children } : {}),
  }
}

function getSession(scanId: string) {
  const session = sessions.get(scanId)
  if (!session) throw new Error('This scan is no longer available. Please scan again.')
  return session
}

export function getChildren(scanId: string, parentPath: string, offset = 0, limit = 60): ChildPage {
  const session = getSession(scanId)
  const parent = session.nodes.get(path.resolve(parentPath))
  if (!parent) throw new Error('The requested folder is not part of this scan.')
  const safeOffset = Math.max(0, Math.trunc(offset))
  const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)))
  const paths = parent.children.slice(safeOffset, safeOffset + safeLimit)
  return {
    parentPath: parent.path,
    children: paths.map((childPath) => publicNode(session, session.nodes.get(childPath)!)),
    offset: safeOffset,
    total: parent.children.length,
    hasMore: safeOffset + paths.length < parent.children.length,
  }
}

export function getReclaimItem(scanId: string, target: string): ReclaimItem {
  const session = getSession(scanId)
  const node = session.nodes.get(path.resolve(target))
  if (!node || node.inaccessible || (node.kind !== 'file' && node.kind !== 'folder')) throw new Error('This item is not reclaimable.')
  const relative = path.relative(session.rootPath, node.path)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The scan root cannot be added to Reclaim.')
  const sensitiveRoots = process.platform === 'win32'
    ? ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData']
    : ['System', 'Library', 'Applications', 'bin', 'etc', 'sbin', 'usr', 'var']
  const segments = node.path.split(path.sep).filter(Boolean)
  const sensitive = sensitiveRoots.some((part) => segments.includes(part))
  return {
    name: node.name, path: node.path, size: node.size, kind: node.kind as 'file' | 'folder',
    scannedAt: new Date(session.createdAt).toISOString(), fingerprint: node.revision,
    warning: sensitive ? 'This item is in a sensitive or system-managed location.' : undefined,
  }
}

export function pathsOverlap(first: string, second: string) {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(path.resolve(parent), path.resolve(child))
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }
  return contains(first, second) || contains(second, first)
}

export async function reclaimItemMatches(item: ReclaimItem) {
  try {
    async function revision(target: string): Promise<{ kind: DiskNode['kind']; revision: string }> {
      const stat = await fs.lstat(target)
      const kind: DiskNode['kind'] = stat.isSymbolicLink() ? 'other' : stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : 'other'
      if (kind !== 'folder') return { kind, revision: statRevision(stat, kind) }
      const names = await fs.readdir(target)
      const children: Array<{ name: string; revision: string }> = []
      for (let index = 0; index < names.length; index += 24) children.push(...await Promise.all(names.slice(index, index + 24).map(async (name) => {
        const child = await revision(path.join(target, name)); return { name, revision: child.revision }
      })))
      const hash = createHash('sha256').update(statRevision(stat, 'folder'))
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) hash.update('\0').update(child.name).update('\0').update(child.revision)
      return { kind, revision: hash.digest('hex') }
    }
    const current = await revision(item.path)
    return current.kind === item.kind && current.revision === item.fingerprint
  } catch { return false }
}

export async function scanPath(rootPath: string, progress: (payload: { path: string; items: number }) => void): Promise<ScanResult> {
  const started = Date.now()
  let itemCount = 0, inaccessibleCount = 0, excludedCount = 0
  const io = new Semaphore()
  const nodes = new Map<string, IndexedNode>()
  const physicalFiles = new Set<string>()

  async function walk(target: string): Promise<IndexedNode> {
    itemCount++
    if (itemCount % 200 === 0) progress({ path: target, items: itemCount })
    let stat: Stats
    try { stat = await io.run(() => fs.lstat(target)) }
    catch {
      inaccessibleCount++
      const node: IndexedNode = { name: path.basename(target) || target, path: target, size: 0, kind: 'other', inaccessible: true, children: [], mtimeMs: 0, device: 0, inode: 0, revision: 'inaccessible' }
      nodes.set(target, node); return node
    }
    if (stat.isSymbolicLink()) {
      excludedCount++
      const node: IndexedNode = { name: path.basename(target), path: target, size: allocatedSize(stat), kind: 'other', children: [], mtimeMs: stat.mtimeMs, device: stat.dev, inode: stat.ino, revision: statRevision(stat, 'other') }
      nodes.set(target, node); return node
    }
    if (!stat.isDirectory()) {
      const physicalId = `${stat.dev}:${stat.ino}`
      const size = physicalFiles.has(physicalId) ? 0 : allocatedSize(stat)
      physicalFiles.add(physicalId)
      const kind = stat.isFile() ? 'file' : 'other'
      const node: IndexedNode = { name: path.basename(target), path: target, size, kind, children: [], mtimeMs: stat.mtimeMs, device: stat.dev, inode: stat.ino, revision: statRevision(stat, kind) }
      nodes.set(target, node); return node
    }
    let entries: Dirent[]
    try { entries = await io.run(() => fs.readdir(target, { withFileTypes: true })) }
    catch {
      inaccessibleCount++
      const node: IndexedNode = { name: path.basename(target) || target, path: target, size: allocatedSize(stat), kind: 'folder', inaccessible: true, children: [], mtimeMs: stat.mtimeMs, device: stat.dev, inode: stat.ino, revision: statRevision(stat, 'folder') }
      nodes.set(target, node); return node
    }
    const children: IndexedNode[] = []
    for (let i = 0; i < entries.length; i += 24) {
      children.push(...await Promise.all(entries.slice(i, i + 24).map((entry) => walk(path.join(target, entry.name)))))
    }
    children.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
    const node: IndexedNode = {
      name: path.basename(target) || target, path: target,
      size: allocatedSize(stat) + children.reduce((sum, child) => sum + child.size, 0),
      kind: 'folder', children: children.map((child) => child.path),
      mtimeMs: stat.mtimeMs, device: stat.dev, inode: stat.ino, revision: folderRevision(stat, children),
    }
    nodes.set(target, node); return node
  }

  const resolvedRoot = path.resolve(rootPath)
  const root = await walk(resolvedRoot)
  let unaccountedSize: number | null = null
  try {
    const parentStat = await fs.stat(path.dirname(resolvedRoot))
    const rootStat = await fs.stat(resolvedRoot)
    const isVolumeRoot = resolvedRoot === path.parse(resolvedRoot).root || parentStat.dev !== rootStat.dev
    if (isVolumeRoot) {
      const volume = await fs.statfs(resolvedRoot)
      const used = Number(volume.blocks - volume.bfree) * Number(volume.bsize)
      unaccountedSize = Math.max(0, used - root.size)
    }
  } catch { /* Volume accounting is supplemental; the indexed total remains valid. */ }
  const id = randomUUID()
  const session: ScanSession = { id, rootPath: resolvedRoot, nodes, createdAt: started }
  sessions.set(id, session)
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
  progress({ path: resolvedRoot, items: itemCount })
  return {
    id, root: publicNode(session, root), startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    itemCount, inaccessibleCount, excludedCount, unknownCount: inaccessibleCount,
    accessibleSize: root.size, accounting: 'allocated', unaccountedSize,
  }
}

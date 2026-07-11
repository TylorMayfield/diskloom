import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DiskNode, ScanResult } from './types.js'

const MAX_DEPTH = 7
const MAX_CHILDREN = 120
const MAX_IO = 48

class Semaphore {
  private active = 0
  private waiting: Array<() => void> = []

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_IO) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    try { return await operation() }
    finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

export async function scanPath(rootPath: string, progress: (payload: { path: string; items: number }) => void): Promise<ScanResult> {
  const started = Date.now()
  let itemCount = 0
  let inaccessibleCount = 0
  const io = new Semaphore()

  async function walk(target: string, depth: number): Promise<DiskNode> {
    itemCount++
    if (itemCount % 200 === 0) progress({ path: target, items: itemCount })
    let stat
    try {
      stat = await io.run(() => fs.lstat(target))
    } catch {
      inaccessibleCount++
      return { name: path.basename(target) || target, path: target, size: 0, kind: 'other', inaccessible: true }
    }

    if (stat.isSymbolicLink()) return { name: path.basename(target), path: target, size: 0, kind: 'other' }
    if (!stat.isDirectory()) return { name: path.basename(target), path: target, size: stat.size, kind: 'file' }

    let entries
    try {
      entries = await io.run(() => fs.readdir(target, { withFileTypes: true }))
    } catch {
      inaccessibleCount++
      return { name: path.basename(target) || target, path: target, size: stat.size, kind: 'folder', inaccessible: true }
    }

    if (depth >= MAX_DEPTH) {
      return { name: path.basename(target) || target, path: target, size: stat.size, kind: 'folder' }
    }

    const children: DiskNode[] = []
    const batchSize = 24
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize)
      children.push(...await Promise.all(batch.map((entry) => walk(path.join(target, entry.name), depth + 1))))
    }
    children.sort((a, b) => b.size - a.size)
    const visible = children.slice(0, MAX_CHILDREN)
    const hiddenSize = children.slice(MAX_CHILDREN).reduce((sum, child) => sum + child.size, 0)
    if (hiddenSize) visible.push({ name: `${children.length - MAX_CHILDREN} more items`, path: target, size: hiddenSize, kind: 'other' })
    return {
      name: path.basename(target) || target,
      path: target,
      size: children.reduce((sum, child) => sum + child.size, 0) + stat.size,
      kind: 'folder',
      children: visible,
    }
  }

  const root = await walk(path.resolve(rootPath), 0)
  progress({ path: rootPath, items: itemCount })
  return {
    root,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    itemCount,
    inaccessibleCount,
  }
}

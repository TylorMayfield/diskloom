import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, mkdir, rm, stat, symlink, writeFile, link, readdir, lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getChildren, getReclaimItem, pathsOverlap, reclaimItemMatches, scanPath } from '../dist-electron/scanner.js'

const fixtures = []
const exec = promisify(execFile)
afterEach(async () => { await Promise.all(fixtures.splice(0).map((target) => rm(target, { recursive: true, force: true }))) })

const diskSize = (value) => process.platform === 'win32' ? value.size : value.blocks * 512
async function expectedAllocated(root) {
  const physical = new Set()
  async function walk(target) {
    const value = await lstat(target)
    if (value.isSymbolicLink()) return diskSize(value)
    if (!value.isDirectory()) {
      const id = `${value.dev}:${value.ino}`
      if (physical.has(id)) return 0
      physical.add(id); return diskSize(value)
    }
    const names = await readdir(target)
    return diskSize(value) + (await Promise.all(names.map((name) => walk(path.join(target, name))))).reduce((sum, size) => sum + size, 0)
  }
  return walk(root)
}

test('scans every descendant and pages every child without truncating totals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diskloom-scan-')); fixtures.push(root)
  let deep = root
  for (let depth = 0; depth < 12; depth++) { deep = path.join(deep, `depth-${depth}`); await mkdir(deep) }
  await writeFile(path.join(deep, 'deep.bin'), Buffer.alloc(17_000, 7))
  const wide = path.join(root, 'wide'); await mkdir(wide)
  await Promise.all(Array.from({ length: 151 }, (_, index) => writeFile(path.join(wide, `file-${String(index).padStart(3, '0')}`), Buffer.alloc(index + 1))))
  const original = path.join(root, 'original.bin'); await writeFile(original, Buffer.alloc(9_000))
  await link(original, path.join(root, 'hard-link.bin'))
  await symlink(deep, path.join(root, 'not-followed'))

  const result = await scanPath(root, () => undefined)
  assert.equal(result.root.size, await expectedAllocated(root))
  if (process.platform !== 'win32') {
    const { stdout } = await exec('du', ['-sk', root])
    assert.equal(result.root.size, Number(stdout.trim().split(/\s+/)[0]) * 1024)
  }
  assert.equal(result.accessibleSize, result.root.size)
  assert.equal(result.excludedCount, 1)
  assert.equal(result.unknownCount, 0)
  assert.ok(result.itemCount > 165)

  const widePage1 = getChildren(result.id, wide, 0, 60)
  const widePage2 = getChildren(result.id, wide, 60, 60)
  const widePage3 = getChildren(result.id, wide, 120, 60)
  assert.equal(widePage1.total, 151)
  assert.deepEqual([widePage1.children.length, widePage2.children.length, widePage3.children.length], [60, 60, 31])
  assert.equal(new Set([...widePage1.children, ...widePage2.children, ...widePage3.children].map((node) => node.path)).size, 151)

  let cursor = root
  for (let depth = 0; depth < 12; depth++) {
    const page = getChildren(result.id, cursor, 0, 200)
    const next = page.children.find((node) => node.name === `depth-${depth}`)
    assert.ok(next, `depth ${depth} remains explorable`)
    cursor = next.path
  }
  assert.equal(getChildren(result.id, cursor).children[0].name, 'deep.bin')
})

test('reclaim fingerprints detect files changed since the scan', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diskloom-reclaim-')); fixtures.push(root)
  const target = path.join(root, 'candidate.bin'); await writeFile(target, Buffer.alloc(8_192))
  const result = await scanPath(root, () => undefined)
  const item = getReclaimItem(result.id, target)
  assert.equal(await reclaimItemMatches(item), true)
  await writeFile(target, Buffer.alloc(16_384))
  const value = await stat(target); assert.ok(value.size > 8_192)
  assert.equal(await reclaimItemMatches(item), false)
})

test('reclaim fingerprints detect changes anywhere beneath a selected folder', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diskloom-reclaim-folder-')); fixtures.push(root)
  const folder = path.join(root, 'candidate'); const nested = path.join(folder, 'a', 'b')
  await mkdir(nested, { recursive: true }); const file = path.join(nested, 'data.bin'); await writeFile(file, Buffer.alloc(4_096))
  const result = await scanPath(root, () => undefined)
  const item = getReclaimItem(result.id, folder)
  assert.equal(await reclaimItemMatches(item), true)
  await writeFile(file, Buffer.alloc(12_288))
  assert.equal(await reclaimItemMatches(item), false)
})

test('reclaim overlap checks reject parents and descendants in either order', () => {
  const parent = path.join(path.sep, 'data', 'photos')
  const child = path.join(parent, 'trip', 'image.jpg')
  assert.equal(pathsOverlap(parent, child), true)
  assert.equal(pathsOverlap(child, parent), true)
  assert.equal(pathsOverlap(parent, path.join(path.sep, 'data', 'photos-old')), false)
  assert.equal(pathsOverlap(parent, path.join(parent, '..hidden')), true)
})

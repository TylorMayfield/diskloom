import { AlertTriangle, ExternalLink, FolderOpen, Trash2, X } from 'lucide-react'
import type { ReclaimItem, ReclaimResult } from './types'

const parentOf = (parent: string, child: string) => {
  const normalizedParent = parent.replace(/\\/g, '/').replace(/\/$/, '')
  const normalizedChild = child.replace(/\\/g, '/')
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
}

export const overlapsReclaim = (items: ReclaimItem[], candidate: ReclaimItem) =>
  items.some((item) => parentOf(item.path, candidate.path) || parentOf(candidate.path, item.path))

export function Reclaim({ items, busy, onRemove, onClear, onTrash, formatSize }: {
  items: ReclaimItem[]
  busy: boolean
  onRemove(path: string): void
  onClear(): void
  onTrash(): Promise<ReclaimResult>
  formatSize(bytes: number): string
}) {
  const total = items.reduce((sum, item) => sum + item.size, 0)
  const groups = items.reduce((result, item) => {
    const location = item.path.replace(/\\/g, '/').split('/').filter(Boolean).slice(0, 2).join('/') || 'Root'
    const key = `${item.kind === 'folder' ? 'Folders' : 'Files'} · ${location}`
    result.set(key, [...(result.get(key) ?? []), item]); return result
  }, new Map<string, ReclaimItem[]>())

  const review = async () => {
    const warnings = items.filter((item) => item.warning).length
    const warningText = warnings ? `\n\n${warnings} item${warnings === 1 ? '' : 's'} are in sensitive or system-managed locations.` : ''
    if (!window.confirm(`Final review: move ${items.length.toLocaleString()} item${items.length === 1 ? '' : 's'} to the Trash?\n\nPotential recovery: ${formatSize(total)}${warningText}\n\nItems changed since scanning will be skipped.`)) return
    await onTrash()
  }

  if (!items.length) return <main className="reclaim-empty"><div className="reclaim-hero"><Trash2 size={45}/></div><h2>Build a Reclaim List</h2><p>Add files and folders from the Disk Map. Diskloom will review them together, prevent overlapping selections, check for changes, and move only approved items to the Trash.</p></main>
  return <main className="reclaim-view">
    <section className="reclaim-summary"><div><p className="eyebrow">POTENTIAL SPACE RECOVERED</p><strong>{formatSize(total)}</strong></div><div><b>{items.length.toLocaleString()}</b><span>items ready for review</span></div><button className="secondary-btn" disabled={busy} onClick={onClear}>Clear list</button><button className="danger-btn" disabled={busy} onClick={() => void review()}><Trash2 size={16}/>{busy ? 'Checking items…' : 'Review & move to Trash'}</button></section>
    <section className="reclaim-groups">{[...groups].map(([label, group]) => <div className="reclaim-group" key={label}><h3>{label}<span>{formatSize(group.reduce((sum, item) => sum + item.size, 0))}</span></h3>{group.map((item) => <article key={item.path}>
      <span className={`file-icon ${item.kind}`}>{item.kind === 'folder' ? '◼' : '●'}</span><div><b>{item.name}</b><small title={item.path}>{item.path}</small>{item.warning && <em><AlertTriangle size={11}/>{item.warning}</em>}</div><strong>{formatSize(item.size)}</strong>
      <button className="mini-btn" title="Open" aria-label={`Open ${item.name}`} onClick={() => void window.diskloom.openPath(item.path)}><ExternalLink size={15}/></button><button className="mini-btn" title="Show in folder" aria-label={`Show ${item.name} in folder`} onClick={() => void window.diskloom.reveal(item.path)}><FolderOpen size={15}/></button><button className="mini-btn reclaim-remove" title="Remove from list" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.path)}><X size={15}/></button>
    </article>)}</div>)}</section>
  </main>
}

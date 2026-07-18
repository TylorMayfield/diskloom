import { Fragment, useEffect, useState } from 'react'
import { Table, Theme } from '@radix-ui/themes'
import { ChevronDown, ChevronRight, Copy, ExternalLink, FolderOpen, LoaderCircle, Search, Trash2 } from 'lucide-react'
import type { DuplicateAnalysisResult, DuplicateFile, DuplicateGroup, DuplicateProgress } from './types'
import { FileKindIcon } from './FileKindIcon'
import { track } from './analytics'

type Props = {
  rootPath: string
  result: DuplicateAnalysisResult | null
  progress: DuplicateProgress | null
  analyzing: boolean
  onAnalyze(): void
  onCancel(): void
  onResultChange(result: DuplicateAnalysisResult): void
  onMessage(message: string, error?: boolean): void
  formatSize(bytes: number): string
}

const oldestCopy = (files: DuplicateFile[]) => [...files].sort((a, b) => {
  const date = new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()
  return date || a.path.length - b.path.length || a.path.localeCompare(b.path)
})[0]

const dateText = (value?: string) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Unavailable'

export function Duplicates({ rootPath, result, progress, analyzing, onAnalyze, onCancel, onResultChange, onMessage, formatSize }: Props) {
  const [retained, setRetained] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cleaning, setCleaning] = useState(false)
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  useEffect(() => {
    if (!analyzing) return
    setRetained({}); setSelected(new Set()); setExpanded(new Set())
  }, [analyzing])

  useEffect(() => {
    if (!result) return
    setRetained((current) => {
      const next = { ...current }
      result.groups.forEach((group) => { if (!next[group.id]) next[group.id] = oldestCopy(group.files).path })
      return next
    })
    setSelected((current) => {
      const next = new Set(current)
      result.groups.forEach((group) => {
        const keep = retained[group.id] ?? oldestCopy(group.files).path
        if (!retained[group.id]) group.files.forEach((file) => { if (file.path !== keep) next.add(file.path) })
      })
      return next
    })
    setExpanded((current) => new Set([...current, ...result.groups.map((group) => group.id)]))
  }, [result])

  const selectedFiles = result?.groups.flatMap((group) => group.files.filter((file) => selected.has(file.path))) ?? []
  const reclaimable = selectedFiles.reduce((sum, file) => sum + file.size, 0)

  const chooseRetained = (group: DuplicateGroup, path: string) => {
    setRetained((current) => ({ ...current, [group.id]: path }))
    setSelected((current) => {
      const next = new Set(current)
      group.files.forEach((file) => file.path === path ? next.delete(file.path) : next.add(file.path))
      return next
    })
  }

  const clean = async () => {
    if (!result || !selectedFiles.length) return
    setConfirmCleanup(false)
    setCleaning(true)
    try {
      const groups = result.groups.map((group) => ({
        groupId: group.id,
        retained: group.files.find((file) => file.path === retained[group.id])!,
        selected: group.files.filter((file) => selected.has(file.path)),
      })).filter((group) => group.selected.length && group.retained)
      const cleanup = await window.diskloom.trashDuplicates({ groups })
      const trashed = new Set(cleanup.outcomes.filter((item) => item.status === 'trashed').map((item) => item.path))
      const unsuccessful = cleanup.outcomes.filter((item) => item.status !== 'trashed')
      const nextGroups = result.groups.map((group) => {
        const files = group.files.filter((file) => !trashed.has(file.path))
        return { ...group, files, wastedSpace: group.size * Math.max(0, files.length - 1) }
      }).filter((group) => group.files.length > 1)
      const next = {
        ...result, groups: nextGroups,
        totalWastedSpace: nextGroups.reduce((sum, group) => sum + group.wastedSpace, 0),
        duplicateFileCount: nextGroups.reduce((sum, group) => sum + group.files.length - 1, 0),
      }
      setSelected((current) => new Set([...current].filter((path) => !trashed.has(path))))
      onResultChange(next)
      track('duplicate_cleanup_completed', { trashed_count: trashed.size, unsuccessful_count: unsuccessful.length })
      onMessage(`${trashed.size.toLocaleString()} file${trashed.size === 1 ? '' : 's'} moved to Trash${unsuccessful.length ? `; ${unsuccessful.length} skipped or failed` : ''}.`, unsuccessful.length > 0)
    } catch (cause) { onMessage(cause instanceof Error ? cause.message : 'Duplicate cleanup failed.', true) }
    finally { setCleaning(false) }
  }

  if (analyzing) return <section className="duplicates-state">
    <LoaderCircle className="spin" size={42}/><h2>{progress?.phase === 'hashing' ? 'Comparing file contents' : 'Finding candidates'}</h2>
    <p>{(progress?.filesProcessed ?? 0).toLocaleString()} files processed{progress?.totalFiles ? ` of ${progress.totalFiles.toLocaleString()}` : ''}</p>
    {progress?.phase === 'hashing' && <div className="duplicate-progress"><i style={{ width: `${Math.min(100, (progress.bytesHashed / Math.max(1, progress.totalBytes ?? 1)) * 100)}%` }}/></div>}
    <small className="progress-path">{progress?.currentPath || rootPath}</small><button className="secondary-btn" onClick={onCancel}>Cancel analysis</button>
  </section>

  if (!result) return <section className="duplicates-state"><div className="duplicate-hero"><Copy size={48}/></div><h2>Find duplicate files</h2><p>Diskloom groups files by size, then privately compares only likely matches. File contents never leave this computer.</p><button className="hero-btn" onClick={onAnalyze}><Search size={18}/> Analyze duplicates</button></section>
  if (!result.groups.length) return <section className="duplicates-state"><div className="duplicate-hero"><Copy size={48}/></div><h2>No duplicates found</h2><p>{result.scannedFileCount.toLocaleString()} files inspected and {result.hashedFileCount.toLocaleString()} candidates compared.</p><button className="secondary-btn" onClick={onAnalyze}>Analyze again</button></section>

  return <><section className="duplicates-results">
    <div className="duplicates-summary"><div><p className="eyebrow">RECLAIMABLE SPACE</p><strong>{formatSize(result.totalWastedSpace)}</strong></div><div><b>{result.groups.length.toLocaleString()}</b><span>duplicate groups</span></div><div><b>{result.duplicateFileCount.toLocaleString()}</b><span>extra copies</span></div><button className="secondary-btn" onClick={onAnalyze}>Analyze again</button></div>
    <Theme className="duplicate-table-theme" appearance="dark" accentColor="amber" grayColor="slate" radius="medium" scaling="90%" hasBackground={false}>
    <div className="duplicate-table-wrap"><Table.Root className="duplicate-table" variant="surface" layout="fixed" size="2">
      <Table.Header><Table.Row>
        <Table.ColumnHeaderCell width="44px"><span className="sr-only">Trash selection</span></Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>File</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell width="180px">Modified</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell width="110px" justify="end">Size</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell width="100px">Retention</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell width="82px"><span className="sr-only">Actions</span></Table.ColumnHeaderCell>
      </Table.Row></Table.Header>
      <Table.Body>{result.groups.map((group) => {
      const open = expanded.has(group.id), keep = retained[group.id]
      return <Fragment key={group.id}><Table.Row className="duplicate-group-row">
        <Table.Cell colSpan={6}><button className="duplicate-group-toggle" aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); open ? next.delete(group.id) : next.add(group.id); return next })}>{open ? <ChevronDown size={17}/> : <ChevronRight size={17}/>}<span><b>{group.files.every((file) => file.name === group.files[0].name) ? group.files[0].name : 'Matching files'}</b><small>{group.files.length} copies · {formatSize(group.size)} each</small></span><strong>{formatSize(group.wastedSpace)} wasted</strong></button></Table.Cell>
      </Table.Row>
        {open && group.files.map((file) => <Table.Row className={file.path === keep ? 'duplicate-data-row kept' : 'duplicate-data-row'} key={file.path}>
          <Table.Cell><input type="checkbox" checked={selected.has(file.path)} disabled={file.path === keep} aria-label={`Select ${file.name} for Trash`} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(file.path) : next.delete(file.path); return next })}/></Table.Cell>
          <Table.RowHeaderCell><div className="duplicate-file-cell"><FileKindIcon name={file.name} kind="file"/><div className="duplicate-file-info"><b>{file.name}</b><span title={file.parentPath}>{file.parentPath}</span><small>Created {dateText(file.createdAt)}</small></div></div></Table.RowHeaderCell>
          <Table.Cell className="duplicate-date">{dateText(file.modifiedAt)}</Table.Cell>
          <Table.Cell justify="end" className="duplicate-size">{formatSize(file.size)}</Table.Cell>
          <Table.Cell><button className="keep-btn" onClick={() => chooseRetained(group, file.path)}>{file.path === keep ? 'Keeping' : 'Keep this'}</button></Table.Cell>
          <Table.Cell><div className="duplicate-actions"><button className="mini-btn" aria-label={`Open ${file.name}`} title="Open file" onClick={() => void window.diskloom.openPath(file.path)}><ExternalLink size={15}/></button><button className="mini-btn" aria-label={`Show ${file.name} in folder`} title="Show in folder" onClick={() => void window.diskloom.reveal(file.path)}><FolderOpen size={15}/></button></div></Table.Cell>
        </Table.Row>)}</Fragment>
      })}</Table.Body>
    </Table.Root></div></Theme>
    <div className="cleanup-bar"><div><b>{selectedFiles.length.toLocaleString()} selected</b><span>{formatSize(reclaimable)} reclaimable</span></div><button className="danger-btn" disabled={!selectedFiles.length || cleaning} onClick={() => setConfirmCleanup(true)}><Trash2 size={16}/>{cleaning ? 'Moving…' : 'Move to Trash'}</button></div>
  </section>
    {confirmCleanup && <div className="reclaim-result-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmCleanup(false) }}><section className="reclaim-result trash-confirm" role="dialog" aria-modal="true" aria-labelledby="duplicate-cleanup-title" aria-describedby="duplicate-cleanup-description"><div className="reclaim-result-mark trash-confirm-mark"><Trash2 size={27}/></div><p className="eyebrow">CONFIRM CLEANUP</p><h2 id="duplicate-cleanup-title">Move {selectedFiles.length.toLocaleString()} duplicate{selectedFiles.length === 1 ? '' : 's'} to Trash?</h2><p id="duplicate-cleanup-description">This can free {formatSize(reclaimable)}. Diskloom will retain at least one copy from every duplicate group, and removed files remain recoverable until the system Trash is emptied.</p><div className="reclaim-result-actions"><button className="secondary-btn" onClick={() => setConfirmCleanup(false)}>Cancel</button><button className="danger-btn" onClick={() => void clean()}><Trash2 size={15}/> Move to Trash</button></div></section></div>}
  </>
}

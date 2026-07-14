import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Table, Theme } from '@radix-ui/themes'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ChevronRight, FolderOpen, Gauge, HardDrive, LoaderCircle, MoreHorizontal, Search, Trash2, X } from 'lucide-react'
import { Sunburst } from './Sunburst'
import { Duplicates } from './Duplicates'
import { Benchmark } from './Benchmark'
import { configureAnalytics, setAnalyticsConsent, track, trackScreen } from './analytics'
import type { DiskNode, DuplicateAnalysisResult, DuplicateProgress, ScanResult } from './types'

const formatSize = (bytes: number) => {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toFixed(unit > 2 ? 2 : unit ? 1 : 0)} ${units[unit]}`
}

const telemetryStorageKey = 'diskloom.telemetry-enabled'
const savedTelemetryPreference = () => {
  const value = localStorage.getItem(telemetryStorageKey)
  return value === null ? null : value === 'true'
}

export function App() {
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [selected, setSelected] = useState<DiskNode | null>(null)
  const [chartRoot, setChartRoot] = useState<DiskNode | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ path: '', items: 0 })
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [pendingTrash, setPendingTrash] = useState<DiskNode | null>(null)
  const [view, setView] = useState<'map' | 'duplicates' | 'benchmark'>('map')
  const [duplicates, setDuplicates] = useState<DuplicateAnalysisResult | null>(null)
  const [duplicateProgress, setDuplicateProgress] = useState<DuplicateProgress | null>(null)
  const [analyzingDuplicates, setAnalyzingDuplicates] = useState(false)
  const [notice, setNotice] = useState('')
  const [telemetryEnabled, setTelemetryEnabled] = useState<boolean | null>(savedTelemetryPreference)
  const [telemetryDialogOpen, setTelemetryDialogOpen] = useState(telemetryEnabled === null)

  useEffect(() => { void window.diskloom.getAppInfo().then(configureAnalytics).catch(() => undefined) }, [])
  useEffect(() => { if (telemetryEnabled !== null) setAnalyticsConsent(telemetryEnabled) }, [telemetryEnabled])
  useEffect(() => window.diskloom.onProgress(setProgress), [])
  useEffect(() => window.diskloom.onDuplicateProgress(setDuplicateProgress), [])
  useEffect(() => { trackScreen(scan ? view : 'welcome') }, [scan, view, telemetryEnabled])

  const runScan = async (target?: string) => {
    try {
      const path = target ?? await window.diskloom.pickFolder()
      if (!path) return
      track('scan_started')
      setBusy(true); setError(''); setProgress({ path, items: 0 })
      const result = await window.diskloom.scan(path)
      const firstPage = await window.diskloom.getChildren(result.id, result.root.path, 0, 60)
      const root = { ...result.root, children: firstPage.children, childCount: firstPage.total }
      result.root = root
      setScan(result); setSelected(root); setChartRoot(root)
      setDuplicates(null); setView('map'); setNotice('')
      track('scan_completed', { duration_ms: Math.round(result.durationMs), item_count: result.itemCount, inaccessible_count: result.inaccessibleCount })
    } catch (cause) {
      track('scan_failed')
      setError(cause instanceof Error ? cause.message : 'The scan could not be completed.')
    } finally { setBusy(false) }
  }

  const crumbs = useMemo(() => {
    if (!scan || !chartRoot) return []
    const rel = chartRoot.path.slice(scan.root.path.length).split(/[\\/]/).filter(Boolean)
    const nodes: { name: string; path: string }[] = [{ name: scan.root.name, path: scan.root.path }]
    const separator = scan.root.path.includes('\\') ? '\\' : '/'
    rel.forEach((part) => nodes.push({ name: part, path: `${nodes.at(-1)!.path.replace(/[\\/]$/, '')}${separator}${part}` }))
    return nodes
  }, [scan, chartRoot])

  const findNode = (node: DiskNode, path: string): DiskNode | null => {
    if (node.path === path) return node
    for (const child of node.children ?? []) { const found = findNode(child, path); if (found) return found }
    return null
  }

  const replaceNode = (node: DiskNode, replacement: DiskNode): DiskNode => {
    if (node.path === replacement.path) return replacement
    if (!node.children) return node
    let changed = false
    const children = node.children.map((child) => {
      const next = replaceNode(child, replacement); if (next !== child) changed = true; return next
    })
    return changed ? { ...node, children } : node
  }

  const inspectNode = async (node: DiskNode) => {
    if (!scan || node.kind !== 'folder') { setSelected(node); return }
    try {
      const page = await window.diskloom.getChildren(scan.id, node.path, 0, 60)
      const hydrated = { ...node, children: page.children, childCount: page.total }
      setScan((current) => current ? { ...current, root: replaceNode(current.root, hydrated) } : current)
      setSelected(hydrated); setChartRoot(hydrated)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load this folder.') }
  }

  const loadMoreChildren = async () => {
    if (!scan || !selected || selected.kind !== 'folder') return
    try {
      const offset = selected.children?.length ?? 0
      const page = await window.diskloom.getChildren(scan.id, selected.path, offset, 60)
      const hydrated = { ...selected, children: [...(selected.children ?? []), ...page.children], childCount: page.total }
      setScan((current) => current ? { ...current, root: replaceNode(current.root, hydrated) } : current)
      setSelected(hydrated); if (chartRoot?.path === hydrated.path) setChartRoot(hydrated)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load more items.') }
  }

  const navigateTo = (path: string) => {
    if (!scan) return
    const node = findNode(scan.root, path)
    if (node) void inspectNode(node)
  }

  const removeNode = (node: DiskNode, target: string): [DiskNode | null, number] => {
    if (node.path === target) return [null, node.size]
    if (!node.children) return [node, 0]
    let removed = 0
    const children: DiskNode[] = []
    for (const child of node.children) {
      const [next, childRemoved] = removeNode(child, target)
      removed += childRemoved
      if (next) children.push(next)
    }
    return removed ? [{ ...node, size: Math.max(0, node.size - removed), children }, removed] : [node, 0]
  }

  const trashNode = async (node: DiskNode) => {
    if (!scan) return
    try {
      setPendingTrash(null); setDeleting(node.path); setError(''); setNotice(`Moving “${node.name}” to Trash…`)
      await window.diskloom.trash(node.path)
      track('item_trashed', { item_kind: node.kind })
      setNotice(`“${node.name}” was moved to Trash.`)
      const [nextRoot] = removeNode(scan.root, node.path)
      if (!nextRoot) return
      const selectedPath = selected?.path
      const chartRootPath = chartRoot?.path
      setScan({ ...scan, root: nextRoot })
      setSelected((selectedPath && findNode(nextRoot, selectedPath)) || findNode(nextRoot, node.path.slice(0, node.path.lastIndexOf('/'))) || nextRoot)
      setChartRoot((chartRootPath && findNode(nextRoot, chartRootPath)) || nextRoot)
    } catch (cause) {
      setNotice('')
      setError(cause instanceof Error ? cause.message : `Could not move ${node.name} to the Trash.`)
    } finally { setDeleting(null) }
  }

  const analyzeDuplicateFiles = async () => {
    if (!scan) return
    try {
      setAnalyzingDuplicates(true); setDuplicateProgress(null); setError(''); setNotice('')
      track('duplicate_analysis_started')
      const result = await window.diskloom.analyzeDuplicates(scan.root.path)
      setDuplicates(result)
      track('duplicate_analysis_completed', { group_count: result.groups.length, duplicate_file_count: result.duplicateFileCount })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Duplicate analysis failed.'
      if (!message.toLowerCase().includes('cancel')) setError(message)
    } finally { setAnalyzingDuplicates(false) }
  }

  const chooseTelemetry = (enabled: boolean) => {
    localStorage.setItem(telemetryStorageKey, String(enabled))
    setTelemetryEnabled(enabled)
    setTelemetryDialogOpen(false)
  }

  const startWindowDrag = (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as Element
    if (target.closest('button, a, input, select, textarea, [role="button"], [data-no-drag]')) return
    event.preventDefault()
    void getCurrentWindow().startDragging()
  }

  return <Tooltip.Provider delayDuration={300}>
    <div className="app-shell">
      <header className="titlebar" onMouseDown={startWindowDrag}>
        <nav className="breadcrumbs">{crumbs.map((crumb, i) => <span key={crumb.path} className="crumb-wrap">{i > 0 && <ChevronRight size={14}/>}<button onClick={() => navigateTo(crumb.path)}>{crumb.name}</button></span>)}</nav>
        <div className="header-actions">
          <button className="header-benchmark-btn" onClick={() => setView('benchmark')}><Gauge size={16}/> Benchmark</button>
          <button className="primary-btn" onClick={() => void runScan()}><Search size={16}/> Scan folder</button>
        </div>
      </header>

      {view === 'benchmark' && !scan ? <><div className="result-tabs"><button onClick={() => setView('map')}>Disk Map</button><button disabled>Duplicates</button><button className="active">Benchmark</button></div><Benchmark onError={setError}/></>
      : busy ? <main className="loading-state"><div className="scanner-orbit"><HardDrive size={38}/></div><h1>Mapping your disk</h1><p>{progress.items.toLocaleString()} items inspected</p><div className="progress-path">{progress.path}</div></main>
      : !scan ? <main className="welcome">
          <div className="welcome-art"><div className="orb orb-a"/><div className="orb orb-b"/><div className="orb orb-c"/><HardDrive size={58}/></div>
          <h1>Find what’s filling<br/>your disk.</h1><p className="welcome-copy">A fast, private map of every folder. File and folder data never leaves your computer.</p>
          <button className="hero-btn" onClick={() => void runScan()}><FolderOpen size={20}/> Choose a folder to scan</button>
        </main>
      : <><div className="result-tabs"><button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>Disk Map</button><button className={view === 'duplicates' ? 'active' : ''} onClick={() => setView('duplicates')}>Duplicates{duplicates?.groups.length ? <span>{duplicates.groups.length}</span> : null}</button><button className={view === 'benchmark' ? 'active' : ''} onClick={() => setView('benchmark')}>Benchmark</button></div>{view === 'map' ? <main className="workspace">
          <section className="visual-panel"><Sunburst root={chartRoot ?? scan.root} selected={selected ?? scan.root} onSelect={inspectNode} onRequestTrash={setPendingTrash} formatSize={formatSize}/><div className="legend"><span><i className="dot folder-dot"/>Folders</span><span><i className="dot file-dot"/>Files</span><span>{scan.itemCount.toLocaleString()} items · {(scan.durationMs / 1000).toFixed(1)}s</span></div></section>
          <aside className="details-panel">
            <div className="details-heading"><div className="detail-path" title={selected?.path}><FolderOpen size={15}/><span>{selected?.path}</span></div><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-btn"><MoreHorizontal/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu" align="end"><DropdownMenu.Item onSelect={() => selected && void window.diskloom.openPath(selected.path)}>Open</DropdownMenu.Item><DropdownMenu.Item onSelect={() => selected && void window.diskloom.reveal(selected.path)}>Show in folder</DropdownMenu.Item>{selected && selected.path !== scan.root.path && (selected.kind === 'file' || selected.kind === 'folder') && <><DropdownMenu.Separator className="menu-separator"/><DropdownMenu.Item className="menu-danger" onSelect={() => setPendingTrash(selected)}><Trash2 size={14}/> Move to Trash</DropdownMenu.Item></>}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
            <Theme className="contents-table-theme" appearance="dark" accentColor="amber" grayColor="slate" radius="medium" scaling="90%" hasBackground={false}>
              <div className="contents-table-wrap"><Table.Root className="contents-table" variant="ghost" layout="fixed" size="2">
                <Table.Header><Table.Row><Table.ColumnHeaderCell>Contents</Table.ColumnHeaderCell><Table.ColumnHeaderCell width="92px" justify="end">Size</Table.ColumnHeaderCell><Table.ColumnHeaderCell width="86px"><span className="sr-only">Actions</span></Table.ColumnHeaderCell></Table.Row></Table.Header>
                <Table.Body>{selected?.children?.slice(0, 60).map((child) => <Table.Row className="contents-row" key={child.path + child.name}>
                  <Table.RowHeaderCell><button className="contents-item" onClick={() => inspectNode(child)}><span className={`file-icon ${child.kind}`}>{child.kind === 'folder' ? '◼' : '●'}</span><span className="file-info"><b>{child.name}</b><small>{child.kind}</small></span></button></Table.RowHeaderCell>
                  <Table.Cell className="file-size" justify="end">{formatSize(child.size)}</Table.Cell>
                  <Table.Cell><div className="contents-actions"><button className="contents-open" aria-label={`Inspect ${child.name}`} onClick={() => void inspectNode(child)}><ChevronRight size={15}/></button>{(child.kind === 'file' || child.kind === 'folder') && <button className="row-delete" disabled={deleting === child.path} aria-label={`Move ${child.name} to Trash`} title="Move to Trash" onClick={() => setPendingTrash(child)}>{deleting === child.path ? <LoaderCircle className="spin" size={14}/> : <Trash2 size={14}/>}</button>}</div></Table.Cell>
                </Table.Row>)}</Table.Body>
              </Table.Root>{!selected?.children?.length && <div className="empty-list">No mapped contents</div>}{selected && (selected.children?.length ?? 0) < (selected.childCount ?? 0) && <button className="load-more" onClick={() => void loadMoreChildren()}>Load more · {(selected.childCount! - (selected.children?.length ?? 0)).toLocaleString()} remaining</button>}</div>
            </Theme>
          </aside>
        </main> : view === 'duplicates' ? <Duplicates rootPath={scan.root.path} result={duplicates} progress={duplicateProgress} analyzing={analyzingDuplicates} onAnalyze={() => void analyzeDuplicateFiles()} onCancel={() => { track('duplicate_analysis_cancelled'); void window.diskloom.cancelDuplicateAnalysis() }} onResultChange={setDuplicates} onMessage={(message, isError) => { isError ? setError(message) : setNotice(message) }} formatSize={formatSize}/> : <Benchmark target={scan.root.path} onError={setError}/>}</>}
      {error && <div className="error-toast">{error}<button onClick={() => setError('')}><X size={16}/></button></div>}
      {notice && <div className="notice-toast">{notice}<button onClick={() => setNotice('')}><X size={16}/></button></div>}
      {pendingTrash && <div className="reclaim-result-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingTrash(null) }}><section className="reclaim-result trash-confirm" role="dialog" aria-modal="true" aria-label="Confirm deletion" aria-describedby="trash-confirm-description"><div className="reclaim-result-mark trash-confirm-mark"><Trash2 size={27}/></div><p className="eyebrow">CONFIRM DELETION</p><p id="trash-confirm-description">This will remove {formatSize(pendingTrash.size)} from its current location. It can be recovered from the system Trash until the Trash is emptied.</p><small className="trash-confirm-path" title={pendingTrash.path}>{pendingTrash.path}</small><div className="reclaim-result-actions"><button className="secondary-btn" onClick={() => setPendingTrash(null)}>Cancel</button><button className="danger-btn" onClick={() => void trashNode(pendingTrash)}><Trash2 size={15}/> Move to Trash</button></div></section></div>}
      <footer className="support-footer"><span>Diskloom is free and open source.</span><button className="telemetry-link" onClick={() => setTelemetryDialogOpen(true)}>Telemetry: {telemetryEnabled === null ? 'Not set' : telemetryEnabled ? 'On' : 'Off'}</button><i aria-hidden="true">·</i><a href="https://ko-fi.com/tylormayfield" target="_blank" rel="noreferrer">Support on Ko-fi ♡</a><i aria-hidden="true">·</i><a href="https://www.tylor.nz/legal" target="_blank" rel="noreferrer">Privacy &amp; Terms ↗</a><i aria-hidden="true">·</i><a href="https://github.com/TylorMayfield/diskloom/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT License ↗</a></footer>
      {telemetryDialogOpen && <div className="telemetry-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && telemetryEnabled !== null) setTelemetryDialogOpen(false) }}>
        <section className="telemetry-dialog" role="dialog" aria-modal="true" aria-labelledby="telemetry-title" aria-describedby="telemetry-description">
          {telemetryEnabled !== null && <button className="telemetry-close" aria-label="Close telemetry settings" onClick={() => setTelemetryDialogOpen(false)}><X size={17}/></button>}
          <div className="telemetry-mark"><Gauge size={28}/></div>
          <p className="eyebrow">PRIVACY CHOICE</p>
          <h2 id="telemetry-title">Help improve Diskloom?</h2>
          <p id="telemetry-description">Allow anonymous usage analytics so we can understand app versions, platforms, and which features are useful.</p>
          <ul><li>Collected: app version, operating system, feature usage, and coarse operation counts and timing.</li><li>Never collected: paths, filenames, file contents, hashes, drive names, or benchmark results.</li></ul>
          <p className="telemetry-status">{telemetryEnabled === null ? 'Nothing will be sent unless you allow it.' : <>Telemetry is currently <b>{telemetryEnabled ? 'on' : 'off'}</b>.</>} You can change this anytime from the footer.</p>
          <div className="telemetry-actions"><button className="secondary-btn" onClick={() => chooseTelemetry(false)}>Don’t share</button><button className="primary-btn" onClick={() => chooseTelemetry(true)}>Allow anonymous analytics</button></div>
        </section>
      </div>}
    </div>
  </Tooltip.Provider>
}

import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { DataList, Table, Theme } from '@radix-ui/themes'
import { ChevronRight, FolderOpen, Gauge, HardDrive, ListPlus, MoreHorizontal, Search, Trash2, X } from 'lucide-react'
import { Sunburst } from './Sunburst'
import { Duplicates } from './Duplicates'
import { Benchmark } from './Benchmark'
import { overlapsReclaim, Reclaim } from './Reclaim'
import { configureAnalytics, setAnalyticsConsent, track, trackScreen } from './analytics'
import type { DiskNode, DuplicateAnalysisResult, DuplicateProgress, ReclaimItem, ReclaimResult, ScanResult } from './types'

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
  const [view, setView] = useState<'map' | 'duplicates' | 'reclaim' | 'benchmark'>('map')
  const [duplicates, setDuplicates] = useState<DuplicateAnalysisResult | null>(null)
  const [duplicateProgress, setDuplicateProgress] = useState<DuplicateProgress | null>(null)
  const [analyzingDuplicates, setAnalyzingDuplicates] = useState(false)
  const [notice, setNotice] = useState('')
  const [telemetryEnabled, setTelemetryEnabled] = useState<boolean | null>(savedTelemetryPreference)
  const [telemetryDialogOpen, setTelemetryDialogOpen] = useState(telemetryEnabled === null)
  const [reclaimBusy, setReclaimBusy] = useState(false)
  const [reclaimSummary, setReclaimSummary] = useState<ReclaimResult | null>(null)
  const [reclaimItems, setReclaimItems] = useState<ReclaimItem[]>(() => {
    try { return JSON.parse(localStorage.getItem('diskloom.reclaim-items') ?? '[]') as ReclaimItem[] } catch { return [] }
  })

  useEffect(() => { void window.diskloom.getAppInfo().then(configureAnalytics).catch(() => undefined) }, [])
  useEffect(() => { if (telemetryEnabled !== null) setAnalyticsConsent(telemetryEnabled) }, [telemetryEnabled])
  useEffect(() => window.diskloom.onProgress(setProgress), [])
  useEffect(() => window.diskloom.onDuplicateProgress(setDuplicateProgress), [])
  useEffect(() => { trackScreen(scan ? view : 'welcome') }, [scan, view, telemetryEnabled])
  useEffect(() => { localStorage.setItem('diskloom.reclaim-items', JSON.stringify(reclaimItems)) }, [reclaimItems])

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

  const addToReclaim = async (node: DiskNode) => {
    if (!scan) return
    try {
      const item = await window.diskloom.getReclaimItem(scan.id, node.path)
      if (overlapsReclaim(reclaimItems, item)) { setError('That item overlaps a file or folder already in the Reclaim List.'); return }
      setReclaimItems((current) => [...current, item]); setNotice(`${node.name} added to the Reclaim List.`)
      track('reclaim_item_added', { item_kind: node.kind })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add this item to Reclaim.') }
  }

  const trashReclaim = async (): Promise<ReclaimResult> => {
    setReclaimBusy(true); setError(''); setReclaimSummary(null)
    try {
      const result = await window.diskloom.trashReclaim(reclaimItems)
      const trashed = new Set(result.outcomes.filter((item) => item.status === 'trashed').map((item) => item.path))
      setReclaimItems((current) => current.filter((item) => !trashed.has(item.path)))
      const skipped = result.outcomes.length - trashed.size
      if (scan) await runScan(scan.root.path)
      setReclaimSummary(result)
      setNotice(`Diskloom reclaimed ${formatSize(result.reclaimedBytes)}${skipped ? `; ${skipped} item${skipped === 1 ? '' : 's'} skipped or failed` : ''}.`)
      track('reclaim_completed', { trashed_count: trashed.size, unsuccessful_count: skipped })
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reclaim could not be completed.')
      return { outcomes: [], reclaimedBytes: 0 }
    } finally { setReclaimBusy(false) }
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
    if (!scan || !window.confirm(`Move “${node.name}” to the Trash?\n\n${node.path}`)) return
    try {
      setDeleting(node.path); setError('')
      await window.diskloom.trash(node.path)
      track('item_trashed', { item_kind: node.kind })
      const [nextRoot] = removeNode(scan.root, node.path)
      if (!nextRoot) return
      const selectedPath = selected?.path
      const chartRootPath = chartRoot?.path
      setScan({ ...scan, root: nextRoot })
      setSelected((selectedPath && findNode(nextRoot, selectedPath)) || findNode(nextRoot, node.path.slice(0, node.path.lastIndexOf('/'))) || nextRoot)
      setChartRoot((chartRootPath && findNode(nextRoot, chartRootPath)) || nextRoot)
    } catch (cause) {
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

  return <Tooltip.Provider delayDuration={300}>
    <div className="app-shell">
      <header className="titlebar">
        <nav className="breadcrumbs">{crumbs.map((crumb, i) => <span key={crumb.path} className="crumb-wrap">{i > 0 && <ChevronRight size={14}/>}<button onClick={() => navigateTo(crumb.path)}>{crumb.name}</button></span>)}</nav>
        <div className="header-actions">
          <button className="header-benchmark-btn" onClick={() => setView('benchmark')}><Gauge size={16}/> Benchmark</button>
          <button className="primary-btn" onClick={() => void runScan()}><Search size={16}/> Scan folder</button>
        </div>
      </header>

      {view === 'benchmark' && !scan ? <><div className="result-tabs"><button onClick={() => setView('map')}>Disk Map</button><button disabled>Duplicates</button><button disabled>Reclaim</button><button className="active">Benchmark</button></div><Benchmark onError={setError}/></>
      : busy ? <main className="loading-state"><div className="scanner-orbit"><HardDrive size={38}/></div><h1>Mapping your disk</h1><p>{progress.items.toLocaleString()} items inspected</p><div className="progress-path">{progress.path}</div></main>
      : !scan ? <main className="welcome">
          <div className="welcome-art"><div className="orb orb-a"/><div className="orb orb-b"/><div className="orb orb-c"/><HardDrive size={58}/></div>
          <h1>Find what’s filling<br/>your disk.</h1><p className="welcome-copy">A fast, private map of every folder. File and folder data never leaves your computer.</p>
          <button className="hero-btn" onClick={() => void runScan()}><FolderOpen size={20}/> Choose a folder to scan</button>
        </main>
      : <><div className="result-tabs"><button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>Disk Map</button><button className={view === 'duplicates' ? 'active' : ''} onClick={() => setView('duplicates')}>Duplicates{duplicates?.groups.length ? <span>{duplicates.groups.length}</span> : null}</button><button className={view === 'reclaim' ? 'active' : ''} onClick={() => setView('reclaim')}>Reclaim{reclaimItems.length ? <span>{reclaimItems.length}</span> : null}</button><button className={view === 'benchmark' ? 'active' : ''} onClick={() => setView('benchmark')}>Benchmark</button></div>{view === 'map' ? <main className="workspace">
          <section className="visual-panel"><Sunburst root={chartRoot ?? scan.root} selected={selected ?? scan.root} onSelect={inspectNode} formatSize={formatSize}/><div className="legend"><span><i className="dot folder-dot"/>Folders</span><span><i className="dot file-dot"/>Files</span><span>{scan.itemCount.toLocaleString()} items · {(scan.durationMs / 1000).toFixed(1)}s</span></div></section>
          <aside className="details-panel">
            <div className="details-heading"><div className="detail-path" title={selected?.path}><FolderOpen size={15}/><span>{selected?.path}</span></div><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-btn"><MoreHorizontal/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu" align="end"><DropdownMenu.Item onSelect={() => selected && void window.diskloom.openPath(selected.path)}>Open</DropdownMenu.Item><DropdownMenu.Item onSelect={() => selected && void window.diskloom.reveal(selected.path)}>Show in folder</DropdownMenu.Item>{selected && selected.path !== scan.root.path && (selected.kind === 'file' || selected.kind === 'folder') && <DropdownMenu.Item onSelect={() => void addToReclaim(selected)}><ListPlus size={14}/> Add to Reclaim List</DropdownMenu.Item>}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
            <Theme className="item-metadata-theme" appearance="dark" accentColor="amber" grayColor="slate" radius="medium" scaling="90%" hasBackground={false}>
              <DataList.Root className="item-metadata" orientation="horizontal" size="2">
                <DataList.Item align="center"><DataList.Label minWidth="110px">Size on disk</DataList.Label><DataList.Value>{formatSize(selected?.size ?? 0)}</DataList.Value></DataList.Item>
                <DataList.Item align="center"><DataList.Label minWidth="110px">Accessible total</DataList.Label><DataList.Value>{formatSize(scan.accessibleSize)}</DataList.Value></DataList.Item>
                <DataList.Item align="center"><DataList.Label minWidth="110px">Scan coverage</DataList.Label><DataList.Value>{scan.unknownCount ? `${scan.unknownCount.toLocaleString()} inaccessible / unknown` : 'All discovered bytes counted'}</DataList.Value></DataList.Item>
                {!!scan.excludedCount && <DataList.Item align="center"><DataList.Label minWidth="110px">Excluded</DataList.Label><DataList.Value>{scan.excludedCount.toLocaleString()} symbolic link target{scan.excludedCount === 1 ? '' : 's'} not followed</DataList.Value></DataList.Item>}
                <DataList.Item align="center"><DataList.Label minWidth="110px">System / unknown</DataList.Label><DataList.Value>{scan.unaccountedSize === null ? 'Not measurable for a folder scan' : formatSize(scan.unaccountedSize)}</DataList.Value></DataList.Item>
              </DataList.Root>
            </Theme>
            <Theme className="contents-table-theme" appearance="dark" accentColor="amber" grayColor="slate" radius="medium" scaling="90%" hasBackground={false}>
              <div className="contents-table-wrap"><Table.Root className="contents-table" variant="ghost" layout="fixed" size="2">
                <Table.Header><Table.Row><Table.ColumnHeaderCell>Contents</Table.ColumnHeaderCell><Table.ColumnHeaderCell width="92px" justify="end">Size</Table.ColumnHeaderCell><Table.ColumnHeaderCell width="86px"><span className="sr-only">Actions</span></Table.ColumnHeaderCell></Table.Row></Table.Header>
                <Table.Body>{selected?.children?.slice(0, 60).map((child) => <Table.Row className="contents-row" key={child.path + child.name}>
                  <Table.RowHeaderCell><button className="contents-item" onClick={() => inspectNode(child)}><span className={`file-icon ${child.kind}`}>{child.kind === 'folder' ? '◼' : '●'}</span><span className="file-info"><b>{child.name}</b><small>{child.kind}</small></span></button></Table.RowHeaderCell>
                  <Table.Cell className="file-size" justify="end">{formatSize(child.size)}</Table.Cell>
                  <Table.Cell><div className="contents-actions">{(child.kind === 'file' || child.kind === 'folder') && <button className="row-reclaim" aria-label={`Add ${child.name} to Reclaim List`} title="Add to Reclaim List" onClick={() => void addToReclaim(child)}><ListPlus size={14}/></button>}<button className="contents-open" aria-label={`Inspect ${child.name}`} onClick={() => void inspectNode(child)}><ChevronRight size={15}/></button>{(child.kind === 'file' || child.kind === 'folder') && <button className="row-delete" disabled={deleting === child.path} aria-label={`Move ${child.name} to Trash`} title="Move to Trash" onClick={() => void trashNode(child)}><Trash2 size={14}/></button>}</div></Table.Cell>
                </Table.Row>)}</Table.Body>
              </Table.Root>{!selected?.children?.length && <div className="empty-list">No mapped contents</div>}{selected && (selected.children?.length ?? 0) < (selected.childCount ?? 0) && <button className="load-more" onClick={() => void loadMoreChildren()}>Load more · {(selected.childCount! - (selected.children?.length ?? 0)).toLocaleString()} remaining</button>}</div>
            </Theme>
          </aside>
        </main> : view === 'duplicates' ? <Duplicates rootPath={scan.root.path} result={duplicates} progress={duplicateProgress} analyzing={analyzingDuplicates} onAnalyze={() => void analyzeDuplicateFiles()} onCancel={() => { track('duplicate_analysis_cancelled'); void window.diskloom.cancelDuplicateAnalysis() }} onResultChange={setDuplicates} onMessage={(message, isError) => { isError ? setError(message) : setNotice(message) }} formatSize={formatSize}/> : view === 'reclaim' ? <Reclaim items={reclaimItems} busy={reclaimBusy} onRemove={(path) => setReclaimItems((current) => current.filter((item) => item.path !== path))} onClear={() => setReclaimItems([])} onTrash={trashReclaim} formatSize={formatSize}/> : <Benchmark target={scan.root.path} onError={setError}/>}</>}
      {error && <div className="error-toast">{error}<button onClick={() => setError('')}><X size={16}/></button></div>}
      {notice && <div className="notice-toast">{notice}<button onClick={() => setNotice('')}><X size={16}/></button></div>}
      {reclaimSummary && <div className="reclaim-result-backdrop" role="presentation"><section className="reclaim-result" role="dialog" aria-modal="true" aria-labelledby="reclaim-result-title"><div className="reclaim-result-mark"><Trash2 size={28}/></div><p className="eyebrow">RECLAIM COMPLETE</p><h2 id="reclaim-result-title">Diskloom reclaimed {formatSize(reclaimSummary.reclaimedBytes)}</h2><p>{reclaimSummary.outcomes.filter((item) => item.status === 'trashed').length.toLocaleString()} item{reclaimSummary.outcomes.filter((item) => item.status === 'trashed').length === 1 ? '' : 's'} moved to Trash. {reclaimSummary.outcomes.some((item) => item.status !== 'trashed') && `${reclaimSummary.outcomes.filter((item) => item.status !== 'trashed').length} changed or unsuccessful item(s) stayed in your list.`}</p><div className="reclaim-result-actions"><a className="secondary-btn" href="https://ko-fi.com/tylormayfield" target="_blank" rel="noreferrer">Support Diskloom ♡</a><button className="primary-btn" onClick={() => setReclaimSummary(null)}>Done</button></div></section></div>}
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

import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Table, Theme } from '@radix-ui/themes'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ChevronRight, Clock3, Copy, FolderOpen, Gauge, HardDrive, House, Info, LoaderCircle, MoreHorizontal, Search, Trash2, X } from 'lucide-react'
import { Sunburst } from './Sunburst'
import { Duplicates } from './Duplicates'
import { Benchmark } from './Benchmark'
import { FileKindIcon } from './FileKindIcon'
import { Modal } from './Modal'
import { configureAnalytics, setAnalyticsConsent, track, trackScreen } from './analytics'
import type { AppInfo, DiskNode, DuplicateAnalysisResult, DuplicateProgress, ScanLocation, ScanResult } from './types'
import appIcon from '../docs/icon-transparent.png'

const formatSize = (bytes: number) => {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toFixed(unit > 2 ? 2 : unit ? 1 : 0)} ${units[unit]}`
}

const telemetryStorageKey = 'diskloom.telemetry-enabled'
const recentScansStorageKey = 'diskloom.recent-scans'
type RecentScan = { name: string; path: string }

const savedTelemetryPreference = () => {
  const value = localStorage.getItem(telemetryStorageKey)
  return value === null ? null : value === 'true'
}
const savedRecentScans = (): RecentScan[] => {
  try {
    const value = JSON.parse(localStorage.getItem(recentScansStorageKey) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is RecentScan => typeof item?.name === 'string' && typeof item?.path === 'string').slice(0, 4) : []
  } catch { return [] }
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
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false)
  const [telemetryPromptVisible, setTelemetryPromptVisible] = useState(false)
  const [scanLocations, setScanLocations] = useState<ScanLocation[]>([])
  const [recentScans, setRecentScans] = useState<RecentScan[]>(savedRecentScans)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => { void window.diskloom.getAppInfo().then((info) => { setAppInfo(info); configureAnalytics(info) }).catch(() => undefined) }, [])
  useEffect(() => { if (telemetryEnabled !== null) setAnalyticsConsent(telemetryEnabled) }, [telemetryEnabled])
  useEffect(() => window.diskloom.onProgress(setProgress), [])
  useEffect(() => window.diskloom.onDuplicateProgress(setDuplicateProgress), [])
  useEffect(() => { void window.diskloom.listScanLocations().then(setScanLocations).catch(() => undefined) }, [])
  useEffect(() => { trackScreen(view === 'benchmark' ? 'benchmark' : scan ? view : 'welcome') }, [scan, view, telemetryEnabled])

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
      setRecentScans((current) => {
        const next = [{ name: root.name, path: root.path }, ...current.filter((item) => item.path !== root.path)].slice(0, 4)
        localStorage.setItem(recentScansStorageKey, JSON.stringify(next))
        return next
      })
      if (telemetryEnabled === null) setTelemetryPromptVisible(true)
      track('scan_completed', { duration_ms: Math.round(result.durationMs), item_count: result.itemCount, inaccessible_count: result.inaccessibleCount })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The scan could not be completed.'
      if (!message.toLowerCase().includes('cancel')) { track('scan_failed'); setError(message) }
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
    setTelemetryPromptVisible(false)
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
        <div className="header-leading">
          <div className="app-brand"><img src={appIcon} alt=""/><span>Diskloom</span></div>
          {scan && view === 'map' && <nav className="breadcrumbs" aria-label="Current folder">{crumbs.map((crumb, i) => <span key={crumb.path} className="crumb-wrap">{i > 0 && <ChevronRight size={13}/>}<button onClick={() => navigateTo(crumb.path)}>{crumb.name}</button></span>)}</nav>}
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button className={view === 'map' ? 'active' : ''} aria-current={view === 'map' ? 'page' : undefined} onClick={() => setView('map')}><HardDrive size={15}/> Disk Map</button>
          <button className={view === 'duplicates' ? 'active' : ''} aria-current={view === 'duplicates' ? 'page' : undefined} disabled={!scan} title={!scan ? 'Scan a folder first' : undefined} onClick={() => setView('duplicates')}><Copy size={15}/> Duplicates{duplicates?.groups.length ? <span>{duplicates.groups.length}</span> : null}</button>
          <button className={view === 'benchmark' ? 'active' : ''} aria-current={view === 'benchmark' ? 'page' : undefined} onClick={() => setView('benchmark')}><Gauge size={15}/> Benchmark</button>
        </nav>
        <div className="header-actions">
          <button className="about-btn" aria-label="About and privacy" title="About and privacy" onClick={() => setAboutDialogOpen(true)}><Info size={17}/></button>
          <button className="primary-btn" onClick={() => void runScan()}><Search size={16}/> Scan folder</button>
        </div>
      </header>

      {busy ? <main className="loading-state" aria-live="polite"><div className="scanner-orbit"><HardDrive size={38}/></div><h1>Mapping your disk</h1><p>{progress.items.toLocaleString()} items inspected</p><div className="progress-path">{progress.path}</div><button className="secondary-btn scan-cancel" onClick={() => { track('scan_cancelled'); void window.diskloom.cancelScan() }}>Cancel scan</button></main>
      : view === 'benchmark' ? <Benchmark target={scan?.root.path} onError={setError}/>
      : !scan ? <main className="welcome">
          <div className="welcome-art"><img src={appIcon} alt=""/></div>
          <h1>Find what’s filling<br/>your disk.</h1><p className="welcome-copy">A fast, private map of every folder. File and folder data never leaves your computer.</p>
          <button className="hero-btn" onClick={() => void runScan()}><FolderOpen size={20}/> Choose a folder to scan</button>
          {(scanLocations.length > 0 || recentScans.length > 0) && <section className="scan-shortcuts" aria-label="Quick scan choices">
            {scanLocations.length > 0 && <div className="scan-shortcut-group"><p>QUICK START</p><div className="scan-shortcut-list">{scanLocations.slice(0, 3).map((location) => <button key={location.id} title={location.path} onClick={() => void runScan(location.path)}>{location.kind === 'home' ? <House size={17}/> : <HardDrive size={17}/>}<span><b>{location.name}</b><small>{location.freeBytes != null ? `${formatSize(location.freeBytes)} free` : location.path}</small></span><ChevronRight size={14}/></button>)}</div></div>}
            {recentScans.length > 0 && <div className="scan-shortcut-group recent"><p>RECENT</p><div className="scan-shortcut-list">{recentScans.slice(0, 2).map((item) => <button key={item.path} title={item.path} onClick={() => void runScan(item.path)}><Clock3 size={17}/><span><b>{item.name}</b><small>{item.path}</small></span><ChevronRight size={14}/></button>)}</div></div>}
          </section>}
        </main>
      : view === 'map' ? <main className="workspace">
          <section className="visual-panel"><Sunburst root={chartRoot ?? scan.root} selected={selected ?? scan.root} onSelect={inspectNode} onRequestTrash={setPendingTrash} formatSize={formatSize}/><div className="legend"><span><i className="dot folder-dot"/>Folders</span><span><i className="dot file-dot"/>Files</span><span>{scan.itemCount.toLocaleString()} items · {(scan.durationMs / 1000).toFixed(1)}s</span></div></section>
          <aside className="details-panel">
            <div className="details-heading"><div className="detail-path" title={selected?.path}><FolderOpen size={15}/><span>{selected?.path}</span></div><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-btn" aria-label={`More actions for ${selected?.name ?? 'selected item'}`} title="More actions"><MoreHorizontal/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu" align="end"><DropdownMenu.Item onSelect={() => selected && void window.diskloom.openPath(selected.path)}>Open</DropdownMenu.Item><DropdownMenu.Item onSelect={() => selected && void window.diskloom.reveal(selected.path)}>Show in folder</DropdownMenu.Item>{selected && selected.path !== scan.root.path && (selected.kind === 'file' || selected.kind === 'folder') && <><DropdownMenu.Separator className="menu-separator"/><DropdownMenu.Item className="menu-danger" onSelect={() => setPendingTrash(selected)}><Trash2 size={14}/> Move to Trash</DropdownMenu.Item></>}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
            <Theme className="contents-table-theme" appearance="dark" accentColor="amber" grayColor="slate" radius="medium" scaling="90%" hasBackground={false}>
              <div className="contents-table-wrap"><Table.Root className="contents-table" variant="ghost" layout="fixed" size="2">
                <Table.Header><Table.Row><Table.ColumnHeaderCell>Contents</Table.ColumnHeaderCell><Table.ColumnHeaderCell width="72px" justify="end">Size</Table.ColumnHeaderCell><Table.ColumnHeaderCell width="56px"><span className="sr-only">Actions</span></Table.ColumnHeaderCell></Table.Row></Table.Header>
                <Table.Body>{selected?.children?.slice(0, 60).map((child) => <Table.Row className="contents-row" key={child.path + child.name} onClick={(event) => { if (!(event.target as HTMLElement).closest('button')) void inspectNode(child) }}>
                  <Table.RowHeaderCell><Tooltip.Root><Tooltip.Trigger asChild><button className="contents-item" onClick={() => void inspectNode(child)}><FileKindIcon name={child.name} kind={child.kind}/><span className="file-info"><b>{child.name}</b><small>{child.kind}</small></span></button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="contents-name-tooltip" side="left" sideOffset={8}>{child.name}</Tooltip.Content></Tooltip.Portal></Tooltip.Root></Table.RowHeaderCell>
                  <Table.Cell className="file-size" justify="end">{formatSize(child.size)}</Table.Cell>
                  <Table.Cell><div className="contents-actions">{(child.kind === 'file' || child.kind === 'folder') && <button className="row-delete" disabled={deleting === child.path} aria-label={`Move ${child.name} to Trash`} title="Move to Trash" onClick={() => setPendingTrash(child)}>{deleting === child.path ? <LoaderCircle className="spin" size={15}/> : <Trash2 size={15}/>}</button>}</div></Table.Cell>
                </Table.Row>)}</Table.Body>
              </Table.Root>{!selected?.children?.length && <div className="empty-list">No mapped contents</div>}{selected && (selected.children?.length ?? 0) < (selected.childCount ?? 0) && <button className="load-more" onClick={() => void loadMoreChildren()}>Load more · {(selected.childCount! - (selected.children?.length ?? 0)).toLocaleString()} remaining</button>}</div>
            </Theme>
          </aside>
        </main> : <Duplicates
          rootPath={scan.root.path}
          result={duplicates}
          progress={duplicateProgress}
          analyzing={analyzingDuplicates}
          onAnalyze={() => void analyzeDuplicateFiles()}
          onCancel={() => { track('duplicate_analysis_cancelled'); void window.diskloom.cancelDuplicateAnalysis() }}
          onResultChange={setDuplicates}
          onMessage={(message, isError) => { isError ? setError(message) : setNotice(message) }}
          formatSize={formatSize}
        />}
      {error && <div className="error-toast" role="alert" aria-live="assertive" aria-atomic="true">{error}<button aria-label="Dismiss error" onClick={() => setError('')}><X size={16}/></button></div>}
      {notice && <div className="notice-toast" role="status" aria-live="polite" aria-atomic="true">{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={16}/></button></div>}
      {pendingTrash && <Modal backdropClassName="reclaim-result-backdrop" className="reclaim-result trash-confirm" labelledBy="trash-confirm-title" describedBy="trash-confirm-description" onClose={() => setPendingTrash(null)}><div className="reclaim-result-mark trash-confirm-mark"><Trash2 size={27}/></div><p className="eyebrow">CONFIRM DELETION</p><h2 id="trash-confirm-title">Move “{pendingTrash.name}” to Trash?</h2><p id="trash-confirm-description">This will remove {formatSize(pendingTrash.size)} from its current location. It can be recovered from the system Trash until the Trash is emptied.</p><small className="trash-confirm-path" title={pendingTrash.path}>{pendingTrash.path}</small><div className="reclaim-result-actions"><button className="secondary-btn" data-autofocus onClick={() => setPendingTrash(null)}>Cancel</button><button className="danger-btn" onClick={() => void trashNode(pendingTrash)}><Trash2 size={15}/> Move to Trash</button></div></Modal>}
      {telemetryPromptVisible && <aside className="telemetry-prompt" aria-label="Anonymous analytics choice"><div><b>Help improve Diskloom?</b><span>Share anonymous feature usage—never paths, filenames, or file contents.</span></div><button className="text-btn" onClick={() => chooseTelemetry(false)}>Don’t share</button><button className="primary-btn" onClick={() => chooseTelemetry(true)}>Allow analytics</button></aside>}
      {aboutDialogOpen && <Modal backdropClassName="telemetry-backdrop" className="telemetry-dialog about-dialog" labelledBy="about-title" describedBy="about-description" onClose={() => setAboutDialogOpen(false)}>
          <button className="telemetry-close" aria-label="Close about and privacy" onClick={() => setAboutDialogOpen(false)}><X size={17}/></button>
          <div className="about-brand"><img src={appIcon} alt=""/><div><p className="eyebrow">LOCAL-FIRST DISK UTILITY</p><h2 id="about-title">Diskloom</h2>{appInfo && <small>Version {appInfo.version}</small>}</div></div>
          <p id="about-description">A free, open-source disk space explorer. Scans, file details, duplicate comparisons, and benchmark results stay on this computer.</p>
          <div className="about-links"><a href="https://ko-fi.com/tylormayfield" target="_blank" rel="noreferrer">Support Diskloom ♡</a><a href="https://www.tylor.nz/legal" target="_blank" rel="noreferrer">Privacy &amp; Terms ↗</a><a href="https://github.com/TylorMayfield/diskloom/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT License ↗</a></div>
          <div className="privacy-settings"><div><b>Anonymous analytics</b><span>{telemetryEnabled === true ? 'Enabled' : telemetryEnabled === false ? 'Disabled' : 'Not enabled'}</span></div><p>Includes app version, platform, feature usage, and coarse timing. Never includes paths, filenames, file contents, hashes, drive names, or benchmark results.</p></div>
          <div className="telemetry-actions"><button className="secondary-btn" onClick={() => chooseTelemetry(false)}>Don’t share</button><button className="primary-btn" onClick={() => chooseTelemetry(true)}>Allow anonymous analytics</button></div>
      </Modal>}
    </div>
  </Tooltip.Provider>
}

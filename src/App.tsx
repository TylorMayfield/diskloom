import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { ChevronRight, FolderOpen, HardDrive, MoreHorizontal, Search, Trash2, X } from 'lucide-react'
import { Sunburst } from './Sunburst'
import { Duplicates } from './Duplicates'
import type { DiskNode, DuplicateAnalysisResult, DuplicateProgress, ScanResult } from './types'

const formatSize = (bytes: number) => {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toFixed(unit > 2 ? 2 : unit ? 1 : 0)} ${units[unit]}`
}
export function App() {
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [selected, setSelected] = useState<DiskNode | null>(null)
  const [chartRoot, setChartRoot] = useState<DiskNode | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ path: '', items: 0 })
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [view, setView] = useState<'map' | 'duplicates'>('map')
  const [duplicates, setDuplicates] = useState<DuplicateAnalysisResult | null>(null)
  const [duplicateProgress, setDuplicateProgress] = useState<DuplicateProgress | null>(null)
  const [analyzingDuplicates, setAnalyzingDuplicates] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => window.diskDaddy.onProgress(setProgress), [])
  useEffect(() => window.diskDaddy.onDuplicateProgress(setDuplicateProgress), [])

  const runScan = async (target?: string) => {
    try {
      const path = target ?? await window.diskDaddy.pickFolder()
      if (!path) return
      setBusy(true); setError(''); setProgress({ path, items: 0 })
      const result = await window.diskDaddy.scan(path)
      setScan(result); setSelected(result.root); setChartRoot(result.root)
      setDuplicates(null); setView('map'); setNotice('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The scan could not be completed.')
    } finally { setBusy(false) }
  }

  const crumbs = useMemo(() => {
    if (!scan || !chartRoot) return []
    const rel = chartRoot.path.slice(scan.root.path.length).split(/[\\/]/).filter(Boolean)
    const nodes: { name: string; path: string }[] = [{ name: scan.root.name, path: scan.root.path }]
    rel.forEach((part) => nodes.push({ name: part, path: `${nodes.at(-1)!.path}/${part}` }))
    return nodes
  }, [scan, chartRoot])

  const findNode = (node: DiskNode, path: string): DiskNode | null => {
    if (node.path === path) return node
    for (const child of node.children ?? []) { const found = findNode(child, path); if (found) return found }
    return null
  }

  const inspectNode = (node: DiskNode) => {
    setSelected(node)
    if (node.kind === 'folder' && node.children?.length) setChartRoot(node)
  }

  const navigateTo = (path: string) => {
    if (!scan) return
    const node = findNode(scan.root, path)
    if (node) { setSelected(node); setChartRoot(node) }
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
      await window.diskDaddy.trash(node.path)
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
      setDuplicates(await window.diskDaddy.analyzeDuplicates(scan.root.path))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Duplicate analysis failed.'
      if (!message.toLowerCase().includes('cancel')) setError(message)
    } finally { setAnalyzingDuplicates(false) }
  }

  return <Tooltip.Provider delayDuration={300}>
    <div className="app-shell">
      <header className="titlebar">
        <nav className="breadcrumbs">{crumbs.map((crumb, i) => <span key={crumb.path} className="crumb-wrap">{i > 0 && <ChevronRight size={14}/>}<button onClick={() => navigateTo(crumb.path)}>{crumb.name}</button></span>)}</nav>
        <div className="header-actions">
          <button className="primary-btn" onClick={() => void runScan()}><Search size={16}/> Scan folder</button>
        </div>
      </header>

      {busy ? <main className="loading-state"><div className="scanner-orbit"><HardDrive size={38}/></div><h1>Mapping your disk</h1><p>{progress.items.toLocaleString()} items inspected</p><div className="progress-path">{progress.path}</div></main>
      : !scan ? <main className="welcome">
          <div className="welcome-art"><div className="orb orb-a"/><div className="orb orb-b"/><div className="orb orb-c"/><HardDrive size={58}/></div>
          <h1>Find what’s filling<br/>your disk.</h1><p className="welcome-copy">A fast, private map of every folder. Nothing leaves your computer.</p>
          <button className="hero-btn" onClick={() => void runScan()}><FolderOpen size={20}/> Choose a folder to scan</button>
        </main>
      : <><div className="result-tabs"><button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>Disk Map</button><button className={view === 'duplicates' ? 'active' : ''} onClick={() => setView('duplicates')}>Duplicates{duplicates?.groups.length ? <span>{duplicates.groups.length}</span> : null}</button></div>{view === 'map' ? <main className="workspace">
          <section className="visual-panel"><Sunburst root={chartRoot ?? scan.root} selected={selected ?? scan.root} onSelect={inspectNode} formatSize={formatSize}/><div className="legend"><span><i className="dot folder-dot"/>Folders</span><span><i className="dot file-dot"/>Files</span><span>{scan.itemCount.toLocaleString()} items · {(scan.durationMs / 1000).toFixed(1)}s</span></div></section>
          <aside className="details-panel">
            <div className="details-heading"><div><p className="eyebrow">SELECTED ITEM</p><h2>{selected?.name}</h2></div><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-btn"><MoreHorizontal/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu" align="end"><DropdownMenu.Item onSelect={() => selected && void window.diskDaddy.openPath(selected.path)}>Open</DropdownMenu.Item><DropdownMenu.Item onSelect={() => selected && void window.diskDaddy.reveal(selected.path)}>Show in folder</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
            <p className="detail-path">{selected?.path}</p><div className="size-card"><span>Size on disk</span><strong>{formatSize(selected?.size ?? 0)}</strong><small>{chartRoot?.size ? ((selected?.size ?? 0) / chartRoot.size * 100).toFixed(1) : 0}% of current view</small></div>
            <div className="list-heading"><span>Contents</span><span>Size</span></div><div className="file-list">{selected?.children?.slice(0, 60).map((child) => <div className="file-row" key={child.path + child.name}><button className="file-row-main" onClick={() => inspectNode(child)}><span className={`file-icon ${child.kind}`}>{child.kind === 'folder' ? '◼' : '●'}</span><span className="file-info"><b>{child.name}</b><small>{child.kind}</small></span><span className="file-size">{formatSize(child.size)}</span><ChevronRight size={15}/></button>{(child.kind === 'file' || child.kind === 'folder') && <button className="row-delete" disabled={deleting === child.path} aria-label={`Move ${child.name} to Trash`} title="Move to Trash" onClick={() => void trashNode(child)}><Trash2 size={14}/></button>}</div>)}{!selected?.children?.length && <div className="empty-list">No mapped contents</div>}</div>
          </aside>
        </main> : <Duplicates rootPath={scan.root.path} result={duplicates} progress={duplicateProgress} analyzing={analyzingDuplicates} onAnalyze={() => void analyzeDuplicateFiles()} onCancel={() => void window.diskDaddy.cancelDuplicateAnalysis()} onResultChange={setDuplicates} onMessage={(message, isError) => { isError ? setError(message) : setNotice(message) }} formatSize={formatSize}/>}</>}
      {error && <div className="error-toast">{error}<button onClick={() => setError('')}><X size={16}/></button></div>}
      {notice && <div className="notice-toast">{notice}<button onClick={() => setNotice('')}><X size={16}/></button></div>}

    </div>
  </Tooltip.Provider>
}

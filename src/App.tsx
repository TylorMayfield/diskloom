import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { ChevronRight, FolderOpen, HardDrive, MoreHorizontal, Search, X } from 'lucide-react'
import { Sunburst } from './Sunburst'
import type { DiskNode, ScanResult } from './types'

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

  useEffect(() => window.diskDaddy.onProgress(setProgress), [])

  const runScan = async (target?: string) => {
    try {
      const path = target ?? await window.diskDaddy.pickFolder()
      if (!path) return
      setBusy(true); setError(''); setProgress({ path, items: 0 })
      const result = await window.diskDaddy.scan(path)
      setScan(result); setSelected(result.root); setChartRoot(result.root)
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
      : <main className="workspace">
          <section className="visual-panel"><Sunburst root={chartRoot ?? scan.root} selected={selected ?? scan.root} onSelect={inspectNode} formatSize={formatSize}/><div className="legend"><span><i className="dot folder-dot"/>Folders</span><span><i className="dot file-dot"/>Files</span><span>{scan.itemCount.toLocaleString()} items · {(scan.durationMs / 1000).toFixed(1)}s</span></div></section>
          <aside className="details-panel">
            <div className="details-heading"><div><p className="eyebrow">SELECTED ITEM</p><h2>{selected?.name}</h2></div><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-btn"><MoreHorizontal/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu" align="end"><DropdownMenu.Item onSelect={() => selected && void window.diskDaddy.openPath(selected.path)}>Open</DropdownMenu.Item><DropdownMenu.Item onSelect={() => selected && void window.diskDaddy.reveal(selected.path)}>Show in folder</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
            <p className="detail-path">{selected?.path}</p><div className="size-card"><span>Size on disk</span><strong>{formatSize(selected?.size ?? 0)}</strong><small>{chartRoot?.size ? ((selected?.size ?? 0) / chartRoot.size * 100).toFixed(1) : 0}% of current view</small></div>
            <div className="list-heading"><span>Contents</span><span>Size</span></div><div className="file-list">{selected?.children?.slice(0, 60).map((child) => <button className="file-row" key={child.path + child.name} onClick={() => inspectNode(child)}><span className={`file-icon ${child.kind}`}>{child.kind === 'folder' ? '◼' : '●'}</span><span className="file-info"><b>{child.name}</b><small>{child.kind}</small></span><span className="file-size">{formatSize(child.size)}</span><ChevronRight size={15}/></button>)}{!selected?.children?.length && <div className="empty-list">No mapped contents</div>}</div>
          </aside>
        </main>}
      {error && <div className="error-toast">{error}<button onClick={() => setError('')}><X size={16}/></button></div>}

    </div>
  </Tooltip.Provider>
}

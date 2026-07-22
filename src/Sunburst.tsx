import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Trash2 } from 'lucide-react'
import type { DiskNode } from './types'

const COLORS = ['#ffcc66', '#ff8266', '#ff5d9e', '#bd75ff', '#6f8cff', '#42c6d9', '#4fd19c', '#a5d65c']
const TAU = Math.PI * 2

type Segment = { node: DiskNode; start: number; end: number; depth: number; color: string; parentName: string; parentSize: number }

function point(cx: number, cy: number, r: number, angle: number) {
  return [cx + Math.cos(angle - Math.PI / 2) * r, cy + Math.sin(angle - Math.PI / 2) * r]
}

function arcPath(start: number, end: number, inner: number, outer: number) {
  const gap = Math.min(0.006, (end - start) / 5)
  start += gap; end -= gap
  const a = point(300, 300, outer, start), b = point(300, 300, outer, end)
  const c = point(300, 300, inner, end), d = point(300, 300, inner, start)
  const large = end - start > Math.PI ? 1 : 0
  return `M${a[0]},${a[1]} A${outer},${outer} 0 ${large} 1 ${b[0]},${b[1]} L${c[0]},${c[1]} A${inner},${inner} 0 ${large} 0 ${d[0]},${d[1]} Z`
}

function buildSegments(root: DiskNode): Segment[] {
  const result: Segment[] = []
  const visit = (node: DiskNode, start: number, end: number, depth: number, colorIndex: number) => {
    if (!node.children || depth > 3) return
    let cursor = start
    const total = node.children.reduce((sum, child) => sum + child.size, 0) || 1
    node.children.forEach((child, index) => {
      const childEnd = cursor + (end - start) * child.size / total
      if (childEnd - cursor > 0.002) {
        const color = COLORS[depth === 1 ? index % COLORS.length : colorIndex % COLORS.length]
        result.push({ node: child, start: cursor, end: childEnd, depth, color, parentName: node.name, parentSize: node.size })
        visit(child, cursor, childEnd, depth + 1, depth === 1 ? index : colorIndex)
      }
      cursor = childEnd
    })
  }
  visit(root, 0, TAU, 1, 0)
  return result
}

function percentOfParent(size: number, parentSize: number, accessible = false) {
  const percent = parentSize > 0 ? size / parentSize * 100 : 0
  if (percent > 0 && percent < 0.1) return accessible ? 'less than 0.1 percent' : '<0.1%'
  const value = (percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)).replace(/\.0$/, '')
  return accessible ? `${value} percent` : `${value}%`
}

type ChartMenu = { node: DiskNode; x: number; y: number }
type FocusTarget = 'chart' | 'list'

export function Sunburst({ root, selected, onSelect, onRequestTrash, formatSize }: { root: DiskNode; selected: DiskNode; onSelect(node: DiskNode): void; onRequestTrash(node: DiskNode): void; formatSize(n: number): string }) {
  const segments = useMemo(() => buildSegments(root), [root])
  const interactiveNodes = useMemo(() => [root, ...segments.map(({ node }) => node)], [root, segments])
  const [hovered, setHovered] = useState<DiskNode | null>(null)
  const [chartHasFocus, setChartHasFocus] = useState(false)
  const [focusedPath, setFocusedPath] = useState(selected.path)
  const [view, setView] = useState<'chart' | 'list'>('chart')
  const [menu, setMenu] = useState<ChartMenu | null>(null)
  const chartItemRefs = useRef(new Map<string, SVGElement>())
  const listItemRefs = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocus = useRef<FocusTarget | null>(null)
  const titleId = useId()
  const instructionsId = useId()
  const contentId = useId()
  const keyboardFocused = chartHasFocus ? interactiveNodes.find((node) => node.path === focusedPath) ?? null : null
  const focus = hovered ?? keyboardFocused ?? selected

  useEffect(() => {
    const nextPath = interactiveNodes.some((node) => node.path === selected.path) ? selected.path : root.path
    setFocusedPath(nextPath)
    const target = pendingFocus.current
    if (!target) return
    pendingFocus.current = null
    requestAnimationFrame(() => {
      if (target === 'chart') chartItemRefs.current.get(nextPath)?.focus()
      else listItemRefs.current.get(nextPath)?.focus()
    })
  }, [interactiveNodes, root.path, selected.path])

  useEffect(() => {
    if (view === 'list') {
      setChartHasFocus(false)
      setHovered(null)
    }
  }, [view])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menu])

  const accessibleLabel = (node: DiskNode, parentSize?: number, parentName?: string) => {
    const details = `${node.name}, ${node.kind}, ${formatSize(node.size)}`
    return parentSize === undefined ? `${details}, map root` : `${details}, ${percentOfParent(node.size, parentSize, true)} of parent ${parentName}`
  }

  const activateNode = (node: DiskNode, target: FocusTarget) => {
    pendingFocus.current = node.path === selected.path ? null : target
    onSelect(node)
  }

  const moveChartFocus = (event: ReactKeyboardEvent<SVGElement>, nextIndex: number) => {
    event.preventDefault()
    const boundedIndex = Math.min(Math.max(nextIndex, 0), interactiveNodes.length - 1)
    const nextPath = interactiveNodes[boundedIndex].path
    setFocusedPath(nextPath)
    chartItemRefs.current.get(nextPath)?.focus()
  }

  const handleChartKeyDown = (event: ReactKeyboardEvent<SVGElement>, node: DiskNode) => {
    const index = interactiveNodes.findIndex((item) => item.path === node.path)
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateNode(node, 'chart')
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      moveChartFocus(event, index === interactiveNodes.length - 1 ? 0 : index + 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      moveChartFocus(event, index <= 0 ? interactiveNodes.length - 1 : index - 1)
    } else if (event.key === 'Home') {
      moveChartFocus(event, 0)
    } else if (event.key === 'End') {
      moveChartFocus(event, interactiveNodes.length - 1)
    }
  }

  const openMenu = (event: ReactMouseEvent<SVGPathElement>, node: DiskNode) => {
    event.preventDefault(); event.stopPropagation()
    if (node.kind !== 'file' && node.kind !== 'folder') return
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect()
    const x = Math.min(Math.max(8, event.clientX - bounds.left), Math.max(8, bounds.width - 208))
    const y = Math.min(Math.max(8, event.clientY - bounds.top), Math.max(8, bounds.height - 92))
    setHovered(node); setMenu({ node, x, y })
  }

  const setChartItemRef = (path: string, element: SVGElement | null) => {
    if (element) chartItemRefs.current.set(path, element)
    else chartItemRefs.current.delete(path)
  }

  const setListItemRef = (path: string, element: HTMLButtonElement | null) => {
    if (element) listItemRefs.current.set(path, element)
    else listItemRefs.current.delete(path)
  }

  return <div className="sunburst-wrap">
    <div className="sunburst-view-toggle" role="group" aria-label="Disk map view">
      <button type="button" aria-pressed={view === 'chart'} aria-controls={contentId} onClick={() => setView('chart')}>Chart</button>
      <button type="button" aria-pressed={view === 'list'} aria-controls={contentId} onClick={() => setView('list')}>List</button>
    </div>
    {view === 'chart' ? <svg id={contentId} key={root.path} className="sunburst" viewBox="0 0 600 600" role="group" aria-labelledby={`${titleId} ${instructionsId}`}
      onFocusCapture={() => setChartHasFocus(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setChartHasFocus(false) }}>
      <title id={titleId}>Interactive disk map for {root.name}</title>
      <desc id={instructionsId}>Use the arrow keys to explore items. Press Enter or Space to inspect the focused item.</desc>
      <defs><filter id="glow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <circle ref={(element) => setChartItemRef(root.path, element)} cx="300" cy="300" r="116" role="button"
        tabIndex={focusedPath === root.path ? 0 : -1} aria-label={accessibleLabel(root)} aria-current={selected.path === root.path ? 'true' : undefined}
        className="chart-center" filter={focus.path === root.path ? 'url(#glow)' : undefined} onFocus={() => setFocusedPath(root.path)}
        onKeyDown={(event) => handleChartKeyDown(event, root)} onClick={() => activateNode(root, 'chart')} />
      {segments.map((segment) => {
        const active = focus.path === segment.node.path
        return <path key={`${segment.node.path}-${segment.depth}`} ref={(element) => setChartItemRef(segment.node.path, element)}
          d={arcPath(segment.start, segment.end, 78 + segment.depth * 54, 126 + segment.depth * 54)} role="button"
          tabIndex={focusedPath === segment.node.path ? 0 : -1} aria-label={accessibleLabel(segment.node, segment.parentSize, segment.parentName)}
          aria-current={selected.path === segment.node.path ? 'true' : undefined} fill={segment.color}
          opacity={active ? 1 : 0.72 - segment.depth * 0.045} className="segment" filter={active ? 'url(#glow)' : undefined}
          onFocus={() => setFocusedPath(segment.node.path)} onKeyDown={(event) => handleChartKeyDown(event, segment.node)}
          onMouseEnter={() => setHovered(segment.node)} onMouseLeave={() => setHovered(null)}
          onClick={() => activateNode(segment.node, 'chart')} onContextMenu={(event) => openMenu(event, segment.node)} />
      })}
      <g aria-hidden="true">
        <text aria-hidden="true" x="300" y="286" textAnchor="middle" className="center-size">{formatSize(focus.size)}</text>
        <text aria-hidden="true" x="300" y="316" textAnchor="middle" className="center-name">{focus.name}</text>
        <text aria-hidden="true" x="300" y="340" textAnchor="middle" className="center-hint">{hovered ? 'click to inspect' : chartHasFocus ? 'press Enter to inspect' : 'hover or use arrow keys'}</text>
      </g>
    </svg> : <section id={contentId} className="sunburst-list" aria-labelledby={`${titleId}-list`}>
      <div className="sunburst-list-heading"><p id={`${titleId}-list`}>Disk map hierarchy</p><span>Select an item to inspect it</span></div>
      <ul>{[{ node: root, depth: 0, color: COLORS[0], parentName: undefined, parentSize: undefined }, ...segments].map((item) => {
        const percent = item.parentSize === undefined ? 'Map root' : `${percentOfParent(item.node.size, item.parentSize)} of parent`
        return <li key={`${item.node.path}-${item.depth}`}>
          <button ref={(element) => setListItemRef(item.node.path, element)} type="button" className={selected.path === item.node.path ? 'is-selected' : ''}
            style={{ paddingInlineStart: `${13 + item.depth * 18}px` }} aria-label={accessibleLabel(item.node, item.parentSize, item.parentName)}
            aria-current={selected.path === item.node.path ? 'true' : undefined} onClick={() => activateNode(item.node, 'list')}>
            <i style={{ backgroundColor: item.color }} aria-hidden="true"/><span><b>{item.node.name}</b><small>{item.node.kind}</small></span>
            <span className="sunburst-list-percent">{percent}</span><strong>{formatSize(item.node.size)}</strong>
          </button>
        </li>
      })}</ul>
    </section>}
    {menu && <div className="chart-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}><span title={menu.node.path}>{menu.node.name}</span><button role="menuitem" onClick={() => { const node = menu.node; setMenu(null); onRequestTrash(node) }}><Trash2 size={14}/> Move to Trash</button></div>}
  </div>
}

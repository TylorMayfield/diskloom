import { useMemo, useState } from 'react'
import type { DiskNode } from './types'

const COLORS = ['#ffcc66', '#ff8266', '#ff5d9e', '#bd75ff', '#6f8cff', '#42c6d9', '#4fd19c', '#a5d65c']
const TAU = Math.PI * 2

type Segment = { node: DiskNode; start: number; end: number; depth: number; color: string }

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
        result.push({ node: child, start: cursor, end: childEnd, depth, color })
        visit(child, cursor, childEnd, depth + 1, depth === 1 ? index : colorIndex)
      }
      cursor = childEnd
    })
  }
  visit(root, 0, TAU, 1, 0)
  return result
}

export function Sunburst({ root, selected, onSelect, formatSize }: { root: DiskNode; selected: DiskNode; onSelect(node: DiskNode): void; formatSize(n: number): string }) {
  const segments = useMemo(() => buildSegments(root), [root])
  const [hovered, setHovered] = useState<DiskNode | null>(null)
  const focus = hovered ?? selected
  return <div className="sunburst-wrap">
    <svg key={root.path} className="sunburst" viewBox="0 0 600 600" role="img" aria-label={`Disk map for ${root.name}`}>
      <defs><filter id="glow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      {segments.map((segment) => {
        const active = focus.path === segment.node.path
        return <path key={`${segment.node.path}-${segment.depth}`} d={arcPath(segment.start, segment.end, 78 + segment.depth * 54, 126 + segment.depth * 54)}
          fill={segment.color} opacity={active ? 1 : 0.72 - segment.depth * 0.045} className="segment"
          filter={active ? 'url(#glow)' : undefined} onMouseEnter={() => setHovered(segment.node)} onMouseLeave={() => setHovered(null)}
          onClick={() => onSelect(segment.node)} />
      })}
      <circle cx="300" cy="300" r="116" className="chart-center" onClick={() => onSelect(root)} />
      <text x="300" y="286" textAnchor="middle" className="center-size">{formatSize(focus.size)}</text>
      <text x="300" y="316" textAnchor="middle" className="center-name">{focus.name}</text>
      <text x="300" y="340" textAnchor="middle" className="center-hint">{hovered ? 'click to inspect' : 'hover to explore'}</text>
    </svg>
  </div>
}

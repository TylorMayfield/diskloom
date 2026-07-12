import { useEffect, useState } from 'react'
import { Check, Copy, Gauge, Info, Play, RotateCw, Square } from 'lucide-react'
import { Badge, Button, Card, Heading, Progress, Select, Text, Theme } from '@radix-ui/themes'
import * as Tooltip from '@radix-ui/react-tooltip'
import type { BenchmarkDrive, BenchmarkProgress, BenchmarkReport } from './types'

export function Benchmark({ target: initialTarget, onError }: { target?: string; onError: (message: string) => void }) {
  const [target, setTarget] = useState(initialTarget ?? '')
  const [drives, setDrives] = useState<BenchmarkDrive[]>([])
  const [loadingDrives, setLoadingDrives] = useState(true)
  const [totalMemoryBytes, setTotalMemoryBytes] = useState(0)
  const [runs, setRuns] = useState(3)
  const [sizeMiB, setSizeMiB] = useState(128)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null)
  const [report, setReport] = useState<BenchmarkReport | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => window.diskloom.onBenchmarkProgress(setProgress), [])
  const loadDrives = async () => {
    try {
      setLoadingDrives(true)
      if (typeof window.diskloom.listBenchmarkDrives !== 'function') {
        throw new Error('Drive detection was updated. Fully quit and reopen Diskloom to activate it.')
      }
      const available = await window.diskloom.listBenchmarkDrives()
      setDrives(available)
      setTarget((current) => available.find((drive) => drive.mountPoint === current)?.mountPoint ?? available.find((drive) => !drive.readOnly)?.mountPoint ?? '')
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Could not detect available drives.') }
    finally { setLoadingDrives(false) }
  }
  useEffect(() => { void loadDrives() }, [])
  useEffect(() => {
    if (typeof window.diskloom.getSystemMemory === 'function') void window.diskloom.getSystemMemory().then(setTotalMemoryBytes).catch(() => undefined)
  }, [])

  const start = async () => {
    if (!target) return
    try {
      setRunning(true); setReport(null); setProgress({ completed: 0, total: (runs + 1) * 8, current: 'Preparing isolated workload files' })
      setReport(await window.diskloom.runBenchmark({ target, runs, sizeMiB }))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Benchmark failed.'
      if (!message.toLowerCase().includes('cancel')) onError(message)
    } finally { setRunning(false) }
  }

  const progressValue = progress ? progress.completed / progress.total * 100 : report ? 100 : 0
  const selectedDrive = drives.find((drive) => drive.mountPoint === target)
  const formatCapacity = (bytes: number) => bytes >= 1024 ** 4 ? `${(bytes / 1024 ** 4).toFixed(1)} TB` : `${Math.round(bytes / 1024 ** 3)} GB`
  const cacheLikely = totalMemoryBytes > 0 && sizeMiB * 1024 ** 2 <= totalMemoryBytes
  const insufficientSpace = Boolean(selectedDrive && sizeMiB * 1024 ** 2 > selectedDrive.freeBytes * .9)
  const testHelp: Record<string, string> = {
    'seq1m-q8': 'Large-file transfers with eight requests in flight. Shows peak sequential throughput for fast SSDs.',
    'seq1m-q1': 'Large-file transfers one request at a time. Closer to common copies, exports, and media workloads.',
    'rnd4k-q32': 'Small scattered files with 32 requests in flight. Shows performance under heavy multitasking and application load.',
    'rnd4k-q1': 'Small scattered files one request at a time. A useful indicator of everyday app responsiveness and startup speed.',
  }
  const copyResults = async () => {
    if (!report) return
    const rows = report.results.map((result) => `| ${result.label} ${result.detail} | ${result.read.toFixed(2)} | ±${result.readVariation.toFixed(1)}% | ${result.write.toFixed(2)} | ±${result.writeVariation.toFixed(1)}% | ${result.readIops ? Math.round(result.readIops).toLocaleString('en-US') : '—'} | ${result.writeIops ? Math.round(result.writeIops).toLocaleString('en-US') : '—'} |`)
    const markdown = [`| Test | Read (MB/s) | Read variability | Write (MB/s) | Write variability | Read IOPS | Write IOPS |`, `|---|---:|---:|---:|---:|---:|---:|`, ...rows].join('\n')
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true); window.setTimeout(() => setCopied(false), 1800)
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Could not copy benchmark results.') }
  }

  return <main className="benchmark-view">
    <Theme className="benchmark-theme" appearance="dark" accentColor="amber" grayColor="slate" radius="large" scaling="90%" hasBackground={false}>
    <Card className="benchmark-card" size="4">
      <div className="benchmark-head">
        <div><Badge className="benchmark-kicker" variant="soft" color="amber"><Gauge size={12}/> DISK BENCHMARK</Badge><Heading as="h2" size="7">System performance</Heading><Text as="p" size="1" color="gray" title={target}>{selectedDrive ? `${selectedDrive.mountPoint} · ${formatCapacity(selectedDrive.freeBytes)} free of ${formatCapacity(selectedDrive.totalBytes)}` : 'Select a drive to begin'}</Text></div>
        <div className="benchmark-controls">
          <label>Drive<Select.Root value={target} disabled={running || loadingDrives || !drives.length} onValueChange={(value) => { setTarget(value); setReport(null) }}><Select.Trigger className="benchmark-drive-select" placeholder={loadingDrives ? 'Detecting drives…' : 'No writable drives'}/><Select.Content position="popper">{drives.map((drive) => <Select.Item key={drive.id} value={drive.mountPoint} disabled={drive.readOnly}>{drive.name} ({drive.mountPoint}) · {formatCapacity(drive.totalBytes)}{drive.readOnly ? ' · Read only' : ''}</Select.Item>)}</Select.Content></Select.Root></label>
          <Button className="benchmark-refresh" size="2" variant="soft" color="gray" disabled={running || loadingDrives} aria-label="Refresh drives" title="Refresh drives" onClick={() => void loadDrives()}><RotateCw size={14} className={loadingDrives ? 'spin' : ''}/></Button>
          <label>Runs<Select.Root value={String(runs)} disabled={running} onValueChange={(value) => setRuns(Number(value))}><Select.Trigger className="benchmark-select"/><Select.Content position="popper"><Select.Item value="1">1</Select.Item><Select.Item value="3">3</Select.Item><Select.Item value="5">5</Select.Item></Select.Content></Select.Root></label>
          <label>Test size<Select.Root value={String(sizeMiB)} disabled={running} onValueChange={(value) => setSizeMiB(Number(value))}><Select.Trigger className="benchmark-select"/><Select.Content position="popper"><Select.Item value="64">64 MiB</Select.Item><Select.Item value="128">128 MiB</Select.Item><Select.Item value="256">256 MiB</Select.Item><Select.Item value="512">512 MiB</Select.Item><Select.Item value="1024">1 GiB</Select.Item><Select.Item value="5120">5 GiB</Select.Item><Select.Item value="8192">8 GiB</Select.Item><Select.Item value="16384">16 GiB</Select.Item><Select.Item value="32768">32 GiB</Select.Item><Select.Item value="65536">64 GiB</Select.Item></Select.Content></Select.Root></label>
          {report && !running && <Button className="benchmark-copy" size="2" variant="soft" color={copied ? 'green' : 'gray'} onClick={() => void copyResults()}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? 'Copied' : 'Copy'}</Button>}
          {running ? <Button className="benchmark-stop" size="2" variant="soft" color="red" onClick={() => void window.diskloom.cancelBenchmark()}><Square size={13}/> Stop</Button> : <Button className="benchmark-run" size="2" variant="solid" highContrast disabled={!target || selectedDrive?.readOnly || insufficientSpace} title={insufficientSpace ? 'Not enough free space for this test size' : undefined} onClick={() => void start()}><Play size={14} fill="currentColor"/> Run all</Button>}
        </div>
      </div>
      <div className="benchmark-progress"><Progress value={progressValue} size="1"/><Text as="span" size="1" color="gray">{running ? progress?.current : report ? `Completed ${new Date(report.completedAt).toLocaleTimeString()}` : 'Ready to test'}</Text></div>
      <div className="benchmark-grid benchmark-labels"><span>Test</span><b>READ <small>MB/s</small></b><b>WRITE <small>MB/s</small></b></div>
      {(report?.results ?? [
        { id: 'seq1m-q8', label: 'SEQ1M', detail: 'Q8T1', read: 0, write: 0, readVariation: 0, writeVariation: 0 },
        { id: 'seq1m-q1', label: 'SEQ1M', detail: 'Q1T1', read: 0, write: 0, readVariation: 0, writeVariation: 0 },
        { id: 'rnd4k-q32', label: 'RND4K', detail: 'Q32T1', read: 0, write: 0, readVariation: 0, writeVariation: 0 },
        { id: 'rnd4k-q1', label: 'RND4K', detail: 'Q1T1', read: 0, write: 0, readVariation: 0, writeVariation: 0 },
      ]).map((result) => <div className="benchmark-grid benchmark-row" key={result.id}>
        <div><strong>{result.label}<Tooltip.Root><Tooltip.Trigger asChild><button className="benchmark-info" aria-label={`About ${result.label} ${result.detail}`}><Info size={12}/></button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="benchmark-tooltip" side="right" sideOffset={8}>{testHelp[result.id]}<Tooltip.Arrow className="benchmark-tooltip-arrow"/></Tooltip.Content></Tooltip.Portal></Tooltip.Root></strong><span>{result.detail}</span></div>
        <div className="speed read"><strong>{result.read ? result.read.toFixed(2) : '—'}</strong>{result.read ? <span>{result.readIops ? `${Math.round(result.readIops).toLocaleString()} IOPS · ` : ''}±{result.readVariation.toFixed(1)}%</span> : null}</div>
        <div className="speed write"><strong>{result.write ? result.write.toFixed(2) : '—'}</strong>{result.write ? <span>{result.writeIops ? `${Math.round(result.writeIops).toLocaleString()} IOPS · ` : ''}±{result.writeVariation.toFixed(1)}%</span> : null}</div>
      </div>)}
      <Text as="p" size="1" color={cacheLikely || insufficientSpace ? 'amber' : 'gray'} className="benchmark-note">{insufficientSpace ? `The selected drive does not have enough free space for a ${sizeMiB / 1024} GiB test. ` : cacheLikely ? `This system has ${formatCapacity(totalMemoryBytes)} of memory. For fewer cache hits, use a test file larger than available memory; the selected ${sizeMiB >= 1024 ? `${sizeMiB / 1024} GiB` : `${sizeMiB} MiB`} test can still be cached. ` : ''}Results are medians; ± shows median variability across measured runs. Workloads use separate files, randomized order, an excluded warm-up pass, and reopened read handles.</Text>
    </Card>
    </Theme>
  </main>
}

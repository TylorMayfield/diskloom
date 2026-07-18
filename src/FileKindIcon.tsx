import { Database, File, FileArchive, FileAudio, FileCode2, FileImage, FileSpreadsheet, FileText, FileVideo, Folder } from 'lucide-react'

const extension = (name: string) => name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''

const groups = {
  image: new Set(['avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']),
  video: new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm']),
  audio: new Set(['aac', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'wav']),
  archive: new Set(['7z', 'bz2', 'dmg', 'gz', 'iso', 'rar', 'tar', 'xz', 'zip']),
  code: new Set(['c', 'cpp', 'css', 'go', 'h', 'html', 'java', 'js', 'json', 'jsx', 'kt', 'py', 'rs', 'sh', 'swift', 'toml', 'ts', 'tsx', 'xml', 'yaml', 'yml']),
  spreadsheet: new Set(['csv', 'numbers', 'ods', 'xls', 'xlsx']),
  database: new Set(['db', 'sqlite', 'sqlite3', 'sql']),
  text: new Set(['doc', 'docx', 'log', 'md', 'odt', 'pdf', 'rtf', 'txt']),
}

export function FileKindIcon({ name, kind, size = 17 }: { name: string; kind: 'folder' | 'file' | 'other'; size?: number }) {
  if (kind === 'folder') return <span className="file-kind-icon folder"><Folder size={size}/></span>
  const ext = extension(name)
  if (groups.image.has(ext)) return <span className="file-kind-icon image"><FileImage size={size}/></span>
  if (groups.video.has(ext)) return <span className="file-kind-icon video"><FileVideo size={size}/></span>
  if (groups.audio.has(ext)) return <span className="file-kind-icon audio"><FileAudio size={size}/></span>
  if (groups.archive.has(ext)) return <span className="file-kind-icon archive"><FileArchive size={size}/></span>
  if (groups.code.has(ext)) return <span className="file-kind-icon code"><FileCode2 size={size}/></span>
  if (groups.spreadsheet.has(ext)) return <span className="file-kind-icon spreadsheet"><FileSpreadsheet size={size}/></span>
  if (groups.database.has(ext)) return <span className="file-kind-icon database"><Database size={size}/></span>
  if (groups.text.has(ext)) return <span className="file-kind-icon text"><FileText size={size}/></span>
  return <span className="file-kind-icon file"><File size={size}/></span>
}

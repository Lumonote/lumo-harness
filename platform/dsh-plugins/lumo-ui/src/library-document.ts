import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'

export interface LibraryFileInfo {
  docId: string; realm: string; folderId: string | null; filename: string; mimeType: string
  objectKey: string; byteSize: number; sha256: string; ownerUserId: string
  extractionState: 'pending' | 'ready' | 'failed' | 'unsupported'
  ocrState: 'not_needed' | 'pending' | 'ready' | 'failed' | 'unavailable'; createdAt: string
  revision?: number; canEdit?: boolean
}

const executeFile = promisify(execFile)
export const LIBRARY_UPLOAD_LIMIT = 50 * 1024 * 1024
const OFFICE_TEXT_EXTRACTOR = String.raw`
import sys, zipfile, xml.etree.ElementTree as ET
path = sys.argv[1]
with zipfile.ZipFile(path) as archive:
    infos = archive.infolist()
    if len(infos) > 1000 or sum(item.file_size for item in infos) > 80 * 1024 * 1024:
        raise ValueError('office archive expands beyond the extraction limit')
    names = set(archive.namelist())
    def texts(name):
        root = ET.fromstring(archive.read(name))
        return [item.text or '' for item in root.iter() if item.tag.rsplit('}', 1)[-1] in ('t', 'v')]
    if 'word/document.xml' in names:
        selected = ['word/document.xml']
    elif 'ppt/presentation.xml' in names:
        selected = sorted((n for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml')), key=lambda n: int(''.join(c for c in n.rsplit('slide',1)[-1][:-4] if c.isdigit()) or '0'))
    elif 'xl/workbook.xml' in names:
        selected = sorted(n for n in names if n.startswith('xl/worksheets/sheet') and n.endswith('.xml'))
        shared = texts('xl/sharedStrings.xml') if 'xl/sharedStrings.xml' in names else []
        values = []
        for name in selected:
            root = ET.fromstring(archive.read(name))
            for row in root.iter():
                if row.tag.rsplit('}', 1)[-1] != 'row': continue
                cells = []
                for cell in list(row):
                    if cell.tag.rsplit('}', 1)[-1] != 'c': continue
                    kind = cell.attrib.get('t')
                    value = next((child.text or '' for child in list(cell) if child.tag.rsplit('}', 1)[-1] in ('v','t')), '')
                    if kind == 's' and value.isdigit() and int(value) < len(shared): value = shared[int(value)]
                    cells.append(value)
                if cells: values.append('\t'.join(cells))
        print('\n'.join(values))
        raise SystemExit(0)
    else:
        raise ValueError('unsupported Office document')
    output = []
    for name in selected:
        output.extend(texts(name))
    print('\n'.join(value for value in output if value))
`

export function safeUploadFilename(value: string | undefined): string {
  if (value === undefined || value.length > 1024) throw new TypeError('请提供有效的文件名')
  let decoded = value
  try { decoded = decodeURIComponent(value) } catch { throw new TypeError('文件名编码无效') }
  const filename = basename(decoded.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  if (filename === '' || Buffer.byteLength(filename, 'utf8') > 240 || filename === '.' || filename === '..') throw new TypeError('文件名无效')
  return filename
}

export function libraryMimeType(filename: string): string | undefined {
  const ext = extname(filename).toLowerCase()
  const known: Record<string, string> = {
    '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return known[ext]
}

async function runDocumentCommand(command: string, args: string[], timeout: number, maxBuffer = 5 * 1024 * 1024): Promise<string> {
  const result = await executeFile(command, args, { timeout, maxBuffer, encoding: 'utf8' })
  return result.stdout
}

export async function extractLibraryText(filename: string, mimeType: string, body: Buffer): Promise<{
  text: string; extractionState: LibraryFileInfo['extractionState']; ocrState: LibraryFileInfo['ocrState']
}> {
  const ext = extname(filename).toLowerCase()
  if (['.txt', '.log', '.md', '.markdown', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml'].includes(ext)) {
    const text = body.toString('utf8').replace(/^\uFEFF/u, '').trim()
    return text ? { text, extractionState: 'ready', ocrState: 'not_needed' } : { text: '', extractionState: 'failed', ocrState: 'not_needed' }
  }

  const directory = await mkdtemp(join(tmpdir(), 'lumo-library-'))
  const inputPath = join(directory, `document${ext || '.bin'}`)
  try {
    await writeFile(inputPath, body, { mode: 0o600 })
    if (mimeType === 'application/pdf') {
      let text = ''
      try { text = (await runDocumentCommand('pdftotext', ['-layout', '-enc', 'UTF-8', inputPath, '-'], 30_000)).trim() }
      catch { /* 扫描版/无可提取文本时继续尝试 OCR */ }
      if (text.length >= 20) return { text, extractionState: 'ready', ocrState: 'not_needed' }
      const prefix = join(directory, 'page')
      try {
        await runDocumentCommand('pdftoppm', ['-f', '1', '-l', '20', '-scale-to', '2200', '-jpeg', inputPath, prefix], 60_000, 2 * 1024 * 1024)
        const pages = (await readdir(directory)).filter(name => /^page-\d+\.jpg$/u.test(name)).sort((left, right) => Number(left.match(/\d+/u)?.[0]) - Number(right.match(/\d+/u)?.[0]))
        if (pages.length === 0) return { text: '', extractionState: 'failed', ocrState: 'failed' }
        const recognized: string[] = []
        for (const page of pages) recognized.push((await runDocumentCommand('tesseract', [join(directory, page), 'stdout', '-l', 'chi_sim+eng', '--psm', '3'], 60_000, 2 * 1024 * 1024)).trim())
        const scannedText = recognized.filter(Boolean).join('\n\n').trim()
        return scannedText ? { text: scannedText, extractionState: 'ready', ocrState: 'ready' } : { text: '', extractionState: 'failed', ocrState: 'failed' }
      } catch (error) {
        return { text: '', extractionState: 'failed', ocrState: isMissingExecutable(error) ? 'unavailable' : 'failed' }
      }
    }
    if (mimeType.startsWith('image/')) {
      try {
        const text = (await runDocumentCommand('tesseract', [inputPath, 'stdout', '-l', 'chi_sim+eng', '--psm', '3'], 60_000, 4 * 1024 * 1024)).trim()
        return text ? { text, extractionState: 'ready', ocrState: 'ready' } : { text: '', extractionState: 'failed', ocrState: 'failed' }
      } catch (error) {
        return { text: '', extractionState: 'failed', ocrState: isMissingExecutable(error) ? 'unavailable' : 'failed' }
      }
    }
    if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
      try {
        const text = (await runDocumentCommand('python3', ['-c', OFFICE_TEXT_EXTRACTOR, inputPath], 30_000)).trim()
        return text ? { text, extractionState: 'ready', ocrState: 'not_needed' } : { text: '', extractionState: 'failed', ocrState: 'not_needed' }
      } catch {
        return { text: '', extractionState: 'failed', ocrState: 'not_needed' }
      }
    }
    return { text: '', extractionState: 'unsupported', ocrState: 'not_needed' }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

export function documentChunks(text: string, filename: string, mimeType: string, entities: string[] = []): Array<{ text: string; metadata: Record<string, unknown> }> {
  const maxChars = 5_000
  const blocks = text.replaceAll('\r\n', '\n').split(/\n{2,}|\f/u).map(part => part.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const block of blocks) {
    let remaining = block
    while (remaining.length > maxChars) {
      if (current) { chunks.push(current); current = '' }
      chunks.push(remaining.slice(0, maxChars))
      remaining = remaining.slice(maxChars)
    }
    if (current.length + remaining.length + 2 > maxChars && current) { chunks.push(current); current = '' }
    current = current ? `${current}\n\n${remaining}` : remaining
  }
  if (current) chunks.push(current)
  if (chunks.length > 500) throw new RangeError('文件提取文本过长，当前单文件索引上限为 250 万字符')
  return chunks.map((chunk, index) => ({ text: chunk, metadata: { filename, mimeType, chunkIndex: index, libraryFile: true, ...(entities.length === 0 ? {} : { entities }) } }))
}

export function publicLibraryFile(file: LibraryFileInfo): Omit<LibraryFileInfo, 'objectKey'> {
  return {
    docId: file.docId, realm: file.realm, folderId: file.folderId, filename: file.filename, mimeType: file.mimeType,
    byteSize: file.byteSize, ownerUserId: file.ownerUserId, extractionState: file.extractionState, ocrState: file.ocrState,
    createdAt: file.createdAt, sha256: file.sha256,
    ...(file.revision === undefined ? {} : { revision: file.revision }),
    ...(file.canEdit === undefined ? {} : { canEdit: file.canEdit }),
  }
}

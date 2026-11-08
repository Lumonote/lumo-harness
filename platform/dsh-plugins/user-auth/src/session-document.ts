import { spawn } from 'node:child_process'
import { extname } from 'node:path'
import { SessionRequestError } from './session-request-errors.ts'
import { SESSION_ATTACHMENT_DOCUMENT_TYPES } from '../../../shared/seam-contracts/session-attachments.ts'

export const DOCUMENT_MEDIA_TYPES = Object.fromEntries(Object.entries(SESSION_ATTACHMENT_DOCUMENT_TYPES).map(([extension, media]) => [media, extension])) as Record<string, string>
export const DOCUMENT_PREVIEW_MAX_CHARS = 200_000
let activeParsers = 0
export interface DocumentPreview {
  text: string
  format: 'pdf' | 'docx' | 'xlsx' | 'pptx'
  scope: 'bounded-text-preview'
  document_complete: false
  truncated: boolean
  units_read: number
  total_units: number
  warnings: string[]
}
export function isDocumentMediaType(value: string): boolean {
  return Object.hasOwn(DOCUMENT_MEDIA_TYPES, value)
}
/** The caller supplies verified immutable bytes, never a path, URL or command. */
export function validateDocumentEnvelope(name: string, mediaType: string, bytes: Uint8Array): void {
  if (!isDocumentMediaType(mediaType) || extname(name).toLowerCase() !== DOCUMENT_MEDIA_TYPES[mediaType]) {
    throw new SessionRequestError('session_attachment_unsupported')
  }
  const signature = Buffer.from(bytes.subarray(0, 5))
  if (mediaType === 'application/pdf' ? signature.toString('ascii') !== '%PDF-'
    : signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 3 || signature[3] !== 4) {
    throw new SessionRequestError('session_attachment_unsupported')
  }
}

// Reuse the provisioned PPT Python runtime (PyMuPDF + standard library). The
// fixed program only reads stdin. No archive is extracted or external link read.
const extractor = String.raw`
import io, json, os, posixpath, re, sys, zipfile
import xml.etree.ElementTree as ET
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    if sys.platform.startswith('linux'):
        resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024, 512*1024*1024))
except (ImportError, OSError, ValueError):
    pass

MAX_INPUT = 8*1024*1024
MAX_CHARS = 200000
MAX_UNITS = 100
mime = sys.argv[1]
data = sys.stdin.buffer.read(MAX_INPUT + 1)
if not data or len(data) > MAX_INPUT:
    raise ValueError('input bound')
values = []
length = 0
clipped = False
def add(value):
    global length, clipped
    if not value:
        return True
    # Preserve printable text without allowing document terminal controls.
    value = ''.join(c for c in value if c in '\n\r\t' or ord(c) >= 32 and ord(c) != 127)
    remaining = MAX_CHARS - length
    encoded = value.encode('utf-16-le')
    units = len(encoded) // 2
    if units + 1 > remaining:
        # Match the JavaScript pagination bound without splitting an astral
        # Unicode scalar at the preview boundary.
        values.append(encoded[:max(0, remaining)*2].decode('utf-16-le', errors='ignore'))
        length = MAX_CHARS
        clipped = True
        return False
    values.append(value)
    length += units + 1
    return True

if mime == 'application/pdf':
    try:
        import fitz
    except ImportError:
        sys.stderr.write('LUMO_DOCUMENT_DEPENDENCY_UNAVAILABLE')
        sys.exit(69)
    if not data.startswith(b'%PDF-') or b'%%EOF' not in data[-4096:]:
        raise ValueError('incomplete PDF')
    doc = fitz.open(stream=data, filetype='pdf')
    try:
        if not doc.is_pdf or doc.needs_pass or doc.page_count < 1:
            raise ValueError('encrypted or empty PDF')
        total = doc.page_count
        read = 0
        for page in doc.pages(0, min(total, MAX_UNITS)):
            read += 1
            if not add(page.get_text('text', sort=True)):
                break
    finally:
        doc.close()
    fmt = 'pdf'
    warnings = ['Text layer only; images, scanned pages, annotations and visual layout are not certified. No OCR was performed.']
else:
    fmt = {'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
           'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'}.get(mime)
    if fmt is None or not data.startswith(b'PK\x03\x04'):
        raise ValueError('unsupported archive')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > 512:
            raise ValueError('archive entry count')
        names = set()
        expanded = 0
        parts = {}
        for entry in entries:
            name = entry.filename
            if name in names or name.startswith(('/', '\\')) or '\\' in name or '..' in name.split('/') or '\x00' in name:
                raise ValueError('unsafe archive path')
            names.add(name)
            if entry.flag_bits & 1 or (entry.external_attr >> 16) & 0o170000 == 0o120000 or entry.compress_type not in (0, 8):
                raise ValueError('encrypted, linked or unsupported archive entry')
            expanded += entry.file_size
            if entry.file_size > 4*1024*1024 or expanded > 32*1024*1024 or entry.file_size > max(1, entry.compress_size)*200:
                raise ValueError('archive expansion bound')
            if entry.is_dir():
                continue
            with archive.open(entry) as stream:
                payload = stream.read(4*1024*1024+1)
            if len(payload) != entry.file_size:
                raise ValueError('archive member bound')
            if name.endswith(('.xml', '.rels')):
                if re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', payload, re.I):
                    raise ValueError('XML entity declarations are not allowed')
                parts[name] = payload
        expected = {'docx': 'word/document.xml', 'xlsx': 'xl/workbook.xml', 'pptx': 'ppt/presentation.xml'}[fmt]
        if expected not in parts or '[Content_Types].xml' not in parts or '_rels/.rels' not in parts:
            raise ValueError('Office package mismatch')
        content_type = {'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
                        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
                        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'}[fmt]
        class RejectDoctype(ET.TreeBuilder):
            def doctype(self, name, public_id, system_id):
                raise ValueError('XML DTD declarations are not allowed')
        def safe_xml(payload):
            # Parser callbacks also cover UTF-16/XML-declared encodings, which
            # a byte-pattern check alone cannot safely inspect.
            return ET.fromstring(payload, parser=ET.XMLParser(target=RejectDoctype()))
        types = safe_xml(parts['[Content_Types].xml'])
        if not any(item.attrib.get('PartName') == '/' + expected and item.attrib.get('ContentType') == content_type for item in types):
            raise ValueError('Office content type mismatch')
        def local(item):
            return item.tag.rsplit('}', 1)[-1]
        def xml(name):
            return safe_xml(parts[name])
        def texts(item):
            return ''.join((node.text or '') for node in item.iter() if local(node) == 't')
        def ordered_parts(container, element, relationship_type):
            # Package filenames and ZIP order are implementation details. Only
            # the document's ordered relationship references select its units;
            # stale or unreferenced worksheets/slides must not become content.
            rels_name = posixpath.join(posixpath.dirname(expected), '_rels', posixpath.basename(expected) + '.rels')
            if rels_name not in parts:
                raise ValueError('missing document relationships')
            relationships = {}
            for relation in xml(rels_name):
                identifier = relation.attrib.get('Id', '')
                if not identifier or identifier in relationships:
                    raise ValueError('duplicate or missing relationship ID')
                relationships[identifier] = relation.attrib
            selected = []
            seen = set()
            for item in container.iter():
                if local(item) != element:
                    continue
                identifier = item.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id', '')
                relation = relationships.get(identifier, {})
                target = relation.get('Target', '')
                if relation.get('Type') != 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + relationship_type or relation.get('TargetMode', 'Internal') != 'Internal' or not target or '\\' in target or ':' in target or '#' in target or '?' in target:
                    raise ValueError('invalid document relationship')
                resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(expected), target))
                if resolved.startswith('../') or resolved not in parts or resolved in seen:
                    raise ValueError('missing or duplicate document part')
                seen.add(resolved)
                selected.append(resolved)
            return selected
        if fmt == 'docx':
            paragraphs = [node for node in xml(expected).iter() if local(node) == 'p']
            total = len(paragraphs)
            read = 0
            # Paragraphs are units, not pages. Headers, comments and objects are
            # outside the body-text preview and never claimed as full content.
            for paragraph in paragraphs[:MAX_UNITS]:
                read += 1
                if not add(texts(paragraph)):
                    break
            warnings = ['Document body paragraphs only; headers, footnotes, comments, images and embedded objects are omitted.']
        elif fmt == 'pptx':
            slides = ordered_parts(xml(expected), 'sldId', 'slide')
            total = len(slides)
            read = 0
            for name in slides[:MAX_UNITS]:
                read += 1
                if not add(texts(xml(name))):
                    break
            warnings = ['Slide text only; notes, charts, images, embedded objects and visual layout are omitted.']
        else:
            sheets = ordered_parts(xml(expected), 'sheet', 'worksheet')
            shared = []
            if 'xl/sharedStrings.xml' in parts:
                shared = [texts(item) for item in xml('xl/sharedStrings.xml') if local(item) == 'si']
            read = 0
            total = 0
            for sheet_index, name in enumerate(sheets):
                rows = [node for node in xml(name).iter() if local(node) == 'row']
                total += len(rows)
                for row in rows:
                    if sheet_index >= MAX_UNITS or read >= 1000 or clipped:
                        clipped = True
                        continue
                    cells = []
                    for cell in row:
                        if local(cell) != 'c':
                            continue
                        kind = cell.attrib.get('t', '')
                        value = next((child.text or '' for child in cell if local(child) == 'v'), '')
                        if kind == 's':
                            if not value.isdigit() or int(value) >= len(shared):
                                raise ValueError('invalid shared string')
                            value = shared[int(value)]
                        elif kind == 'inlineStr':
                            value = texts(cell)
                        cells.append(value)
                    read += 1
                    if not add('\t'.join(cells)):
                        clipped = True
            warnings = ['Stored cell values only; formulas are not evaluated, cached values may be stale, charts, images and formatting are omitted.']
        if total < 1:
            raise ValueError('no readable document units')

text = '\n'.join(values)[:MAX_CHARS]
if not text.strip():
    warnings.append('No extractable text was found. This is not evidence that the source document is empty.')
print(json.dumps({'text': text, 'format': fmt, 'scope': 'bounded-text-preview', 'document_complete': False,
                  'truncated': clipped or read < total, 'units_read': read, 'total_units': total, 'warnings': warnings}, ensure_ascii=True))
`

/** A separate, time-limited parser process keeps untrusted document work away
 * from the session event loop. The interpreter is deployment-owned configuration. */
export async function extractDocumentPreview(name: string, mediaType: string, bytes: Uint8Array, signal: AbortSignal): Promise<DocumentPreview> {
  validateDocumentEnvelope(name, mediaType, bytes)
  if (bytes.length > 8 * 1024 * 1024) throw new SessionRequestError('session_attachment_too_large')
  signal.throwIfAborted()
  if (activeParsers >= 2) throw new SessionRequestError('session_attachment_busy')
  activeParsers++
  try {
  const active = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  const interpreter = process.env['LUMO_PPT_PYTHON'] || (process.platform === 'win32' ? 'python' : 'python3')
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(interpreter, ['-I', '-c', extractor, mediaType], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: active, killSignal: 'SIGKILL',
    })
    let stdout = '', stderr = '', exceeded = false, processError: Error | undefined
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 2 * 1024 * 1024) { exceeded = true; child.kill('SIGKILL') }
    })
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
    child.stdin.on('error', () => { /* close/error below owns the outcome */ })
    child.once('error', error => { processError = error })
    child.once('close', (code, terminated) => {
      if (active.aborted) { reject(active.reason); return }
      if (processError) { reject(processError); return }
      if (exceeded || terminated || code !== 0) {
        reject(new SessionRequestError(code === 69 || stderr.includes('LUMO_DOCUMENT_DEPENDENCY_UNAVAILABLE')
          ? 'session_attachment_unavailable' : 'session_attachment_unsupported'))
        return
      }
      resolve(stdout)
    })
    child.stdin.end(bytes)
  }).catch((error: unknown) => {
    signal.throwIfAborted()
    if (error instanceof SessionRequestError) throw error
    throw new SessionRequestError('session_attachment_unavailable')
  })
  active.throwIfAborted()
  let preview: DocumentPreview
  try { preview = JSON.parse(result) as DocumentPreview } catch { throw new SessionRequestError('session_attachment_unavailable') }
  if (!preview || typeof preview.text !== 'string' || preview.text.length > DOCUMENT_PREVIEW_MAX_CHARS
    || preview.format !== DOCUMENT_MEDIA_TYPES[mediaType]?.slice(1)
    || preview.scope !== 'bounded-text-preview' || preview.document_complete !== false || typeof preview.truncated !== 'boolean'
    || !Number.isSafeInteger(preview.units_read) || preview.units_read < 0 || !Number.isSafeInteger(preview.total_units)
    || preview.total_units < preview.units_read || !Array.isArray(preview.warnings) || preview.warnings.length > 8
    || preview.warnings.some(warning => typeof warning !== 'string' || warning.length > 512)) {
    throw new SessionRequestError('session_attachment_unavailable')
  }
  return preview
  } finally { activeParsers-- }
}

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_ATTACHMENT_DOCUMENT_TYPES } from '../../../shared/seam-contracts/session-attachments.ts'
import { DOCUMENT_PREVIEW_MAX_CHARS, extractDocumentPreview, validateDocumentEnvelope } from '../src/session-document.ts'

const python = process.env['LUMO_PPT_PYTHON'] || (process.platform === 'win32' ? 'python' : 'python3')
const active = () => new AbortController().signal
const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function generate(format: string, mode = ''): Buffer {
  const script = String.raw`
import io, json, sys, zipfile
format, mode = sys.argv[1:]
if format == 'pdf':
    import fitz
    doc = fitz.open()
    for i in range(101 if mode == 'many' else 1):
        page = doc.new_page()
        page.insert_text((72, 72), 'PDF actual generated report page ' + str(i + 1))
    kwargs = {'encryption': fitz.PDF_ENCRYPT_AES_256, 'owner_pw': 'owner', 'user_pw': 'secret'} if mode == 'encrypted' else {}
    sys.stdout.buffer.write(doc.tobytes(**kwargs))
    sys.exit(0)
out = io.BytesIO()
main = {'docx': 'word/document.xml', 'xlsx': 'xl/workbook.xml', 'pptx': 'ppt/presentation.xml'}[format]
kind = {'docx': 'wordprocessingml.document', 'xlsx': 'spreadsheetml.sheet', 'pptx': 'presentationml.presentation'}[format]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED if mode in ('long', 'many', 'rows', 'sheets', 'emoji') else zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/' + main + '" ContentType="application/vnd.openxmlformats-officedocument.' + kind + '.main+xml"/></Types>')
    archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
    if format == 'docx':
        word = 'x' * 210000 if mode == 'long' else '😀' * 110000 if mode == 'emoji' else 'Document body 中文 source'
        paragraphs = ''.join('<w:p><w:r><w:t>' + word + '</w:t></w:r></w:p>' for i in range(101 if mode == 'many' else 1))
        content = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '</w:body></w:document>'
        if mode in ('entity', 'entity_utf16'): content = '<!DOCTYPE doc [<!ENTITY x "unsafe">]>' + content
        archive.writestr(main, content.encode('utf-16') if mode == 'entity_utf16' else content)
    elif format == 'xlsx':
        count = 101 if mode == 'sheets' else 1
        order = [2,1] if mode == 'order' else range(1,count+1)
        archive.writestr(main, '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + ''.join('<sheet name="Report' + str(i) + '" sheetId="' + str(i) + '" r:id="sheet' + str(i) + '"/>' for i in order) + '</sheets></workbook>')
        archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join('<Relationship Id="sheet' + str(i) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="' + ('https://external.example/sheet.xml' if mode == 'external' else 'worksheets/custom' + str(i) + '.xml') + '"' + (' TargetMode="External"' if mode == 'external' else '') + '/>' for i in order) + '</Relationships>')
        archive.writestr('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Shared customer</t></si></sst>')
        row = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Inline revenue</t></is></c><c r="C1"><v>42</v></c></row>'
        for i in order:
            content = '<row><c t="inlineStr"><is><t>Ordered unit ' + str(i) + '</t></is></c></row>' if mode == 'order' else row
            archive.writestr('xl/worksheets/custom' + str(i) + '.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + content * (1001 if mode == 'rows' else 1) + '</sheetData></worksheet>')
        if mode == 'order': archive.writestr('xl/worksheets/sheet9.xml', '<worksheet><row><c t="inlineStr"><is><t>Unreferenced private material</t></is></c></row></worksheet>')
    else:
        order = [2,1] if mode == 'order' else [1]
        archive.writestr(main, '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>' + ''.join('<p:sldId id="' + str(i+255) + '" r:id="slide' + str(i) + '"/>' for i in order) + '</p:sldIdLst></p:presentation>')
        archive.writestr('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join('<Relationship Id="slide' + str(i) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="' + ('https://external.example/slide.xml' if mode == 'external' else 'slides/custom' + str(i) + '.xml') + '"' + (' TargetMode="External"' if mode == 'external' else '') + '/>' for i in order) + '</Relationships>')
        for i in order:
            archive.writestr('ppt/slides/custom' + str(i) + '.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:p><a:r><a:t>' + ('Ordered unit ' + str(i) if mode == 'order' else 'Quarterly actual slide') + '</a:t></a:r></a:p></p:cSld></p:sld>')
        if mode == 'order': archive.writestr('ppt/slides/slide9.xml', '<sld><t>Unreferenced private material</t></sld>')
    if mode == 'bomb': archive.writestr('media/compressed.txt', 'a' * 200000)
    if mode == 'path': archive.writestr('../escape.xml', '<x/>')
    if mode == 'duplicate': archive.writestr(main, '<x/>')
    if mode == 'entries':
        for i in range(513): archive.writestr('media/' + str(i) + '.txt', 'x')
sys.stdout.buffer.write(out.getvalue())
`
  const result = spawnSync(python, ['-I', '-c', script, format, mode], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr.toString())
  return result.stdout
}
const pdfAvailable = spawnSync(python, ['-I', '-c', 'import fitz'], { timeout: 5000 }).status === 0
const officeLibrariesAvailable = spawnSync(python, ['-I', '-c', 'import openpyxl, pptx'], { timeout: 5000 }).status === 0

function exportedOffice(format: 'xlsx' | 'pptx'): Buffer {
  const script = String.raw`
import io,sys
out=io.BytesIO()
if sys.argv[1]=='xlsx':
    from openpyxl import Workbook
    doc=Workbook();doc.active.title='Finance 中文';doc.active.append(['Actual exporter 中文',42]);doc.save(out)
else:
    from pptx import Presentation
    from pptx.util import Inches
    doc=Presentation();slide=doc.slides.add_slide(doc.slide_layouts[6]);box=slide.shapes.add_textbox(Inches(1),Inches(1),Inches(6),Inches(1));box.text_frame.text='Actual exporter 中文';doc.save(out)
sys.stdout.buffer.write(out.getvalue())
`
  const result = spawnSync(python, ['-I', '-c', script, format], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr.toString())
  return result.stdout
}

describe('owned document extraction from immutable in-memory bytes', () => {
  it.each([
    ['docx', 'Document body 中文 source'], ['xlsx', 'Shared customer\tInline revenue\t42'], ['pptx', 'Quarterly actual slide'],
  ] as const)('extracts generated %s text without claiming the full document was read', async (format, expected) => {
    const result = await extractDocumentPreview('report.' + format, SESSION_ATTACHMENT_DOCUMENT_TYPES[`.${format}`], generate(format), active())
    expect(result.text).toContain(expected)
    expect(result).toMatchObject({ format, scope: 'bounded-text-preview', document_complete: false, truncated: false, units_read: 1, total_units: 1 })
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it.skipIf(!officeLibrariesAvailable).each(['xlsx', 'pptx'] as const)('extracts a real %s file exported by the provisioned Office library', async format => {
    const result = await extractDocumentPreview('actual.' + format, SESSION_ATTACHMENT_DOCUMENT_TYPES[`.${format}`], exportedOffice(format), active())
    expect(result.text).toContain('Actual exporter 中文')
    expect(result).toMatchObject({ format, document_complete: false, scope: 'bounded-text-preview', truncated: false })
  })

  it.each(['xlsx', 'pptx'] as const)('follows the real %s document order and excludes unreferenced parts', async format => {
    const result = await extractDocumentPreview('ordered.' + format, SESSION_ATTACHMENT_DOCUMENT_TYPES[`.${format}`], generate(format, 'order'), active())
    expect(result.text).toBe('Ordered unit 2\nOrdered unit 1')
    expect(result).toMatchObject({ units_read: 2, total_units: 2, truncated: false })
    expect(result.text).not.toContain('Unreferenced')
  })

  it.each(['xlsx', 'pptx'] as const)('rejects externally linked %s content without reading the target', async format => {
    await expect(extractDocumentPreview('external.' + format, SESSION_ATTACHMENT_DOCUMENT_TYPES[`.${format}`], generate(format, 'external'), active())).rejects.toMatchObject({ code: 'session_attachment_unsupported' })
  })

  it('reports paragraph coverage and character truncation explicitly', async () => {
    const many = await extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], generate('docx', 'many'), active())
    expect(many).toMatchObject({ document_complete: false, truncated: true, units_read: 100, total_units: 101 })
    const long = await extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], generate('docx', 'long'), active())
    expect(long.text).toHaveLength(DOCUMENT_PREVIEW_MAX_CHARS)
    expect(long.truncated).toBe(true)
  })

  it('bounds astral Unicode text without splitting surrogate pairs', async () => {
    const result = await extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], generate('docx', 'emoji'), active())
    expect(result.text).toHaveLength(DOCUMENT_PREVIEW_MAX_CHARS)
    expect(result.text).toBe('😀'.repeat(DOCUMENT_PREVIEW_MAX_CHARS/2))
    expect(result.truncated).toBe(true)
  })

  it('bounds workbook rows and sheets and reports omitted units', async () => {
    const rows = await extractDocumentPreview('report.xlsx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.xlsx'], generate('xlsx', 'rows'), active())
    expect(rows).toMatchObject({ truncated: true, units_read: 1000, total_units: 1001 })
    const sheets = await extractDocumentPreview('report.xlsx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.xlsx'], generate('xlsx', 'sheets'), active())
    expect(sheets).toMatchObject({ truncated: true, units_read: 100, total_units: 101 })
  })

  it.skipIf(!pdfAvailable)('reads an actual generated PDF text layer and reports the page cap', async () => {
    const result = await extractDocumentPreview('report.pdf', 'application/pdf', generate('pdf'), active())
    expect(result.text).toContain('PDF actual generated report page 1')
    expect(result).toMatchObject({ format: 'pdf', document_complete: false, truncated: false, units_read: 1, total_units: 1 })
    expect(result.warnings.join(' ')).toContain('No OCR')
    const many = await extractDocumentPreview('report.pdf', 'application/pdf', generate('pdf', 'many'), active())
    expect(many).toMatchObject({ truncated: true, units_read: 100, total_units: 101 })
  })

  it.skipIf(!pdfAvailable)('rejects password-protected and incomplete PDFs', async () => {
    await expect(extractDocumentPreview('report.pdf', 'application/pdf', generate('pdf', 'encrypted'), active())).rejects.toMatchObject({ code: 'session_attachment_unsupported' })
    await expect(extractDocumentPreview('report.pdf', 'application/pdf', generate('pdf').subarray(0, 200), active())).rejects.toMatchObject({ code: 'session_attachment_unsupported' })
  })

  it.each(['entity', 'entity_utf16', 'bomb', 'path', 'duplicate', 'entries'])('rejects hostile Office input before returning text: %s', async mode => {
    await expect(extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], generate('docx', mode), active())).rejects.toMatchObject({ code: 'session_attachment_unsupported' })
  })

  it('rejects MIME, extension, signature and package identity mismatches', async () => {
    for (const [name, mime, data] of [
      ['report.pdf', 'application/pdf', Buffer.from('not PDF')],
      ['report.txt', 'application/pdf', Buffer.from('%PDF-1.7')],
      ['report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], Buffer.from('not a ZIP')],
    ] as const) expect(() => validateDocumentEnvelope(name, mime, data)).toThrow()
    await expect(extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], generate('xlsx'), active())).rejects.toMatchObject({ code: 'session_attachment_unsupported' })
  })

  it('rejects a pre-cancelled read before launching the parser', async () => {
    const controller = new AbortController(); controller.abort(Error('reader revoked'))
    await expect(extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], generate('docx'), controller.signal)).rejects.toThrow('reader revoked')
  })

  it.skipIf(process.platform === 'win32')('kills an in-flight parser on cancellation without returning late output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo document parser (&) ')); roots.push(root)
    const executable = join(root, 'python fixture')
    writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.resume(); setTimeout(()=>process.stdout.write('{}'),30000);\n`, { mode: 0o755 })
    vi.stubEnv('LUMO_PPT_PYTHON', executable)
    const controller = new AbortController()
    const pending = extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], generate('docx'), controller.signal)
    setTimeout(() => controller.abort(Error('current owner revoked')), 50)
    await expect(pending).rejects.toThrow('current owner revoked')
  })

  it.skipIf(process.platform === 'win32')('bounds concurrent parsers and releases slots after process cancellation', async () => {
    const bytes = generate('docx'), root = mkdtempSync(join(tmpdir(), 'lumo document slots ')); roots.push(root)
    const executable = join(root, 'python fixture')
    writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.resume(); setTimeout(()=>process.stdout.write('{}'),30000);\n`, { mode: 0o755 })
    vi.stubEnv('LUMO_PPT_PYTHON', executable)
    const controllers = [new AbortController(), new AbortController()]
    const pending = controllers.map(controller => extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], bytes, controller.signal))
    const settled = Promise.allSettled(pending)
    try {
      await expect(extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], bytes, active())).rejects.toMatchObject({ code: 'session_attachment_busy' })
    } finally {
      for (const controller of controllers) controller.abort(Error('parser test canceled'))
      expect((await settled).every(result => result.status === 'rejected')).toBe(true)
    }
    vi.stubEnv('LUMO_PPT_PYTHON', python)
    await expect(extractDocumentPreview('report.docx', SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'], bytes, active())).resolves.toMatchObject({ format: 'docx' })
  })
})

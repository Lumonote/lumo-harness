/** Lazy entry for DSH's existing read-only spreadsheet viewer. */
import { lazy, Suspense, type ReactNode } from 'react'
import { LoadingIndicator } from './LoadingIndicator.tsx'
import type { LoadedExcelBodyProps } from './excel/LazyExcelBody.tsx'
import { excelFormat } from './excel/format.ts'
import type { ExcelLimits } from './excel/model.ts'
import { zh } from './excel/locales.ts'
import css from './TextPreview.module.css'

const Loaded = lazy(async () => ({ default: (await import('./excel/excel.tsx')).ExcelBody }))
const limits: ExcelLimits = { maxBytes: 16 * 1024 * 1024, maxCells: 250_000, timeoutMs: 15_000 }
const t = (key: string, variables?: Readonly<Record<string, string | number>>): string => {
  let value = zh[key as keyof typeof zh] ?? key
  for (const [name, replacement] of Object.entries(variables ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}

/** Render workbook bytes using DSH's built-in FortuneSheet-based component. */
export function ExcelDataPreview({ filename, data }: {
  readonly filename: string
  readonly data: Uint8Array<ArrayBuffer>
}): ReactNode {
  const props = {
    content: { kind: 'bytes' as const, data }, format: excelFormat(filename), limits, t,
  } as unknown as LoadedExcelBodyProps
  return <Suspense fallback={<div className={css.status}><LoadingIndicator label={t('loading')} /></div>}><Loaded {...props} /></Suspense>
}

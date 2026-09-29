/** Present library-owned bytes through DSH's existing tab PDF renderer. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { LazyPdfBody } from './pdf/LazyPdfBody.tsx'
import type { PdfBodyProps } from './pdf/pdf.tsx'
import { zh } from './pdf/locales.ts'
import type { PdfState, PdfView } from './pdf/store.ts'
import { ZoomViewport, zoomSurfaceClass } from './zoom/ZoomViewport.tsx'

const tabId = 'lumo-library-preview' as TabId

function translatePdf(key: string, variables?: Readonly<Record<string, string | number>>): string {
  let value = zh[key as keyof typeof zh] ?? key
  for (const [name, replacement] of Object.entries(variables ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}

/** Render authorized application-owned PDF bytes with DSH's native PDF reader. */
export function PdfDataPreview({ data }: { readonly data: Uint8Array<ArrayBuffer> }): ReactNode {
  const [view, setView] = useState<PdfView>({ page: 1 })
  const lifetime = useMemo(() => new AbortController(), [data])
  useEffect(() => () => lifetime.abort(), [lifetime])
  const useTabInfo = useCallback(() => ({ tab: { id: tabId, signal: lifetime.signal } }), [lifetime]) as PdfBodyProps['useTabInfo']
  const useStore = useCallback(<Selection,>(select: (state: PdfState) => Selection): Selection =>
    select({ byTab: { [tabId]: view } }), [view]) as PdfBodyProps['useStore']
  const actions = useMemo<PdfBodyProps['actions']>(() => ({
    page: (_id, page) => setView(previous => ({ ...previous, page })),
    zoom: (_id, zoom) => setView(previous => ({ ...previous, zoom })),
    forget: () => setView({ page: 1 }),
  }), [])
  const scrollportRef = useCallback<PdfBodyProps['scrollportRef']>(() => {}, [])
  const props = {
    content: { kind: 'bytes', data }, scrollportRef,
    useTabInfo, useStore, actions, t: translatePdf as PdfBodyProps['t'],
    retainTab: () => {}, ZoomViewport, zoomSurfaceClass,
  } satisfies Pick<PdfBodyProps,
    'content' | 'scrollportRef' | 'useTabInfo' | 'useStore' | 'actions' | 't'
    | 'retainTab' | 'ZoomViewport' | 'zoomSurfaceClass'>
  // PdfBody also receives session hooks as a DSH slot, but its renderer does
  // not read them. This standalone preview supplies the exact renderer inputs.
  return <LazyPdfBody {...props as unknown as PdfBodyProps} />
}

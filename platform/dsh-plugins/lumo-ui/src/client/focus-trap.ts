import { useEffect } from 'react'

export const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]'

export function focusableChildren(container: HTMLElement): HTMLElement[] {
  const view = container.ownerDocument.defaultView
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(element => {
    if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    for (let cursor: HTMLElement | null = element; cursor && container.contains(cursor); cursor = cursor.parentElement) {
      const style = view?.getComputedStyle(cursor)
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false
      if (cursor.tagName === 'DETAILS' && !cursor.hasAttribute('open') && cursor.querySelector(':scope > summary') !== element) return false
    }
    return true
  })
}

export function useFocusTrap(ref: { current: HTMLElement | null }, active: boolean): void {
  useEffect(() => {
    const container = ref.current
    if (!active || container === null) return
    const document = container.ownerDocument
    ;(focusableChildren(container)[0] ?? container).focus()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusableChildren(container)
      if (!items.length) { event.preventDefault(); container.focus(); return }
      const current = document.activeElement
      const index = items.indexOf(current as HTMLElement)
      if (event.shiftKey && (index <= 0 || !container.contains(current))) {
        event.preventDefault(); items[items.length - 1]?.focus()
      } else if (!event.shiftKey && (index < 0 || index === items.length - 1 || !container.contains(current))) {
        event.preventDefault(); items[0]?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [active, ref])
}

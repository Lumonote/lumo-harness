/** Desktop playback of the unchanged official home-whale frame atlas. See pet-artwork.NOTICE. */
export const BREACH_DURATION = 5700
export const WHALE_ATLAS = Object.freeze({ width: 192, height: 108, columns: 12, frames: 137 })
const HOLD_FRAME = 61
const ATLAS_URL = new URL('./pet-breach-atlas.webp', import.meta.url).href

/** Keep official frame positions and timing; fuller dots and a lifted alpha curve make the desktop silhouette solid. */
export function paintWhaleFrame(context, pixels, frame, width, height, color) {
  const { width: cells, height: rows, columns, frames } = WHALE_ATLAS
  const index = Math.min(frames - 1, Math.max(0, Math.floor(frame)))
  const cell = Math.min(width / cells, height / rows) * .98
  const left = (width - cells * cell) / 2
  const top = (height - rows * cell) / 2
  const originX = index % columns * cells
  const originY = Math.floor(index / columns) * rows
  const stride = cells * columns
  context.clearRect(0, 0, width, height)
  context.fillStyle = color
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cells; x++) {
      const offset = ((originY + y) * stride + originX + x) * 4
      const alpha = pixels[offset + 1] / 255
      if (alpha < .015) continue
      const radius = Math.min(pixels[offset] / 255 * 1.6, .64) * cell
      if (radius === 0) continue
      context.globalAlpha = Math.min(1, Math.sqrt(alpha) * 1.6)
      context.beginPath()
      context.arc(left + (x + .5) * cell, top + (y + .5) * cell, radius, 0, Math.PI * 2)
      context.fill()
    }
  }
  context.globalAlpha = 1
}

/** Own only temporary Canvas resources; hidden, paused and reduced-motion surfaces do no frame work. */
export function mountWhaleMotion(view, { onIdle = () => {} } = {}) {
  const doc = view.document
  const canvas = doc.getElementById('whale-canvas')
  const media = view.matchMedia?.('(prefers-reduced-motion: reduce)')
  let context
  try { context = canvas?.getContext('2d') } catch { /* A static official mark remains available without Canvas. */ }
  if (!context) return { play() {}, stop() {}, pause() {}, dispose() {} }
  const image = new view.Image()
  let pixels
  let disposed = false
  let failed = false
  let paused = false
  let reduced = media?.matches === true
  let raf
  let started = null
  let lastFrame = -Infinity
  let idleTimer
  let pendingPlay = false
  let width = 320
  let height = 250
  let dpr = 1
  const cancelFrame = () => {
    if (raf !== undefined) view.cancelAnimationFrame(raf)
    raf = undefined
  }
  const cancelIdle = () => {
    if (idleTimer !== undefined) view.clearTimeout(idleTimer)
    idleTimer = undefined
  }
  const drawable = () => !disposed && !failed && !paused && !doc.hidden && pixels !== undefined
  const color = () => view.getComputedStyle(canvas).color || '#405ce8'
  function paint(frame) {
    if (!pixels || disposed) return
    paintWhaleFrame(context, pixels, frame, width, height, color())
  }
  function hold() { if (!doc.hidden) paint(HOLD_FRAME) }
  function scheduleIdle(delay = 10500) {
    cancelIdle()
    if (!drawable() || reduced) return
    idleTimer = view.setTimeout(() => {
      idleTimer = undefined
      if (drawable() && !reduced && started === null) onIdle()
    }, delay)
  }
  function tick(now) {
    raf = undefined
    if (!drawable() || reduced || started === null) return
    const progress = (now - started) / BREACH_DURATION
    if (progress >= 1) { started = null; hold(); scheduleIdle(); return }
    if (now - lastFrame >= 1000 / 24 - .5) {
      paint(Math.floor(progress * WHALE_ATLAS.frames))
      lastFrame = now
    }
    raf = view.requestAnimationFrame(tick)
  }
  function play() {
    if (disposed || failed || paused || doc.hidden || started !== null) return
    cancelIdle()
    if (!pixels) { pendingPlay = true; return }
    if (reduced) { hold(); return }
    started = view.performance.now()
    lastFrame = -Infinity
    cancelFrame()
    raf = view.requestAnimationFrame(tick)
  }
  function stop() {
    pendingPlay = false
    started = null
    cancelFrame()
    hold()
    scheduleIdle()
  }
  function pause(value) {
    if (paused === value) return
    paused = value
    if (value) { cancelFrame(); cancelIdle(); started = null; hold() }
    else { hold(); scheduleIdle() }
  }
  function resize() {
    if (disposed) return
    width = canvas.clientWidth || 320
    height = canvas.clientHeight || 250
    dpr = Math.min(view.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (started === null || reduced) hold()
  }
  function visibility() {
    if (doc.hidden) { cancelFrame(); cancelIdle(); started = null }
    else { hold(); scheduleIdle() }
  }
  function preference(event) {
    reduced = event.matches
    stop()
  }
  const sizeObserver = view.ResizeObserver ? new view.ResizeObserver(resize) : null
  sizeObserver?.observe(canvas)
  view.addEventListener('resize', resize)
  doc.addEventListener('visibilitychange', visibility)
  media?.addEventListener?.('change', preference)
  function fail() {
    failed = true
    cancelFrame()
    cancelIdle()
    canvas.dataset.failed = 'true'
    image.onload = image.onerror = null
    image.removeAttribute('src')
  }
  image.onload = () => {
    if (disposed) return
    const source = doc.createElement('canvas')
    source.width = image.naturalWidth
    source.height = image.naturalHeight
    try {
      if (source.width !== WHALE_ATLAS.width * WHALE_ATLAS.columns
        || source.height !== WHALE_ATLAS.height * Math.ceil(WHALE_ATLAS.frames / WHALE_ATLAS.columns)) throw Error('invalid_whale_atlas')
      const reader = source.getContext('2d', { willReadFrequently: true })
      if (!reader) throw Error('whale_canvas_unavailable')
      reader.drawImage(image, 0, 0)
      pixels = reader.getImageData(0, 0, source.width, source.height).data
      resize()
      canvas.dataset.ready = 'true'
      if (pendingPlay) { pendingPlay = false; play() }
      else scheduleIdle(600)
    } catch { fail() }
    finally { source.width = source.height = 0; image.removeAttribute('src') }
  }
  image.onerror = fail
  resize()
  image.src = ATLAS_URL
  return {
    play, stop, pause,
    dispose() {
      if (disposed) return
      disposed = true
      cancelFrame()
      cancelIdle()
      image.onload = image.onerror = null
      image.removeAttribute('src')
      pixels = undefined
      canvas.width = canvas.height = 0
      sizeObserver?.disconnect()
      view.removeEventListener('resize', resize)
      doc.removeEventListener('visibilitychange', visibility)
      media?.removeEventListener?.('change', preference)
    },
  }
}

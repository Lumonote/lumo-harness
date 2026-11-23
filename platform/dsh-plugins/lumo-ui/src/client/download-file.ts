/** Start the download while the user's click is active, then release the temporary URL. */
export function downloadFile(blob: Blob, filename: string): void {
  const anchor = document.createElement('a')
  const url = URL.createObjectURL(blob)
  try {
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

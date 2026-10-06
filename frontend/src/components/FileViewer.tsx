import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'

export interface ViewFile { url: string; name: string; mime: string }

const isImage = (mime: string) => /^image\/(jpeg|png|webp|gif)$/i.test(mime)
const isPdf = (f: ViewFile) => f.mime === 'application/pdf' || /\.pdf$/i.test(f.name)

/** Every page of a PDF drawn onto canvases, as wide as the viewer (sharp on phone screens). The PDF library
 *  is only downloaded when a PDF is actually opened. */
function PdfPages({ data }: { data: ArrayBuffer }) {
  const box = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading')

  useEffect(() => {
    let alive = true
    let task: { destroy: () => Promise<void> } | null = null
    const host = box.current!
    ;(async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default
      const loading = pdfjs.getDocument({ data: data.slice(0) }) // a copy: the library takes the buffer over
      task = loading
      const doc = await loading.promise
      const width = host.clientWidth
      const sharp = Math.min(window.devicePixelRatio || 1, 2)
      for (let n = 1; n <= doc.numPages && alive; n++) {
        const page = await doc.getPage(n)
        const fit = width / page.getViewport({ scale: 1 }).width
        const viewport = page.getViewport({ scale: fit * sharp })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${Math.floor(viewport.width / sharp)}px`
        if (!alive) break
        host.appendChild(canvas)
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
      }
      if (alive) setState('done')
    })().catch(() => { if (alive) setState('error') })
    return () => { alive = false; task?.destroy().catch(() => {}); host.replaceChildren() }
  }, [data])

  return (
    <>
      {state === 'loading' && <p className="fview__note">Atver…</p>}
      {state === 'error' && <p className="fview__note">Šo PDF neizdevās parādīt. Izmantojiet „Saglabāt” vai „Kopīgot”.</p>}
      <div ref={box} className="fview__pdf" />
    </>
  )
}

/**
 * Shows an attached file inside the app, over whatever is open, with its own close button. Needed because a
 * file opened as a page of its own leaves the home-screen app (iPhone) with no way back — there is no browser
 * bar there. Pictures and PDFs are shown; any file can be saved.
 */
export function FileViewer({ file, onClose }: { file: ViewFile; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | null>(null)
  const [failed, setFailed] = useState(false)
  const [image, setImage] = useState('')
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null)
  const box = useRef<HTMLDivElement>(null)

  // Downloaded once: the same copy is shown, shared and saved.
  useEffect(() => {
    let alive = true
    let objectUrl = ''
    fetch(file.url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(async (b) => {
        if (!alive) return
        if (isImage(file.mime)) { objectUrl = URL.createObjectURL(b); setImage(objectUrl) }
        else if (isPdf(file)) setPdf(await b.arrayBuffer())
        setBlob(b)
      })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [file])
  // Focus moves into the viewer, so Esc (and Tab) act on it and not on the dialog underneath.
  useEffect(() => { box.current?.focus() }, [])

  const save = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob!)
    a.download = file.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }
  const shown = image !== '' || pdf !== null

  return createPortal(
    // Keys and clicks stop here: this sits on top of a dialog, which must not react to them (Esc would close both).
    // Desktop: a window in the middle of the screen (a click beside it closes it); phone: the whole screen.
    <div className="fview" role="presentation" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose() }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose() }}>
      <div ref={box} tabIndex={-1} className={image ? 'fview__box img' : 'fview__box'} role="dialog" aria-modal="true" aria-label={file.name}>
        <div className="fview__bar">
          <button type="button" className="icon-btn fview__back" onClick={onClose} aria-label="Atpakaļ">{Icon.back(20)}</button>
          <b className="fview__name">{file.name}</b>
          <button type="button" className="btn small" disabled={!blob} onClick={save}>Saglabāt</button>
          <button type="button" className="icon-btn fview__x" onClick={onClose} aria-label="Aizvērt">{Icon.close(18)}</button>
        </div>
        <div className="fview__body">
          {failed && <p className="fview__note">Failu neizdevās ielādēt.</p>}
          {!failed && !blob && <p className="fview__note">Ielādē…</p>}
          {image && <img src={image} alt={file.name} />}
          {pdf && <PdfPages data={pdf} />}
          {blob && !shown && <p className="fview__note">Šāda veida failu šeit nevar parādīt. Izmantojiet „Saglabāt”.</p>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

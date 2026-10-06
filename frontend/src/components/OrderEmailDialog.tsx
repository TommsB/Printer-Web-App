import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Dialog } from './Dialog'

/**
 * The user's saved wording for the order e-mail. Placeholders in {braces} are filled in per company /
 * printer / toner. Styling uses three markers: **bold**, *italic*, __underline__.
 */
interface Template {
  intro: string // lines before the list
  outro: string // lines after the list (closing, signature)
  company: string // per company: {uzņēmums}
  heading: string // per printer model: {modelis}
  line: string // per toner: {kods} {krāsa} {skaits}
}
/** Which e-mail this is: each has its own saved template (setting), default wording and extra placeholders. */
export interface EmailFlavor {
  setting: string
  title: string
  defaults: Template
  merge: boolean // sum identical toners of the same model into one line (orders) or keep one line each (claims)
  scope: string // shown in the template editor: where this template is used
  linePlaceholders: string[] // what can be used in "Tonera rinda"
}
/** Ordering: one template shared by the "Jāpasūta" and "Pasūtīts" lists. */
export const ORDER_EMAIL: EmailFlavor = {
  setting: 'order_email',
  title: 'Pasūtījuma teksts e-pastam',
  defaults: {
    intro: 'Sveiks!\nJāpasūta pāris kārtridži:',
    outro: '',
    company: '{uzņēmums}:',
    heading: 'Priekš {modelis}:',
    line: '• {kods} – {krāsa} – {skaits} gab.',
  },
  merge: true,
  scope: 'Viena veidne abiem sarakstiem — „Grozs” un „Pasūtīts”.',
  linePlaceholders: ['{kods}', '{krāsa}', '{skaits}'],
}
/** Warranty claims: separate wording, one line per defective cartridge with where and at what level it failed. */
export const WARRANTY_EMAIL: EmailFlavor = {
  setting: 'warranty_email',
  title: 'Garantijas pieteikuma teksts',
  defaults: {
    intro: 'Sveiks!\nNosūtu atpakaļ garantijas ietvaros bojātus kārtridžus:',
    outro: '',
    company: '{uzņēmums}:',
    heading: 'Priekš {modelis}:',
    line: '• {kods} – {krāsa} – {defekts}, izņemts pie {procenti}%',
  },
  merge: false,
  scope: 'Atsevišķa veidne garantijas pieteikumiem (pasūtījumu veidni tā nemaina).',
  linePlaceholders: ['{kods}', '{krāsa}', '{defekts}', '{procenti}', '{lapas}', '{printeris}'],
}
const COLOR_EN: Record<string, string> = { K: 'Black', C: 'Cyan', M: 'Magenta', Y: 'Yellow' }
const KIND_NOTE: Record<string, string> = { drum: ' (drams)' }

const fill = (tpl: string, values: Record<string, string>) =>
  tpl.replace(/\{([^{}]+)\}/g, (whole, key: string) => values[key.trim().toLowerCase()] ?? whole)
    .replace(/(\s[–-]\s)(?:\s*[–-]\s)+/g, '$1') // an empty value (toner without a colour) leaves no double dash

/**
 * One toner to put in the e-mail: from "Jāpasūta" (what's missing), from "Pasūtīts" (an open order), or a
 * warranty claim (then also the printer, the level it was removed at and the defect).
 */
export interface EmailItem {
  company: string; model: string; code: string; color: string; kind: string; qty: number
  printer?: string; pct?: number | null; defect?: string
  pages?: number | null // printed with the cartridge, if known
}

/**
 * A list of toners as e-mail text (still with the styling markers): Uzņēmums → printera modelis → toneris.
 * With `merge`, the same toner for the same model in one company becomes one line with the quantities summed.
 */
function orderEmailText(rows: EmailItem[], tpl: Template, merge: boolean): string {
  const companies = new Map<string, Map<string, Map<string, EmailItem>>>()
  rows.forEach((r, i) => {
    if (r.qty <= 0) return
    const models = companies.get(r.company) ?? new Map<string, Map<string, EmailItem>>()
    const toners = models.get(r.model) ?? new Map<string, EmailItem>()
    const key = merge ? r.code : `${r.code}#${i}`
    const t = toners.get(key)
    toners.set(key, t ? { ...t, qty: t.qty + r.qty } : { ...r })
    models.set(r.model, toners)
    companies.set(r.company, models)
  })
  const blocks = [...companies].map(([company, models]) => [
    fill(tpl.company, { 'uzņēmums': company || 'Cits' }),
    ...[...models].flatMap(([model, toners]) => [
      fill(tpl.heading, { modelis: model || 'printera' }),
      ...[...toners.values()].sort((a, b) => a.code.localeCompare(b.code)).map((t) => fill(tpl.line, {
        kods: t.code, skaits: String(t.qty),
        'krāsa': (COLOR_EN[t.color.toUpperCase()] ?? '') + (KIND_NOTE[t.kind] ?? ''),
        printeris: t.printer ?? '', defekts: t.defect || 'defekts', procenti: t.pct == null ? '?' : String(t.pct),
        lapas: t.pages == null ? '?' : String(t.pages),
      })),
    ]),
  ].join('\n'))
  return [tpl.intro.trim(), blocks.join('\n\n'), tpl.outro.trim()].filter(Boolean).join('\n\n')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Marked-up text → HTML, one <div> per line. Everything is escaped first; only <b>/<i>/<u> are ever added. */
function toHtml(text: string): string {
  return text.split('\n').map((line) => {
    const html = esc(line)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/__(.+?)__/g, '<u>$1</u>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
    return `<div>${html || '<br>'}</div>`
  }).join('')
}

/**
 * What goes on the clipboard, read back from the (possibly hand-edited) editor: clean HTML with nothing but
 * <b>/<i>/<u> and line breaks — none of the app's fonts or colours — plus the same thing as plain text.
 */
function serialize(root: HTMLElement): { html: string; plain: string } {
  const TAG: Record<string, string> = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u' }
  const lines: { html: string; plain: string }[] = [{ html: '', plain: '' }]
  const walk = (node: Node, open: string, close: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? ''
      if (t) { const l = lines[lines.length - 1]; l.html += open + esc(t) + close; l.plain += t }
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.tagName === 'BR') { if (node.nextSibling) lines.push({ html: '', plain: '' }); return }
    const block = node.tagName === 'DIV' || node.tagName === 'P'
    if (block && (lines[lines.length - 1].html || lines.length > 1 || node.previousSibling)) lines.push({ html: '', plain: '' })
    const tag = TAG[node.tagName]
    for (const child of node.childNodes) walk(child, tag ? `${open}<${tag}>` : open, tag ? `</${tag}>${close}` : close)
  }
  for (const child of root.childNodes) walk(child, '', '')
  return { html: lines.map((l) => l.html).join('<br>'), plain: lines.map((l) => l.plain).join('\n') }
}

/** Copies rich + plain text. Works on plain http too (the async Clipboard API needs https): sets the data in a 'copy' event. */
function copyRich(root: HTMLElement): boolean {
  const { html, plain } = serialize(root)
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/html', html)
    e.clipboardData?.setData('text/plain', plain)
    e.preventDefault()
  }
  // Some browsers only fire 'copy' when something is selected.
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(root)
  sel?.removeAllRanges()
  sel?.addRange(range)
  document.addEventListener('copy', onCopy)
  let ok = false
  try { ok = document.execCommand('copy') } finally { document.removeEventListener('copy', onCopy) }
  sel?.removeAllRanges()
  return ok
}

/** B / I / U buttons. onMouseDown keeps the text selection while the button is pressed. */
function StyleBar({ onStyle }: { onStyle: (s: 'bold' | 'italic' | 'underline') => void }) {
  const btn = (s: 'bold' | 'italic' | 'underline', label: string, text: string, cls: string) => (
    <button type="button" className={`sbtn ${cls}`} aria-label={label} title={label}
      onMouseDown={(e) => e.preventDefault()} onClick={() => onStyle(s)}>{text}</button>
  )
  return (
    <span className="sbar" role="group" aria-label="Teksta stils">
      {btn('bold', 'Treknraksts', 'B', 'b')}{btn('italic', 'Slīpraksts', 'I', 'i')}{btn('underline', 'Pasvītrojums', 'U', 'u')}
    </span>
  )
}

const MARK = { bold: '**', italic: '*', underline: '__' }
type Field = HTMLInputElement | HTMLTextAreaElement

/**
 * Krājumi → ✉ on "Jāpasūta" or "Pasūtīts" (or "Garantijas e-pasts" on a claim): that list as formatted text to
 * copy into an e-mail. Nothing is ordered or changed. The wording and styling come from the user's saved
 * template for this `flavor` ("Labot veidni"); edits in the box are one-off.
 */
export function OrderEmailDialog({ rows, source, flavor = ORDER_EMAIL, onClose }: {
  rows: EmailItem[]
  source: string // list name shown in the note, e.g. "Jāpasūta"
  flavor?: EmailFlavor
  onClose: () => void
}) {
  const DEFAULT = flavor.defaults
  const SETTING = flavor.setting
  const textOf = (t: Template) => orderEmailText(rows, t, flavor.merge)
  const [tpl, setTpl] = useState(DEFAULT)
  const [html, setHtml] = useState(() => toHtml(textOf(DEFAULT)))
  const [draft, setDraft] = useState<Template | null>(null) // not null = editing the template
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const editor = useRef<HTMLDivElement>(null)
  const touched = useRef(false) // the user edited the box: don't replace their text when the template arrives
  const active = useRef<{ key: keyof Template; el: Field } | null>(null) // template field the B/I/U buttons act on

  // Load the saved template once.
  useEffect(() => {
    let alive = true
    api.getSetting(SETTING).then(({ value }) => {
      if (!alive || !value) return
      try {
        const saved = { ...DEFAULT, ...(JSON.parse(value) as Partial<Template>) }
        setTpl(saved)
        if (!touched.current) setHtml(toHtml(textOf(saved)))
      } catch { /* damaged setting: keep the default */ }
    }).catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, with the rows the dialog opened with
  }, [])

  const copy = () => {
    const ok = editor.current ? copyRich(editor.current) : false
    setCopied(ok)
    if (ok) setTimeout(() => setCopied(false), 2500)
  }

  const saveTemplate = async () => {
    if (!draft) return
    setSaving(true)
    setError('')
    try {
      await api.putSetting(SETTING, JSON.stringify(draft))
      setTpl(draft)
      setHtml(toHtml(textOf(draft)))
      touched.current = false
      setDraft(null)
    } catch (err) { setError(err instanceof Error ? err.message : 'Kļūda') } finally { setSaving(false) }
  }
  const set = (k: keyof Template, v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d))

  // Template B/I/U: wrap the selection of the last focused field in the marker (or insert an empty pair).
  const wrap = (style: keyof typeof MARK) => {
    const a = active.current
    if (!a || !draft) return
    const m = MARK[style]
    const { el, key } = a
    const s = el.selectionStart ?? el.value.length
    const e = el.selectionEnd ?? s
    set(key, el.value.slice(0, s) + m + el.value.slice(s, e) + m + el.value.slice(e))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + m.length, e + m.length) })
  }
  const field = (key: keyof Template) => ({
    value: draft?.[key] ?? '',
    onChange: (e: React.ChangeEvent<Field>) => set(key, e.target.value),
    onFocus: (e: React.FocusEvent<Field>) => { active.current = { key, el: e.target } },
  })

  if (draft) {
    return (
      <Dialog.Frame title="E-pasta veidne" onClose={onClose}>
        <p className="dlg-text muted">Saglabājas jūsu kontam. {flavor.scope}</p>
        <div className="email-head">
          <p className="fnote">Iezīmējiet tekstu laukā un nospiediet stilu: <code>**trekns**</code>, <code>*slīps*</code>, <code>__pasvītrots__</code>.</p>
          <StyleBar onStyle={wrap} />
        </div>
        <label>Ievads<textarea rows={3} {...field('intro')} /></label>
        <label>Uzņēmuma rinda<input spellCheck={false} {...field('company')} /></label>
        <label>Printera virsraksts<input spellCheck={false} {...field('heading')} /></label>
        <label>Tonera rinda<input spellCheck={false} {...field('line')} /></label>
        <p className="fnote">Aizstājēji: <code>{'{uzņēmums}'}</code>, <code>{'{modelis}'}</code>; tonera rindā{' '}
          {flavor.linePlaceholders.map((p, i) => <span key={p}>{i > 0 && ', '}<code>{p}</code></span>)}.</p>
        <label>Nobeigums (nav obligāts)<textarea rows={2} placeholder="piem. Paldies!…" {...field('outro')} /></label>
        <div className="field"><span>Priekšskatījums</span>
          <div className="email-preview" dangerouslySetInnerHTML={{ __html: toHtml(textOf(draft)) }} />
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <Dialog.Footer>
          <Dialog.Start><button type="button" className="btn" onClick={() => setDraft(DEFAULT)}>Noklusētā</button></Dialog.Start>
          <button type="button" className="btn" onClick={() => { setDraft(null); setError('') }}>Atpakaļ</button>
          <button type="button" className="btn primary" disabled={saving || !draft.line.trim()} onClick={saveTemplate}>Saglabāt veidni</button>
        </Dialog.Footer>
      </Dialog.Frame>
    )
  }

  return (
    <Dialog.Frame title={flavor.title} onClose={onClose}>
      <div className="email-head">
        <StyleBar onStyle={(s) => { editor.current?.focus(); document.execCommand(s); touched.current = true }} />
        <button type="button" className="btn small" onClick={() => setDraft(tpl)}>Labot veidni</button>
      </div>
      {/* Uncontrolled rich-text box: React only sets the content when the template changes (key). */}
      <div key={html} ref={editor} className="email-text" contentEditable suppressContentEditableWarning spellCheck={false}
        role="textbox" aria-multiline="true" aria-label="Pasūtījuma teksts" dangerouslySetInnerHTML={{ __html: html }}
        onInput={() => { touched.current = true; setCopied(false) }}
        onPaste={(e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')) }} />
      <p className="fnote">No saraksta „{source}”; nekas netiek pasūtīts vai mainīts. Labojumi šeit ir tikai šai reizei — pastāvīgi maina „Labot veidni”.</p>
      <Dialog.Footer>
        <Dialog.Start><span className="copied" role="status">{copied ? 'Nokopēts ✓' : ''}</span></Dialog.Start>
        <Dialog.Cancel>Aizvērt</Dialog.Cancel>
        <button type="button" className="btn primary" onClick={copy}>Kopēt</button>
      </Dialog.Footer>
    </Dialog.Frame>
  )
}

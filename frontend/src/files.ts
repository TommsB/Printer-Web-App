import type { DeliveryDoc, Order } from './api'

/** The delivery documents of a group of orders, each once (a document is linked to several orders). */
export function docsOf(orders: Order[]): DeliveryDoc[] {
  const seen = new Map<number, DeliveryDoc>()
  for (const o of orders) for (const d of o.docs ?? []) seen.set(d.id, d)
  return [...seen.values()].sort((a, b) => a.id - b.id)
}

const MAX_SIDE = 2000 // phone photos are 12+ megapixels; this is plenty to show a print defect
const SHRINKABLE = /^image\/(jpeg|png|webp|heic|heif)$/i

/** A big photo is scaled down to MAX_SIDE and saved as JPEG before uploading (faster on mobile data, and it
 *  keeps the server's disk small). Anything else, or a photo the browser can't decode, is sent as it is. */
async function shrink(file: File): Promise<File> {
  if (!SHRINKABLE.test(file.type)) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
    if (scale === 1 && file.type === 'image/jpeg') return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.85))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch { return file }
}

/** Files as they should be uploaded: photos shrunk, everything else untouched. */
export const prepareFiles = (files: File[]) => Promise.all(files.map(shrink))

export const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

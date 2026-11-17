/**
 * A printer's picture, made ready in the browser before it is uploaded: the middle square of the photo, shrunk
 * to SIZE × SIZE and saved as a JPEG. A phone photo of several MB becomes a few dozen KB, and the round avatar
 * in Statuss (44 px, sharp on high-density screens) needs no more. Transparent parts (a PNG) become white.
 */
const SIZE = 320
const QUALITY = 0.86

export async function squarePhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Izvēlieties attēlu (JPEG, PNG, WebP…)')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file) // turned upright from the photo's EXIF orientation by the browser
  } catch {
    throw new Error('Šo attēlu neizdevās atvērt. Mēģiniet citu (JPEG vai PNG).')
  }
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Attēlu neizdevās sagatavot')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, SIZE, SIZE)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
  if (!blob) throw new Error('Attēlu neizdevās sagatavot')
  return blob
}

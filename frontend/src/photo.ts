/**
 * A printer's picture, made ready in the browser before it is uploaded: the square the user picked in the crop
 * window (PhotoCropper), shrunk to SIZE × SIZE and saved as a JPEG. A phone photo of several MB becomes a few
 * dozen KB; SIZE is enough for the largest place it shows (the Informācija card) on high-density screens.
 * Transparent parts (a PNG) become white.
 */
export const SIZE = 480
const QUALITY = 0.86

/** The square to keep, in the photo's own pixels. */
export interface Crop { x: number; y: number; side: number }

/** Open a picked file as an image, turned upright from the photo's EXIF orientation. */
export async function loadPhoto(file: File): Promise<ImageBitmap> {
  if (!file.type.startsWith('image/')) throw new Error('Izvēlieties attēlu (JPEG, PNG, WebP…)')
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error('Šo attēlu neizdevās atvērt. Mēģiniet citu (JPEG vai PNG).')
  }
}

/** The middle square: where the crop window starts. */
export const centreCrop = (img: ImageBitmap): Crop => {
  const side = Math.min(img.width, img.height)
  return { x: (img.width - side) / 2, y: (img.height - side) / 2, side }
}

/** Cut `crop` out of the photo and save it as a SIZE × SIZE JPEG. */
export async function cropPhoto(img: ImageBitmap, crop: Crop): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Attēlu neizdevās sagatavot')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, SIZE, SIZE)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, crop.x, crop.y, crop.side, crop.side, 0, 0, SIZE, SIZE)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
  if (!blob) throw new Error('Attēlu neizdevās sagatavot')
  return blob
}

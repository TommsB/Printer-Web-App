import { api } from './api'

/**
 * Push notifications on this device (see backend/app/push.py for what gets sent).
 * A browser may only ask for permission after a tap, only on https, and on iPhone only inside the
 * home-screen app — `pushSupport` says which of these applies.
 */
export type PushSupport =
  | 'ok'
  | 'insecure' // not https: browsers refuse
  | 'ios-install' // iPhone/iPad in Safari: must be added to the home screen first
  | 'unsupported' // this browser has no push
  | 'denied' // the user blocked notifications for this site

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIOS() && !isStandalone() ? 'ios-install' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'denied'
  return 'ok'
}

/** The service worker that receives the notifications (registered on first use, then reused). */
async function worker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js')
  return navigator.serviceWorker.ready
}

/** This device's subscription, if notifications are on here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok' && pushSupport() !== 'denied') return null
  const reg = await navigator.serviceWorker.getRegistration()
  return reg ? reg.pushManager.getSubscription() : null
}

/** The server's public key (base64url) as the raw bytes the browser wants. */
function keyBytes(base64url: string): ArrayBuffer {
  const raw = atob(base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '='))
  const buffer = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return buffer
}

function deviceName(): string {
  const ua = navigator.userAgent
  const what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Ierīce'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  return [what, browser].filter(Boolean).join(' · ')
}

/** Ask for permission (must be called from a tap), subscribe this device and tell the server. */
export async function enablePush(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Paziņojumi šai lapai ir bloķēti ierīces iestatījumos.' : 'Atļauja netika dota.')
  const reg = await worker()
  let sub = await reg.pushManager.getSubscription()
  // A subscription made for another server key can't be used: start over.
  if (sub && sub.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  const json = sub.toJSON()
  await api.pushSubscribe({ endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, device: deviceName() })
  return sub
}

/** Turn notifications off on this device (the other devices of the user stay as they are). */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  await api.pushUnsubscribe(sub.endpoint).catch(() => {})
  await sub.unsubscribe()
}

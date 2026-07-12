import type { AppInfo } from './types'

type AnalyticsValue = string | number | boolean
type AnalyticsParameters = Record<string, AnalyticsValue | undefined>
type Gtag = (command: string, ...args: unknown[]) => void

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: Gtag
  }
}

const measurementId = import.meta.env.VITE_GA_MEASUREMENT_ID?.trim()
const pending: Array<[string, AnalyticsParameters]> = []
let initialized = false
let analyticsEnabled = false
let appInfo: AppInfo | null = null

const clientId = () => {
  const key = 'diskloom.analytics.client-id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const value = crypto.randomUUID()
  localStorage.setItem(key, value)
  return value
}

/** Provide app metadata without starting collection; collection remains gated on explicit consent. */
export function configureAnalytics(app: AppInfo) {
  appInfo = app
  if (analyticsEnabled) initializeAnalytics()
}

export function setAnalyticsConsent(enabled: boolean) {
  analyticsEnabled = enabled
  pending.length = 0
  if (!enabled) {
    window.gtag?.('consent', 'update', { analytics_storage: 'denied' })
    return
  }
  if (initialized) window.gtag?.('consent', 'update', { analytics_storage: 'granted' })
  else initializeAnalytics()
}

/** Initialize anonymous GA4 collection. No-op without consent, metadata, or a build-time ID. */
function initializeAnalytics() {
  if (!measurementId || !analyticsEnabled || !appInfo || initialized) return

  window.dataLayer = window.dataLayer ?? []
  window.gtag = (...args: unknown[]) => { window.dataLayer!.push(args) }
  window.gtag('consent', 'default', { analytics_storage: 'granted' })
  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`
  document.head.append(script)

  window.gtag('js', new Date())
  window.gtag('set', 'user_properties', {
    app_version: appInfo.version,
    app_platform: appInfo.platform,
    app_arch: appInfo.arch,
    electron_version: appInfo.electronVersion,
  })
  window.gtag('config', measurementId, {
    client_id: clientId(),
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    debug_mode: import.meta.env.DEV || import.meta.env.VITE_GA_DEBUG === 'true',
  })
  initialized = true
  track('app_open')
  pending.splice(0).forEach(([name, parameters]) => track(name, parameters))
}

/** Send only coarse, explicitly provided usage metadata. Never pass filesystem values here. */
export function track(name: string, parameters: AnalyticsParameters = {}) {
  if (!measurementId || !analyticsEnabled) return
  if (!initialized || !window.gtag) { pending.push([name, parameters]); return }
  const clean = Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined))
  window.gtag('event', name, clean)
}

export function trackScreen(screenName: string) {
  track('screen_view', { screen_name: screenName })
}

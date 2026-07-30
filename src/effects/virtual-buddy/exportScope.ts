import type { BuddySnapshot } from './VirtualBuddyScene'
import type { VirtualBuddyParams } from './types'

/** 0 Full scene · 1 Effects */
export const EXPORT_SCOPE_OPTIONS = ['Full scene', 'Effects'] as const

export type ExportScopeIndex = 0 | 1
export type ExportScopeId = 'full' | 'effects'

export const EXPORT_SCOPE_IDS: ExportScopeId[] = ['full', 'effects']

/**
 * Headless consumer repos (no authoring control panel).
 * Full scene: 3D stage + physics + filters; UI is only the add-buddy button.
 * Effects: filter library only — no models, no stage chrome.
 *
 * Update these when the headless repos are created / renamed.
 */
export const EXPORT_REPO_URLS: Record<ExportScopeId, string> = {
  full: 'https://github.com/AdamBorthwick/ViggleBuddy-Scene',
  effects: 'https://github.com/AdamBorthwick/ViggleBuddy-Effects',
}

export const EXPORT_REPO_BLURBS: Record<ExportScopeId, string> = {
  full: 'Export 3D scene, physics and effects',
  effects: 'Filter library only — no 3D models, no stage UI.',
}

/** Path to replace in the headless repo with the downloaded settings file. */
export const EXPORT_SETTINGS_TARGET_PATH = 'src/virtualBuddyExport.ts'

export function scopeIdFromIndex(index: number): ExportScopeId {
  return EXPORT_SCOPE_IDS[Math.max(0, Math.min(1, Math.round(index)))] ?? 'full'
}

export function repoUrlForScope(scopeIndex: number): string {
  return EXPORT_REPO_URLS[scopeIdFromIndex(scopeIndex)]
}

export function repoBlurbForScope(scopeIndex: number): string {
  return EXPORT_REPO_BLURBS[scopeIdFromIndex(scopeIndex)]
}

const EFFECTS_KEYS = [
  'filter',
  'filterStrength',
  'colorIntensity',
  'gbPixelSize',
  'gbContrast',
  'gbDither',
  'gbGrid',
  'gbColor0',
  'gbColor1',
  'gbColor2',
  'gbColor3',
  'blEdgeThreshold',
  'blEdgeStrength',
  'blInkColor',
  'blPosterize',
  'blFillBoost',
  'ps1Resolution',
  'ps1Affine',
  'ps1Jitter',
  'ps1ColorDepth',
  'ps1Dither',
] as const satisfies readonly (keyof VirtualBuddyParams)[]

function pickKeys(
  params: VirtualBuddyParams,
  keys: readonly (keyof VirtualBuddyParams)[],
): Partial<VirtualBuddyParams> {
  const out: Partial<VirtualBuddyParams> = {}
  for (const key of keys) {
    out[key] = params[key]
  }
  return out
}

export type ExportPayload = {
  version: 1
  preset: string
  scope: ExportScopeId
  /** Headless repo to build from for this scope. */
  repo: string
  settings: Partial<VirtualBuddyParams> | VirtualBuddyParams
  buddies?: BuddySnapshot[]
}

export function buildExportPayload(args: {
  scopeIndex: number
  presetId: string
  params: VirtualBuddyParams
  buddies: BuddySnapshot[]
}): ExportPayload {
  const scope = scopeIdFromIndex(args.scopeIndex)
  const base: ExportPayload = {
    version: 1,
    preset: args.presetId,
    scope,
    repo: EXPORT_REPO_URLS[scope],
    settings:
      scope === 'effects'
        ? pickKeys(args.params, EFFECTS_KEYS)
        : { ...args.params },
  }

  if (scope === 'full') {
    base.buddies = args.buddies
  }

  return base
}

/**
 * TypeScript settings module — paste into the matching headless repo.
 * Build the app from the GitHub link for this scope; this file is config only.
 */
export function buildExportCode(args: {
  scopeIndex: number
  presetId: string
  params: VirtualBuddyParams
  buddies: BuddySnapshot[]
}): string {
  const payload = buildExportPayload(args)
  const stamp = new Date().toISOString()
  const body = JSON.stringify(payload, null, 2)
  const repo = payload.repo
  const target = EXPORT_SETTINGS_TARGET_PATH
  return `/**
 * Virtual Buddy settings export (${payload.scope})
 * Generated ${stamp}
 *
 * 1. Clone the headless app from:
 *    ${repo}
 * 2. Replace ${target} with this file (same export name).
 *
 * This is settings only — not the full codebase.
 * - effects: filter/look knobs (no models in that repo)
 * - full: scene settings + buddies (headless stage; UI is add button only)
 */

export const virtualBuddyExport = ${body} as const

export type VirtualBuddyExport = typeof virtualBuddyExport
`
}

export function exportFilename(scopeIndex: number, presetId: string): string {
  const scope = scopeIdFromIndex(scopeIndex)
  return `${presetId}-${scope}-settings.ts`
}

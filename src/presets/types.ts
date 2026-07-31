export type ControlKind = 'slider' | 'checkbox' | 'select' | 'color' | 'heading'

/**
 * Hide a control unless another numeric param matches.
 * Used for filter-specific knobs that only make sense on one look.
 */
export type ControlVisibility = {
  key: string
  /** Show when the value rounds to this. */
  equals?: number
  /** Show when the value does not round to this. */
  notEquals?: number
}

type ControlBase = {
  key: string
  label: string
  description?: string
  visibleWhen?: ControlVisibility
}

export type SliderControlDef = ControlBase & {
  kind: 'slider'
  min: number
  max: number
  step: number
  defaultValue: number
  /** Caption under the low end of the track. */
  lowLabel?: string
  /** Caption under the high end of the track. */
  highLabel?: string
}

export type CheckboxControlDef = ControlBase & {
  kind: 'checkbox'
  defaultValue: number
}

/**
 * Value is the option's index, keeping params a flat `Record<string, number>`
 * so nothing else in the preset infrastructure has to change.
 */
export type SelectControlDef = ControlBase & {
  kind: 'select'
  options: string[]
  defaultValue: number
  /** Optional copy for each option — shown for the current selection. */
  optionDescriptions?: string[]
}

/**
 * 24-bit sRGB packed as 0xRRGGBB (still a number so params stay flat).
 */
export type ColorControlDef = ControlBase & {
  kind: 'color'
  defaultValue: number
}

/**
 * Visual section label inside a control group — not a param.
 */
export type HeadingControlDef = ControlBase & {
  kind: 'heading'
}

export type ControlDef =
  | SliderControlDef
  | CheckboxControlDef
  | SelectControlDef
  | ColorControlDef
  | HeadingControlDef

/** Format a packed 0xRRGGBB for CSS / display. */
export function hexToCss(value: number): string {
  const hex = (Math.round(value) >>> 0).toString(16).padStart(6, '0').slice(-6)
  return `#${hex}`
}

/**
 * Parse a user-typed colour string into packed 0xRRGGBB.
 * Accepts `#rgb`, `#rrggbb`, bare hex, optional whitespace. Returns null if invalid.
 */
export function parseCssColor(value: string): number | null {
  const cleaned = value.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const r = cleaned[0]!
    const g = cleaned[1]!
    const b = cleaned[2]!
    const expanded = `${r}${r}${g}${g}${b}${b}`
    return Number.parseInt(expanded, 16) >>> 0
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return Number.parseInt(cleaned, 16) >>> 0
  }
  return null
}

/** Parse `#rrggbb` (or bare hex) into a packed 0xRRGGBB number. Falls back to 0. */
export function cssToHex(value: string): number {
  return parseCssColor(value) ?? 0
}

/** Expand packed 0xRRGGBB into linear-ish 0–1 RGB for shader uniforms. */
export function hexToRgb01(value: number): [number, number, number] {
  const v = Math.round(value) >>> 0
  const r = ((v >> 16) & 0xff) / 255
  const g = ((v >> 8) & 0xff) / 255
  const b = (v & 0xff) / 255
  return [r, g, b]
}

export function hexToRgb255(value: number): { r: number; g: number; b: number } {
  const v = Math.round(value) >>> 0
  return {
    r: (v >> 16) & 0xff,
    g: (v >> 8) & 0xff,
    b: v & 0xff,
  }
}

export function rgb255ToHex(r: number, g: number, b: number): number {
  const rr = Math.min(255, Math.max(0, Math.round(r)))
  const gg = Math.min(255, Math.max(0, Math.round(g)))
  const bb = Math.min(255, Math.max(0, Math.round(b)))
  return ((rr << 16) | (gg << 8) | bb) >>> 0
}

/** HSV in h∈[0,360), s/v∈[0,1]. */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
    else if (max === gn) h = ((bn - rn) / d + 2) * 60
    else h = ((rn - gn) / d + 4) * 60
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const hh = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = v - c
  let rp = 0
  let gp = 0
  let bp = 0
  if (hh < 60) {
    rp = c
    gp = x
  } else if (hh < 120) {
    rp = x
    gp = c
  } else if (hh < 180) {
    gp = c
    bp = x
  } else if (hh < 240) {
    gp = x
    bp = c
  } else if (hh < 300) {
    rp = x
    bp = c
  } else {
    rp = c
    bp = x
  }
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  }
}

export type ControlSection = {
  id: string
  title: string
  description?: string
  /** Hide the whole section unless a param matches. */
  visibleWhen?: ControlVisibility
  /**
   * Whether the section starts expanded. Defaults to true.
   * Secondary groups (Physics, Interaction) often start closed.
   */
  defaultOpen?: boolean
  /** Small header badge (e.g. active look name). */
  badge?: string
  controls: ControlDef[]
}

export function isControlVisible(
  visibleWhen: ControlVisibility | undefined,
  values: Record<string, number>,
): boolean {
  if (!visibleWhen) {
    return true
  }
  const value = Math.round(values[visibleWhen.key] ?? 0)
  if (visibleWhen.equals !== undefined && value !== visibleWhen.equals) {
    return false
  }
  if (visibleWhen.notEquals !== undefined && value === visibleWhen.notEquals) {
    return false
  }
  return true
}

export type PresetDefinition<TParams extends Record<string, number>> = {
  id: string
  name: string
  tagline: string
  defaults: TParams
  sections: ControlSection[]
}

export function buildDefaultParams<TParams extends Record<string, number>>(
  preset: PresetDefinition<TParams>,
): TParams {
  return { ...preset.defaults }
}

export function paramsFromControls<TParams extends Record<string, number>>(
  preset: PresetDefinition<TParams>,
  values: Record<string, number>,
): TParams {
  const next = { ...preset.defaults } as Record<string, number>
  // Apply every known default key from the live values map so controls that live
  // outside preset.sections (e.g. Max models in the Models panel) still stick.
  for (const key of Object.keys(preset.defaults)) {
    const value = values[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      next[key] = value
    }
  }
  for (const section of preset.sections) {
    for (const control of section.controls) {
      if (control.kind === 'heading') {
        continue
      }
      const value = values[control.key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        next[control.key] = value
      }
    }
  }
  return next as TParams
}

export function valuesFromParams<TParams extends Record<string, number>>(
  params: TParams,
): Record<string, number> {
  return { ...params }
}

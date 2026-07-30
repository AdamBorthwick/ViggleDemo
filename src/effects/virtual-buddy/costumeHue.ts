import type { CostumePartDef } from './models/registry'
import {
  hexToRgb255,
  hsvToRgb,
  rgb255ToHex,
  rgbToHsv,
} from '../../presets/types'

/**
 * Target look for random ninja suit tints: random hue, S/V from this swatch
 * so the cloth reads at a consistent mid brightness (#888db8).
 */
const NINJA_SUIT_BRIGHTNESS_REF = 0x888db8

/**
 * Randomise costume hues while keeping each part’s saturation and value.
 * Near-greys get a small saturation floor so hue is visible on dark suits.
 */
export function shiftHueKeepSV(hex: number, hue: number): number {
  const { r, g, b } = hexToRgb255(hex)
  const hsv = rgbToHsv(r, g, b)
  // Achromatic defaults need a floor so random hue still reads.
  const s = hsv.s < 0.08 ? 0.5 : hsv.s
  const next = hsvToRgb(hue, s, hsv.v)
  return rgb255ToHex(next.r, next.g, next.b)
}

/** Random hue at the S/V of #888db8 (mid cool grey-lilac brightness). */
function ninjaSuitRandomHue(hue: number): number {
  const { r, g, b } = hexToRgb255(NINJA_SUIT_BRIGHTNESS_REF)
  const { s, v } = rgbToHsv(r, g, b)
  const next = hsvToRgb(hue, s, v)
  return rgb255ToHex(next.r, next.g, next.b)
}

/**
 * Apply one shared random hue across costume parts.
 * Ninja: clothing (armor / suit) only — skin stays authored; suit brightness
 * matches #888db8 with a random hue.
 * Paladin / Dancer: no recolour parts (authored texture only).
 * Buddy solids: body + joints share the hue, each keeps own S/V.
 */
export function applyRandomCostumeHue(
  modelId: string,
  partDefs: CostumePartDef[],
  partColors: Record<string, number>,
): void {
  if (modelId === 'paladin' || partDefs.length === 0) {
    return
  }

  const hue = Math.random() * 360

  for (const part of partDefs) {
    if (part.channel === 'skin' || part.channel === 'emissive') {
      continue
    }
    if (modelId === 'ninja') {
      if (part.channel !== 'armor' && part.id !== 'suit') {
        continue
      }
      partColors[part.id] = ninjaSuitRandomHue(hue)
      continue
    }
    if (modelId === 'dancer') {
      // Shirt only — keep skin authored.
      if (part.id !== 'shirt' && part.channel !== 'armor') {
        continue
      }
      const base = part.defaultColor >>> 0
      partColors[part.id] = shiftHueKeepSV(base, hue)
      continue
    }
    if (
      part.channel !== 'albedo' &&
      part.channel !== 'armor' &&
      part.channel !== 'trim'
    ) {
      continue
    }

    const base = part.defaultColor >>> 0
    partColors[part.id] = shiftHueKeepSV(base, hue)
  }
}

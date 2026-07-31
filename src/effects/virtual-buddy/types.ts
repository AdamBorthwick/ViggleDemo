/**
 * Every value is a number so the existing preset infrastructure
 * (`PresetDefinition<TParams extends Record<string, number>>`) carries over
 * unchanged. Checkboxes, selects, and colours are numeric too — 0/1, option
 * index, and packed 0xRRGGBB.
 */
export type VirtualBuddyParams = {
  // Buddies
  maxBuddies: number
  bodyScale: number
  weight: number
  model: number
  motion: number

  // Physics
  gravity: number
  muscleTone: number
  jointLooseness: number
  bounce: number
  friction: number
  airDrag: number

  // Interaction
  grabStrength: number
  throwPower: number
  breakAwayPull: number

  // Scene
  cameraDistance: number
  cameraHeight: number
  playDepth: number
  brightness: number
  /** Packed 0xRRGGBB ground plane colour */
  groundColor: number
  /** Packed 0xRRGGBB colour for the rim directional light */
  leftLightColor: number
  /** Multiplier on base rim light intensity (1 = authored default). */
  rimLightStrength: number
  showPhysicsBodies: number
  /** Stage add-buddy button. Off gives a clean frame for capture. */
  showAddButton: number

  // Filters — shared
  /** 0 Off, 1 Game Boy, 2 Cartoon, 3 PS1 */
  filter: number
  filterStrength: number
  colorIntensity: number

  // Game Boy
  gbPixelSize: number
  gbContrast: number
  gbDither: number
  gbGrid: number
  /** Packed 0xRRGGBB palette — darkest → lightest */
  gbColor0: number
  gbColor1: number
  gbColor2: number
  gbColor3: number

  // Cartoon (param keys kept as bl* for stable exports)
  blEdgeThreshold: number
  blEdgeStrength: number
  /** Packed 0xRRGGBB outline colour */
  blInkColor: number
  blPosterize: number
  blFillBoost: number

  // PS1
  ps1Resolution: number
  ps1Affine: number
  ps1Jitter: number
  ps1ColorDepth: number
  ps1Dither: number
}

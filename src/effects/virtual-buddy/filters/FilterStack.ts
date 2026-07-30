import { NoBlending, Vector2, Vector3 } from 'three'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { hexToRgb01 } from '../../../presets/types'
import { VirtualBuddyFilterShader } from './shaders'
import type { VirtualBuddyParams } from '../types'

/** Order matches the Filter select control. Index 0 is Off. */
export const FILTER_OPTIONS = ['Off', 'Game Boy', 'Cartoon', 'PS1'] as const

export type FilterId = (typeof FILTER_OPTIONS)[number]

/**
 * One always-on ShaderPass after the beauty render. Mode 0 is a cheap copy so
 * the composer chain stays stable (no enable/disable buffer surprises).
 */
export class FilterStack {
  private readonly pass: ShaderPass
  private readonly resolution = new Vector2(1, 1)

  constructor(composer: EffectComposer) {
    this.pass = new ShaderPass(VirtualBuddyFilterShader)
    // Post materials must not tone-map or depth-test the fullscreen quad.
    this.pass.material.toneMapped = false
    this.pass.material.depthTest = false
    this.pass.material.depthWrite = false
    this.pass.material.blending = NoBlending
    composer.addPass(this.pass)
  }

  /**
   * @param width CSS (or logical) width passed to the composer
   * @param height CSS (or logical) height passed to the composer
   * @param pixelRatio renderer pixel ratio — composer buffers are width*dpr
   */
  setSize(width: number, height: number, pixelRatio = 1): void {
    const dpr = Math.max(1, pixelRatio)
    this.resolution.set(Math.max(1, width * dpr), Math.max(1, height * dpr))
    const uniform = this.pass.uniforms.resolution
    if (uniform?.value instanceof Vector2) {
      uniform.value.copy(this.resolution)
    } else if (uniform) {
      uniform.value = this.resolution.clone()
    }
  }

  sync(params: VirtualBuddyParams): void {
    const mode = Math.round(params.filter)
    this.set('mode', mode)
    this.set('strength', params.filterStrength)
    this.set('colorIntensity', params.colorIntensity)
    this.set('brightness', params.brightness)

    this.set('gbPixelSize', params.gbPixelSize)
    this.set('gbContrast', params.gbContrast)
    this.set('gbDither', params.gbDither)
    this.set('gbGrid', params.gbGrid)
    this.setColor('gbColor0', params.gbColor0)
    this.setColor('gbColor1', params.gbColor1)
    this.setColor('gbColor2', params.gbColor2)
    this.setColor('gbColor3', params.gbColor3)

    this.set('cartoonEdgeThreshold', params.blEdgeThreshold)
    this.set('cartoonEdgeStrength', params.blEdgeStrength)
    this.setColor('cartoonInkColor', params.blInkColor)
    this.set('cartoonPosterize', params.blPosterize)
    this.set('cartoonFillBoost', params.blFillBoost)

    this.set('ps1Resolution', params.ps1Resolution)
    this.set('ps1Affine', params.ps1Affine)
    this.set('ps1Jitter', params.ps1Jitter)
    this.set('ps1ColorDepth', params.ps1ColorDepth)
    this.set('ps1Dither', params.ps1Dither)
  }

  dispose(): void {
    this.pass.dispose()
  }

  private set(key: string, value: number): void {
    const uniform = this.pass.uniforms[key]
    if (uniform) {
      uniform.value = value
    }
  }

  private setColor(key: string, packed: number): void {
    const uniform = this.pass.uniforms[key]
    if (!uniform) {
      return
    }
    const [r, g, b] = hexToRgb01(packed)
    if (uniform.value instanceof Vector3) {
      uniform.value.set(r, g, b)
    } else {
      uniform.value = new Vector3(r, g, b)
    }
  }
}

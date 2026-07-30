import * as THREE from 'three'

export type CostumeTintUniforms = {
  uSkinTint: { value: THREE.Color }
  uArmorTint: { value: THREE.Color }
  /** 1 = split map into skin vs armour regions; 0 = full-mesh armour tint only. */
  uUseSkinSplit: { value: number }
}

const PATCHED = new WeakSet<THREE.MeshStandardMaterial>()

/**
 * Injects skin-vs-armour tinting into a MeshStandardMaterial.
 *
 * Mixamo Paladin/Ninja ship a single albedo with flesh + cloth/metal painted
 * together. A flat `material.color` multiply recolours everything; this path
 * classifies texels as skin-like and multiplies each region by its own tint.
 */
export function installCostumeTintShader(
  material: THREE.MeshStandardMaterial,
): CostumeTintUniforms {
  const existing = (material.userData.costumeTintUniforms ?? null) as
    | CostumeTintUniforms
    | null
  if (existing) {
    return existing
  }

  const uniforms: CostumeTintUniforms = {
    uSkinTint: { value: new THREE.Color(1, 1, 1) },
    uArmorTint: { value: new THREE.Color(1, 1, 1) },
    uUseSkinSplit: { value: 1 },
  }
  material.userData.costumeTintUniforms = uniforms

  if (PATCHED.has(material)) {
    return uniforms
  }
  PATCHED.add(material)

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSkinTint = uniforms.uSkinTint
    shader.uniforms.uArmorTint = uniforms.uArmorTint
    shader.uniforms.uUseSkinSplit = uniforms.uUseSkinSplit

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform vec3 uSkinTint;
        uniform vec3 uArmorTint;
        uniform float uUseSkinSplit;

        // Heuristic skin mask for Mixamo-style flesh painted into the albedo.
        float costumeSkinMask(vec3 c) {
          float maxc = max(c.r, max(c.g, c.b));
          float minc = min(c.r, min(c.g, c.b));
          // Flesh tends to be warm: R > G > B, moderate saturation, not black.
          float warm =
            step(0.12, c.r) *
            step(c.b + 0.02, c.g) *
            step(c.g + 0.01, c.r) *
            step(0.04, c.r - c.b) *
            step(c.r - c.g, 0.55);
          // Reject highly saturated cloth reds / pure metals.
          float sat = maxc > 1e-4 ? (maxc - minc) / maxc : 0.0;
          float notCloth = 1.0 - smoothstep(0.42, 0.62, sat);
          float notDark = smoothstep(0.08, 0.18, maxc);
          return clamp(warm * notCloth * notDark, 0.0, 1.0);
        }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        #ifdef USE_MAP
          // map_fragment already did: diffuseColor *= sampled map
          // Undo the material.color multiply baked into diffuseColor so we can
          // apply skin/armour tints separately, then re-apply brightness via
          // the base material.color (kept near white * stage lift).
          vec4 costumeSample = texture2D( map, vMapUv );
          float skinM = costumeSkinMask(costumeSample.rgb) * uUseSkinSplit;
          vec3 regionTint = mix(uArmorTint, uSkinTint, skinM);
          // diffuseColor currently ≈ map * material.color; replace with map * region * color
          diffuseColor.rgb = costumeSample.rgb * regionTint * diffuse;
        #endif
        `,
      )
  }

  material.needsUpdate = true
  return uniforms
}

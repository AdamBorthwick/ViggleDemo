import * as THREE from 'three'

export type CostumeTintUniforms = {
  uSkinTint: { value: THREE.Color }
  uArmorTint: { value: THREE.Color }
  uTrimTint: { value: THREE.Color }
  /** 1 = split map into skin vs armour; 0 = full mesh uses armour tint only. */
  uUseSkinSplit: { value: number }
  /** 1 = also classify orange / warm trim accents. */
  uUseTrimSplit: { value: number }
  /**
   * Armour-region classifier:
   * 0 = all non-skin (ninja suit), 1 = bright metal plate, 2 = yellow cloth (dancer shirt).
   */
  uArmorMode: { value: number }
  /** 1 = sample specularIntensityMap for plate isolation. */
  uUseSpecMap: { value: number }
  uSpecMap: { value: THREE.Texture | null }
}

const PATCHED = new WeakSet<THREE.MeshStandardMaterial>()

function resolveSpecularMap(
  material: THREE.MeshStandardMaterial,
): THREE.Texture | null {
  const physical = material as THREE.MeshPhysicalMaterial
  if (physical.specularIntensityMap?.isTexture) {
    return physical.specularIntensityMap
  }
  // Legacy / alternate slot some exports use.
  const legacy = (material as THREE.MeshStandardMaterial & {
    specularMap?: THREE.Texture | null
  }).specularMap
  if (legacy?.isTexture) {
    return legacy
  }
  return null
}

/**
 * Injects skin / armour / trim tinting into a MeshStandardMaterial.
 *
 * When a specular (KHR) map is present — Paladin ships `Paladin_specular` —
 * polished plate is isolated as high-specular × low-saturation texels, which
 * is far cleaner than diffuse-only heuristics. Skin / orange trim still use
 * colour rules on the albedo (specular alone does not separate flesh).
 *
 * Classification of albedo runs in sRGB (Three samples maps in linear).
 * Tints are absolute multipliers (1,1,1 = authored texture).
 */
export function installCostumeTintShader(
  material: THREE.MeshStandardMaterial,
): CostumeTintUniforms {
  const existing = (material.userData.costumeTintUniforms ?? null) as
    | CostumeTintUniforms
    | null
  if (existing) {
    // Refresh specular binding if the material gained a map after first install.
    const specMap = resolveSpecularMap(material)
    existing.uSpecMap.value = specMap
    existing.uUseSpecMap.value = specMap ? 1 : 0
    return existing
  }

  const specMap = resolveSpecularMap(material)

  const uniforms: CostumeTintUniforms = {
    uSkinTint: { value: new THREE.Color(1, 1, 1) },
    uArmorTint: { value: new THREE.Color(1, 1, 1) },
    uTrimTint: { value: new THREE.Color(1, 1, 1) },
    uUseSkinSplit: { value: 1 },
    uUseTrimSplit: { value: 0 },
    uArmorMode: { value: 0 },
    uUseSpecMap: { value: specMap ? 1 : 0 },
    uSpecMap: { value: specMap },
  }
  material.userData.costumeTintUniforms = uniforms

  if (PATCHED.has(material)) {
    return uniforms
  }
  PATCHED.add(material)

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSkinTint = uniforms.uSkinTint
    shader.uniforms.uArmorTint = uniforms.uArmorTint
    shader.uniforms.uTrimTint = uniforms.uTrimTint
    shader.uniforms.uUseSkinSplit = uniforms.uUseSkinSplit
    shader.uniforms.uUseTrimSplit = uniforms.uUseTrimSplit
    shader.uniforms.uArmorMode = uniforms.uArmorMode
    shader.uniforms.uUseSpecMap = uniforms.uUseSpecMap
    shader.uniforms.uSpecMap = uniforms.uSpecMap

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform vec3 uSkinTint;
        uniform vec3 uArmorTint;
        uniform vec3 uTrimTint;
        uniform float uUseSkinSplit;
        uniform float uUseTrimSplit;
        uniform float uArmorMode;
        uniform float uUseSpecMap;
        uniform sampler2D uSpecMap;

        // Region tint shared with emissive so lift matches diffuse recolour.
        vec3 costumeRegionTint = vec3( 1.0 );

        float costumeLinearToSrgb( float c ) {
          c = clamp( c, 0.0, 1.0 );
          return c <= 0.0031308
            ? 12.92 * c
            : 1.055 * pow( c, 1.0 / 2.4 ) - 0.055;
        }

        vec3 costumeToSrgb( vec3 c ) {
          return vec3(
            costumeLinearToSrgb( c.r ),
            costumeLinearToSrgb( c.g ),
            costumeLinearToSrgb( c.b )
          );
        }

        // Greyscale specular atlas (Mixamo / KHR specularTexture). Prefer RGB
        // luma — Three's lighting path reads .a, but these PNGs store detail in RGB.
        float costumeSampleSpec( vec2 uv ) {
          vec4 s = texture2D( uSpecMap, uv );
          float rgbLuma = max( s.r, max( s.g, s.b ) );
          // If RGB is empty but alpha carries intensity, fall back.
          return rgbLuma > 1e-4 ? rgbLuma : s.a;
        }

        // Orange / copper trim from albedo (specular is near-zero on trim).
        float costumeTrimMask( vec3 srgb ) {
          float r = srgb.r;
          float g = srgb.g;
          float b = srgb.b;
          float maxc = max( r, max( g, b ) );
          float minc = min( r, min( g, b ) );
          float chroma = maxc - minc;
          float sat = maxc > 1e-4 ? chroma / maxc : 0.0;

          float copper =
            smoothstep( 0.16, 0.28, r ) *
            smoothstep( 0.08, 0.2, g ) *
            ( 1.0 - smoothstep( 0.12, 0.32, b ) ) *
            smoothstep( 0.08, 0.18, r - g ) *
            smoothstep( 0.14, 0.24, r - b ) *
            smoothstep( 0.32, 0.5, sat ) *
            ( 1.0 - smoothstep( 0.7, 0.92, maxc ) );

          float orange =
            smoothstep( 0.28, 0.42, r ) *
            smoothstep( 0.12, 0.28, g ) *
            ( 1.0 - smoothstep( 0.15, 0.35, b ) ) *
            smoothstep( 0.04, 0.14, r - g ) *
            smoothstep( 0.16, 0.3, r - b ) *
            smoothstep( 0.28, 0.48, sat );

          return clamp( smoothstep( 0.12, 0.4, max( copper, orange ) ), 0.0, 1.0 );
        }

        // Flesh (albedo). Specular alone cannot separate skin — face often has
        // high specular too — so colour rules stay primary.
        float costumeSkinMask( vec3 srgb ) {
          float r = srgb.r;
          float g = srgb.g;
          float b = srgb.b;
          float maxc = max( r, max( g, b ) );
          float minc = min( r, min( g, b ) );
          float chroma = maxc - minc;
          float sat = maxc > 1e-4 ? chroma / maxc : 0.0;
          float warmRB = r - b;
          float warmRG = r - g;
          float warmGB = g - b;

          float rulePaladin =
            smoothstep( 0.22, 0.34, r ) *
            smoothstep( 0.16, 0.28, g ) *
            smoothstep( 0.12, 0.24, b ) *
            smoothstep( 0.04, 0.1, warmRB ) *
            smoothstep( -0.02, 0.08, warmRG ) *
            smoothstep( -0.04, 0.06, warmGB ) *
            smoothstep( 0.12, 0.22, sat ) *
            ( 1.0 - smoothstep( 0.42, 0.58, sat ) );

          float ruleLight =
            smoothstep( 0.4, 0.55, r ) *
            smoothstep( 0.28, 0.45, g ) *
            smoothstep( 0.22, 0.42, b ) *
            smoothstep( 0.05, 0.14, warmRB ) *
            smoothstep( -0.02, 0.12, warmRG ) *
            smoothstep( 0.08, 0.2, sat ) *
            ( 1.0 - smoothstep( 0.45, 0.65, sat ) );

          float ruleWarm =
            smoothstep( 0.2, 0.32, maxc ) *
            ( 1.0 - smoothstep( 0.88, 0.98, maxc ) ) *
            smoothstep( 0.05, 0.12, warmRB ) *
            smoothstep( -0.04, 0.1, warmRG ) *
            smoothstep( 0.06, 0.14, sat ) *
            ( 1.0 - smoothstep( 0.48, 0.68, sat ) );

          float notBlack = smoothstep( 0.12, 0.22, maxc );
          float notGrey = smoothstep( 0.05, 0.12, chroma );
          float notCool =
            1.0 - smoothstep( 0.01, 0.06, b - r ) * smoothstep( 0.01, 0.06, b - g );
          float notTrimOrange =
            1.0 - smoothstep( 0.45, 0.65, sat ) * smoothstep( 0.14, 0.24, warmRB );
          // Reject saturated yellow cloth (dancer shirt) from flesh.
          float notYellow =
            1.0 -
            smoothstep( 0.4, 0.58, sat ) *
              smoothstep( 0.12, 0.24, r - g ) *
              smoothstep( 0.1, 0.22, g - b );

          float skin =
            max( rulePaladin, max( ruleLight, ruleWarm ) ) *
            notBlack * notGrey * notCool * notTrimOrange * notYellow;

          return clamp( smoothstep( 0.08, 0.32, skin ), 0.0, 1.0 );
        }

        // Dancer yellow shirt (atlas mean ~0.84, 0.58, 0.30).
        float costumeYellowClothMask( vec3 srgb ) {
          float r = srgb.r;
          float g = srgb.g;
          float b = srgb.b;
          float maxc = max( r, max( g, b ) );
          float minc = min( r, min( g, b ) );
          float sat = maxc > 1e-4 ? ( maxc - minc ) / maxc : 0.0;

          float yellow =
            smoothstep( 0.55, 0.72, r ) *
            smoothstep( 0.4, 0.52, g ) *
            ( 1.0 - smoothstep( 0.28, 0.45, b ) ) *
            smoothstep( 0.12, 0.24, r - g ) *
            smoothstep( 0.1, 0.22, g - b ) *
            smoothstep( 0.35, 0.52, sat );

          return clamp( smoothstep( 0.12, 0.4, yellow ), 0.0, 1.0 );
        }

        // Diffuse-only fallback for bright plate midtones.
        float costumeArmorBrightFromAlbedo( vec3 srgb ) {
          float r = srgb.r;
          float g = srgb.g;
          float b = srgb.b;
          float maxc = max( r, max( g, b ) );
          float minc = min( r, min( g, b ) );
          float chroma = maxc - minc;
          float sat = maxc > 1e-4 ? chroma / maxc : 0.0;
          float luma = 0.299 * r + 0.587 * g + 0.114 * b;

          float lowSat = 1.0 - smoothstep( 0.06, 0.2, sat );
          float midBright =
            smoothstep( 0.16, 0.26, luma ) *
            ( 1.0 - smoothstep( 0.72, 0.92, luma ) );
          float neutral =
            1.0 - smoothstep( 0.06, 0.14, abs( r - g ) ) *
                  smoothstep( 0.06, 0.14, abs( g - b ) );

          return clamp( lowSat * midBright * neutral, 0.0, 1.0 );
        }

        // Specular × low-sat isolates polished steel on Paladin with almost no
        // skin/trim bleed (validated against the authored atlas).
        float costumeArmorBrightMask( vec3 srgb, float specLuma ) {
          float maxc = max( srgb.r, max( srgb.g, srgb.b ) );
          float minc = min( srgb.r, min( srgb.g, srgb.b ) );
          float sat = maxc > 1e-4 ? ( maxc - minc ) / maxc : 0.0;
          float lowSat = 1.0 - smoothstep( 0.06, 0.18, sat );

          float fromSpec =
            smoothstep( 0.35, 0.55, specLuma ) * lowSat;

          float fromAlbedo = costumeArmorBrightFromAlbedo( srgb );

          // Prefer specular when available; keep a little albedo as fill.
          return mix(
            fromAlbedo,
            max( fromSpec, fromAlbedo * 0.25 ),
            uUseSpecMap
          );
        }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        #ifdef USE_MAP
          vec4 costumeSample = texture2D( map, vMapUv );
          #ifdef DECODE_VIDEO_TEXTURE
            costumeSample = sRGBTransferEOTF( costumeSample );
          #endif

          vec3 srgb = costumeToSrgb( costumeSample.rgb );

          float specLuma = 0.0;
          if ( uUseSpecMap > 0.5 ) {
            specLuma = costumeSampleSpec( vMapUv );
          }

          float trimM = costumeTrimMask( srgb ) * uUseTrimSplit;
          float skinM = costumeSkinMask( srgb ) * uUseSkinSplit;
          // Specular plate (high spec, low sat) should never count as skin.
          if ( uUseSpecMap > 0.5 ) {
            float maxc = max( srgb.r, max( srgb.g, srgb.b ) );
            float minc = min( srgb.r, min( srgb.g, srgb.b ) );
            float sat = maxc > 1e-4 ? ( maxc - minc ) / maxc : 0.0;
            float plateLike =
              smoothstep( 0.45, 0.65, specLuma ) *
              ( 1.0 - smoothstep( 0.08, 0.2, sat ) );
            skinM *= ( 1.0 - plateLike );
          }
          // Yellow cloth owns those texels over skin when shirt mode is on.
          float yellowM =
            uArmorMode > 1.5 ? costumeYellowClothMask( srgb ) : 0.0;
          skinM *= ( 1.0 - yellowM );
          skinM *= ( 1.0 - trimM );

          // Armour region by mode:
          // 0 ninja suit = all non-skin, 1 metal plate, 2 yellow shirt only.
          float bodyM = ( 1.0 - skinM ) * ( 1.0 - trimM );
          float brightM = costumeArmorBrightMask( srgb, specLuma );
          float armorM = bodyM;
          if ( uArmorMode > 1.5 ) {
            armorM = yellowM * ( 1.0 - trimM );
          } else if ( uArmorMode > 0.5 || uUseTrimSplit > 0.5 ) {
            armorM = bodyM * brightM;
          }

          vec3 regionTint = mix( vec3( 1.0 ), uArmorTint, armorM );
          regionTint = mix( regionTint, uSkinTint, skinM );
          regionTint = mix( regionTint, uTrimTint, trimM );
          costumeRegionTint = regionTint;

          diffuseColor.rgb = costumeSample.rgb * regionTint * diffuse;
        #endif
        `,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
        #include <emissivemap_fragment>
        #ifdef USE_EMISSIVEMAP
          totalEmissiveRadiance *= costumeRegionTint;
        #endif
        `,
      )
  }

  material.customProgramCacheKey = () =>
    `costume-tint-v9-yellow-${specMap ? '1' : '0'}`
  material.needsUpdate = true
  return uniforms
}

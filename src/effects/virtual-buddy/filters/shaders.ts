/**
 * Single full-screen post shader for Virtual Buddy.
 *
 * mode: 0 = off (copy), 1 = Game Boy, 2 = Cartoon, 3 = PS1
 *
 * Shared knobs: strength, colorIntensity, brightness
 * Per-look knobs are packed into generic slots and remapped in FilterStack.
 */

import { Vector2, Vector3 } from 'three'

export const VirtualBuddyFilterShader = {
  name: 'VirtualBuddyFilter',
  uniforms: {
    tDiffuse: { value: null as unknown },
    resolution: { value: new Vector2(1, 1) },
    mode: { value: 0 },
    strength: { value: 1 },
    colorIntensity: { value: 1 },
    brightness: { value: 1 },
    // Game Boy
    gbPixelSize: { value: 5 },
    gbContrast: { value: 1.25 },
    gbDither: { value: 0.4 },
    gbGrid: { value: 0.25 },
    gbColor0: { value: new Vector3(0.06, 0.22, 0.06) },
    gbColor1: { value: new Vector3(0.19, 0.38, 0.19) },
    gbColor2: { value: new Vector3(0.55, 0.68, 0.06) },
    gbColor3: { value: new Vector3(0.61, 0.74, 0.06) },
    // Cartoon
    cartoonEdgeThreshold: { value: 0.15 },
    cartoonEdgeStrength: { value: 0.45 },
    cartoonInkColor: { value: new Vector3(0.04, 0.04, 0.04) },
    cartoonPosterize: { value: 4 },
    cartoonFillBoost: { value: 0.45 },
    // PS1
    ps1Resolution: { value: 180 },
    ps1Affine: { value: 0.55 },
    ps1Jitter: { value: 0.35 },
    ps1ColorDepth: { value: 5 },
    ps1Dither: { value: 0.55 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float mode;
    uniform float strength;
    uniform float colorIntensity;
    uniform float brightness;

    uniform float gbPixelSize;
    uniform float gbContrast;
    uniform float gbDither;
    uniform float gbGrid;
    uniform vec3 gbColor0;
    uniform vec3 gbColor1;
    uniform vec3 gbColor2;
    uniform vec3 gbColor3;

    uniform float cartoonEdgeThreshold;
    uniform float cartoonEdgeStrength;
    uniform vec3 cartoonInkColor;
    uniform float cartoonPosterize;
    uniform float cartoonFillBoost;

    uniform float ps1Resolution;
    uniform float ps1Affine;
    uniform float ps1Jitter;
    uniform float ps1ColorDepth;
    uniform float ps1Dither;

    varying vec2 vUv;

    float luma(vec3 c) {
      return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }

    // --- Game Boy -----------------------------------------------------------

    vec3 gameBoy(vec3 original) {
      float px = max(1.0, gbPixelSize);
      // Integer cell count so every LCD pixel is the same size.
      vec2 cells = max(floor(resolution / px), vec2(1.0));
      vec2 cell = min(floor(vUv * cells), cells - 1.0);
      vec2 uv = (cell + 0.5) / cells;

      vec3 sampleCol = texture2D(tDiffuse, uv).rgb;
      float lum = luma(sampleCol);
      // Scene is linear + often dark — expand midtones so the 4 shades populate
      lum = pow(clamp(lum, 0.0, 1.0), 0.65);
      lum = clamp((lum - 0.5) * gbContrast + 0.5, 0.0, 1.0);

      // Cheap 2x2 dither
      float checker = mod(cell.x + cell.y, 2.0);
      lum = clamp(lum + (checker - 0.5) * gbDither * 0.2, 0.0, 1.0);

      // Hard 4-level quantize against designer palette
      float band = floor(lum * 3.999);
      vec3 shade = gbColor0;
      if (band > 0.5) shade = gbColor1;
      if (band > 1.5) shade = gbColor2;
      if (band > 2.5) shade = gbColor3;

      float greyLevel = band / 3.0;
      vec3 grey = vec3(greyLevel);
      float ci = clamp(colorIntensity, 0.0, 2.0);
      vec3 paletted = mix(grey, shade, clamp(ci, 0.0, 1.0));
      if (ci > 1.0) {
        paletted *= 1.0 + (ci - 1.0) * 0.35;
      }

      // Thin 1-buffer-pixel seams
      vec2 local = vUv * cells - cell;
      float seam = 1.0 / max(px, 1.0);
      float lineX = 1.0 - smoothstep(0.0, seam, min(local.x, 1.0 - local.x));
      float lineY = 1.0 - smoothstep(0.0, seam, min(local.y, 1.0 - local.y));
      float line = max(lineX, lineY);
      paletted *= 1.0 - line * clamp(gbGrid, 0.0, 1.0) * 0.65;

      return paletted;
    }

    // --- Cartoon (ink + cel) -------------------------------------------------

    float sobelLuma(vec2 uv, vec2 texel) {
      float tl = luma(texture2D(tDiffuse, uv + texel * vec2(-1.0,  1.0)).rgb);
      float t  = luma(texture2D(tDiffuse, uv + texel * vec2( 0.0,  1.0)).rgb);
      float tr = luma(texture2D(tDiffuse, uv + texel * vec2( 1.0,  1.0)).rgb);
      float l  = luma(texture2D(tDiffuse, uv + texel * vec2(-1.0,  0.0)).rgb);
      float r  = luma(texture2D(tDiffuse, uv + texel * vec2( 1.0,  0.0)).rgb);
      float bl = luma(texture2D(tDiffuse, uv + texel * vec2(-1.0, -1.0)).rgb);
      float b  = luma(texture2D(tDiffuse, uv + texel * vec2( 0.0, -1.0)).rgb);
      float br = luma(texture2D(tDiffuse, uv + texel * vec2( 1.0, -1.0)).rgb);
      float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
      float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
      return length(vec2(gx, gy));
    }

    vec3 cartoon(vec3 original) {
      vec2 texel = 1.0 / max(resolution, vec2(1.0));
      // Ink strength = stroke weight: wider kernel + lower threshold = heavier lines.
      float weight = clamp(cartoonEdgeStrength, 0.0, 1.0);
      float kernel = mix(0.55, 2.6, weight);
      float thr = max(0.02, cartoonEdgeThreshold) * mix(1.55, 0.45, weight);
      float edge = sobelLuma(vUv, texel * kernel);
      float inkMask = smoothstep(thr * 0.3, thr * 1.1, edge);
      // Coverage rises with weight so thin settings stay wispy, heavy settings solid.
      float ink = clamp(inkMask * mix(0.25, 1.0, weight), 0.0, 1.0);

      float levels = max(2.0, cartoonPosterize);
      vec3 g = pow(max(original, vec3(0.0)), vec3(0.7));
      vec3 fill = floor(g * levels + 0.001) / max(levels - 1.0, 1.0);
      fill = pow(fill, vec3(1.0 / 0.7));

      float lum = luma(fill);
      vec3 grey = vec3(lum);
      float ci = clamp(colorIntensity, 0.0, 2.0);
      fill = mix(grey, fill, clamp(ci, 0.0, 1.0));
      fill *= 1.0 + cartoonFillBoost * 0.8;
      if (ci > 1.0) {
        fill = mix(fill, fill + (fill - grey) * (ci - 1.0), 0.75);
      }
      fill = clamp(fill, 0.0, 1.0);

      return mix(fill, cartoonInkColor, ink);
    }

    // --- PS1 ----------------------------------------------------------------

    float bayer4(vec2 p) {
      vec2 lo = mod(floor(p), 2.0);
      float b2 = lo.x + lo.y * 2.0;
      float m2 = b2 < 0.5 ? 0.0 : b2 < 1.5 ? 2.0 : b2 < 2.5 ? 3.0 : 1.0;
      vec2 hi = mod(floor(p * 0.5), 2.0);
      float b2h = hi.x + hi.y * 2.0;
      float m2h = b2h < 0.5 ? 0.0 : b2h < 1.5 ? 2.0 : b2h < 2.5 ? 3.0 : 1.0;
      return (m2 * 4.0 + m2h) / 16.0;
    }

    vec3 ps1(vec3 original) {
      // Virtual framebuffer. 240 ≈ NTSC height of the common 320×240 mode.
      float resY = max(48.0, ps1Resolution);
      float aspect = max(resolution.x, 1.0) / max(resolution.y, 1.0);
      vec2 res = vec2(resY * aspect, resY);

      vec2 uv = vUv;

      // Affine texture mapping: shear grows with distance from centre, stronger
      // on the horizontal (floor/wall stretch) — the PS1 did not correct this.
      float ay = (uv.y - 0.5);
      float ax = (uv.x - 0.5);
      float warp = ps1Affine * 0.16;
      uv.x += ay * ay * ax * warp * 4.0;
      uv.y += ax * ax * ay * warp * 1.2;
      // Mild horizontal swim on the upper half (common read of affine polys)
      uv.x += ay * ax * ps1Affine * 0.08;

      // Fixed-point-ish vertex quantisation on the coarse grid
      vec2 cell = floor(uv * res);
      float j = ps1Jitter * 0.008;
      uv.x += (mod(cell.y * 2.0 + cell.x, 4.0) - 1.5) * j * 0.5;
      uv.y += (mod(cell.x * 2.0 + cell.y, 4.0) - 1.5) * j * 0.35;

      // Nearest-neighbour sample into the virtual framebuffer
      vec2 snapped = (floor(uv * res) + 0.5) / res;
      snapped = clamp(snapped, 0.0, 1.0);

      vec3 col = texture2D(tDiffuse, snapped).rgb;

      // 15-bit-style quantise with ordered dither (PS1's usual display path)
      float bits = clamp(ps1ColorDepth, 2.0, 8.0);
      float levels = pow(2.0, bits) - 1.0;
      // Dither scale matches one LSB so 0.7–0.8 fills banding without noise soup
      float d = (bayer4(cell) - 0.5) * ps1Dither * (1.0 / max(levels, 1.0)) * levels;
      col = floor(col * levels + d + 0.5) / levels;

      // Slightly muted grade — early 3D was rarely fully saturated
      float lum = luma(col);
      float ci = clamp(colorIntensity, 0.0, 2.0);
      float sat = mix(0.0, 0.92, clamp(ci, 0.0, 1.0));
      col = mix(vec3(lum), col, sat);
      if (ci > 1.0) {
        col = mix(col, col + (col - vec3(lum)) * (ci - 1.0), 0.55);
      }

      // Soft black crush + slightly lifted mids (TV / composite era)
      col = pow(clamp(col, 0.0, 1.0), vec3(1.05));
      col = col * 0.96 + 0.02;

      return clamp(col, 0.0, 1.0);
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      float m = floor(mode + 0.5);
      float gain = max(brightness, 0.0);

      // mode 0: unfiltered scene — still apply brightness
      if (m < 0.5) {
        gl_FragColor = vec4(src.rgb * gain, src.a);
        return;
      }

      vec3 filtered = src.rgb;
      if (m < 1.5) {
        filtered = gameBoy(src.rgb);
      } else if (m < 2.5) {
        filtered = cartoon(src.rgb);
      } else {
        filtered = ps1(src.rgb);
      }

      vec3 outCol = mix(src.rgb, filtered, clamp(strength, 0.0, 1.0));
      outCol *= gain;
      gl_FragColor = vec4(outCol, src.a);
    }
  `,
}

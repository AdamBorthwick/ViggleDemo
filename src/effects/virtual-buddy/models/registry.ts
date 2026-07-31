import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { buildMixamoRig } from '../rigs/mixamo'
import type { RigDefinition } from '../rigs/types'

/** A recolourable region of a character (mesh group or material channel). */
export type CostumePartDef = {
  id: string
  label: string
  /** Case-insensitive match against mesh or material names. */
  match: string
  /**
   * `albedo` — full mesh / solid colour.
   * `armor` / `skin` / `trim` — split a shared albedo map (Paladin, Ninja).
   * `emissive` — glow accents on single-texture meshes.
   */
  channel: 'albedo' | 'armor' | 'skin' | 'trim' | 'emissive'
  /** Packed 0xRRGGBB default for the Models panel and spawn. */
  defaultColor: number
}

export type ModelEntry = {
  id: string
  label: string
  /** null renders the physics capsules directly — no asset needed. */
  url: string | null
  /** Linear material multiplier for assets authored darker than the stage. */
  brightness?: number
  /** Adds the albedo map back as soft unshadowed fill for realistic assets. */
  emissiveLift?: number
  /**
   * Multiplier on KHR / physical specular intensity (1 = authored, 0.8 = −20%).
   */
  specularScale?: number
  /**
   * Primary costume colour (0xRRGGBB) — chip colour and fallback default tint.
   */
  defaultColor?: number
  /** Per-region colour controls for the Models panel. */
  parts?: CostumePartDef[]
  /**
   * Clip name that should replace the standard "Dance" performance for this
   * character (e.g. a unique choreography packaged as `dance2`).
   */
  preferredDanceClip?: string
  /**
   * Clip names whose hips X/Z travel should be frozen so the body stays planted
   * while the limbs still play the authored motion.
   */
  pinRootClips?: string[]
}

/**
 * Order is the option order in the Model control, so index 0 is the default.
 * Only textured character assets — physics capsules are a debug overlay, not
 * a selectable model.
 */
export const MODELS: ModelEntry[] = [
  {
    id: 'buddy',
    label: 'Buddy',
    url: `${import.meta.env.BASE_URL}models/xbot.glb`,
    // Brief brand green #00E05A, slightly desaturated (cool mid tone).
    defaultColor: 0x2db86a,
    parts: [
      {
        id: 'body',
        label: 'Body',
        match: 'surface|body|alpha_body|alpha_surface',
        channel: 'albedo',
        defaultColor: 0x2db86a,
      },
      {
        id: 'joints',
        label: 'Joints',
        match: 'joint',
        channel: 'albedo',
        defaultColor: 0x1a4d32,
      },
    ],
  },
  {
    id: 'buddy-f',
    label: 'Buddy F',
    url: `${import.meta.env.BASE_URL}models/xbotf.glb`,
    // Same hue family as #00E05A, lighter / softer saturation for contrast.
    defaultColor: 0x5fd489,
    parts: [
      {
        id: 'body',
        label: 'Body',
        match: 'surface|body|highlimbs|beta_high|beta_surface',
        channel: 'albedo',
        defaultColor: 0x5fd489,
      },
      {
        id: 'joints',
        label: 'Joints',
        match: 'joint',
        channel: 'albedo',
        defaultColor: 0x2a5c3e,
      },
    ],
  },
  {
    id: 'ninja',
    label: 'Ninja',
    url: `${import.meta.env.BASE_URL}models/ninja.glb`,
    brightness: 3.4,
    emissiveLift: 0.9,
    specularScale: 0.8,
    defaultColor: 0x2a2e36,
    // One body atlas: skin vs cloth via shader mask.
    parts: [
      {
        id: 'suit',
        label: 'Suit',
        match: 'ch24|body|mesh',
        channel: 'armor',
        defaultColor: 0x2a2e36,
      },
      {
        id: 'skin',
        label: 'Skin',
        match: 'ch24|body|mesh',
        channel: 'skin',
        defaultColor: 0xe0b090,
      },
    ],
  },
  {
    id: 'paladin',
    label: 'Paladin',
    url: `${import.meta.env.BASE_URL}models/paladin.glb`,
    brightness: 3.1,
    emissiveLift: 0.8,
    defaultColor: 0x6a7a8c,
    // Authored costume only — no per-region recolour controls.
  },
  {
    id: 'dancer',
    label: 'Dancer',
    url: `${import.meta.env.BASE_URL}models/dancer.glb`,
    brightness: 2.8,
    emissiveLift: 0.7,
    specularScale: 0.8,
    defaultColor: 0xd6944d,
    // Unique choreography is exported as `dance2`; promote it to Dance and
    // freeze hips travel so she does not walk forward while performing.
    preferredDanceClip: 'dance2',
    pinRootClips: ['dance2', 'Dance'],
    // Body atlas: yellow shirt vs flesh via costume yellow mask (shirt id).
    parts: [
      {
        id: 'shirt',
        label: 'Shirt',
        match: 'ch02_body|body|cloth',
        channel: 'armor',
        defaultColor: 0xd6944d,
      },
      {
        id: 'skin',
        label: 'Skin',
        match: 'ch02_body|body',
        channel: 'skin',
        defaultColor: 0xe8b89a,
      },
    ],
  },
]

export type ClipKind = 'idle' | 'gesture' | 'recovery' | 'locomotion' | 'social'

/**
 * Behaviour attached to a named Mixamo clip.
 *
 * Scene logic keys off these flags rather than hard-coding clip names, so a
 * second get-up or a new social clip only needs a line here.
 */
export type ClipMeta = {
  name: string
  kind: ClipKind
  /** One-shot rather than looping. */
  once?: boolean
  /** Carry authored hips travel through space (lying → standing). */
  followRoot?: boolean
  /** Recovery from a knockdown / limp state. */
  recovery?: boolean
  /** Driven by Auto only — not offered as a manual Motion option. */
  autoOnly?: boolean
}

export const CLIPS: ClipMeta[] = [
  { name: 'Idle', kind: 'idle' },
  { name: 'Dance', kind: 'gesture' },
  { name: 'Wave', kind: 'gesture' },
  {
    name: 'Getting Up',
    kind: 'recovery',
    once: true,
    followRoot: true,
    recovery: true,
  },
  {
    name: 'Get Up 2',
    kind: 'recovery',
    once: true,
    followRoot: true,
    recovery: true,
  },
  // Scene navigation advances the stage anchor; the clip itself stays in place.
  { name: 'Walk', kind: 'locomotion', autoOnly: true },
  { name: 'Turn45', kind: 'locomotion', once: true, autoOnly: true },
  { name: 'Turn45Left', kind: 'locomotion', once: true, autoOnly: true },
  { name: 'Turn90', kind: 'locomotion', once: true, autoOnly: true },
  { name: 'Turn90Left', kind: 'locomotion', once: true, autoOnly: true },
  { name: 'Shake Hands', kind: 'social', once: true, autoOnly: true },
]

const CLIP_BY_NAME = new Map(CLIPS.map((clip) => [clip.name, clip]))

export function clipMeta(name: string | null | undefined): ClipMeta | undefined {
  if (!name) {
    return undefined
  }
  return CLIP_BY_NAME.get(name)
}

export function isRecoveryClip(name: string | null | undefined): boolean {
  return Boolean(clipMeta(name)?.recovery)
}

export function recoveryClipNames(): string[] {
  return CLIPS.filter((clip) => clip.recovery).map((clip) => clip.name)
}

/** Picks either get-up so a crowd does not all recover the same way. */
export function pickRecoveryClip(): string {
  const names = recoveryClipNames()
  return names[Math.floor(Math.random() * names.length)] ?? 'Getting Up'
}

/**
 * Motion options in control order. Index 0 is free ragdoll — no clip at all.
 *
 * Clips are matched by name against whatever the loaded model carries, so a
 * character missing one leaves that option inert rather than breaking. The list
 * is static because control options are declared in the preset at module load;
 * adding a clip to the GLB means adding a line here.
 */
export type MotionEntry = {
  label: string
  clip: string | null
  /** Chooses clips contextually and recovers after interaction. */
  auto?: boolean
}

export const MOTIONS: MotionEntry[] = [
  { label: 'Ragdoll', clip: null },
  { label: 'Auto', clip: null, auto: true },
  { label: 'Idle', clip: 'Idle' },
  { label: 'Dance', clip: 'Dance' },
  { label: 'Wave', clip: 'Wave' },
  { label: 'Get up', clip: 'Getting Up' },
  { label: 'Get up 2', clip: 'Get Up 2' },
]

export type LoadedModel = {
  /** Template to clone per buddy — never added to the scene itself. */
  scene: THREE.Group
  rig: RigDefinition
  /** Uniform scale that brings the model to 1.7m. */
  normalisation: number
  /** Model-space point moved to the world origin (floor, between the feet). */
  offset: THREE.Vector3
  clips: THREE.AnimationClip[]
  /**
   * Primary costume colour (0xRRGGBB) for list chips / fallbacks.
   */
  defaultTint: number
  /** Costume regions exposed in the Models panel. */
  parts: CostumePartDef[]
}

const cache = new Map<string, Promise<LoadedModel>>()

/**
 * Anything shorter than this is an export artefact rather than a real clip.
 * Blender emits a near-zero-length bind/T-pose track alongside the real
 * animations; filtering on duration rather than name survives a rename.
 */
const MIN_CLIP_SECONDS = 0.2

/**
 * Reflects a Mixamo clip across the character's X axis.
 *
 * Negating a quaternion does not mirror it (`q` and `-q` are the same
 * rotation). A real reflection swaps Left/Right tracks, negates X translation,
 * and conjugates rotations by the reflection matrix: (x,y,z,w) ->
 * (x,-y,-z,w).
 */
function mirrorMixamoClip(source: THREE.AnimationClip, name: string): THREE.AnimationClip {
  const tracks = source.tracks.map((sourceTrack) => {
    const track = sourceTrack.clone()
    track.name = track.name
      .replace(/Left/g, '__MIRROR_SIDE__')
      .replace(/Right/g, 'Left')
      .replace(/__MIRROR_SIDE__/g, 'Right')

    if (track.name.endsWith('.position')) {
      for (let i = 0; i < track.values.length; i += 3) {
        track.values[i] = -track.values[i]
      }
    } else if (track.name.endsWith('.quaternion')) {
      for (let i = 0; i < track.values.length; i += 4) {
        track.values[i + 1] = -track.values[i + 1]
        track.values[i + 2] = -track.values[i + 2]
      }
    }
    return track
  })
  return new THREE.AnimationClip(name, source.duration, tracks)
}

/** Keeps turn footwork but lets the scene own exact heading and stage position. */
function stripTurnRootMotion(source: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = source.tracks.map((sourceTrack) => {
    const track = sourceTrack.clone()
    if (!track.name.includes('Hips')) {
      return track
    }

    if (track.name.endsWith('.position') && track.values.length >= 3) {
      const x = track.values[0]
      const z = track.values[2]
      for (let i = 0; i < track.values.length; i += 3) {
        track.values[i] = x
        track.values[i + 2] = z
      }
    } else if (track.name.endsWith('.quaternion') && track.values.length >= 4) {
      const x = track.values[0]
      const y = track.values[1]
      const z = track.values[2]
      const w = track.values[3]
      for (let i = 0; i < track.values.length; i += 4) {
        track.values[i] = x
        track.values[i + 1] = y
        track.values[i + 2] = z
        track.values[i + 3] = w
      }
    }
    return track
  })
  return new THREE.AnimationClip(source.name, source.duration, tracks)
}

/**
 * Freezes hips X/Z at the first frame so a clip that walks forward still plays
 * in place. Keeps Y bob and hips rotation so dance weight shifts still read.
 */
function stripLocomotionRootMotion(source: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = source.tracks.map((sourceTrack) => {
    const track = sourceTrack.clone()
    if (!track.name.includes('Hips') || !track.name.endsWith('.position')) {
      return track
    }
    if (track.values.length < 3) {
      return track
    }
    const x0 = track.values[0]!
    const z0 = track.values[2]!
    for (let i = 0; i < track.values.length; i += 3) {
      track.values[i] = x0
      track.values[i + 2] = z0
    }
    return track
  })
  return new THREE.AnimationClip(source.name, source.duration, tracks)
}

/**
 * Model-specific clip wiring: preferred dance rename + in-place hips pin.
 * Mutates the clips array in place.
 */
function applyModelClipOverrides(
  clips: THREE.AnimationClip[],
  modelEntry: ModelEntry | undefined,
): void {
  if (!modelEntry) {
    return
  }

  const pinNames = new Set(modelEntry.pinRootClips ?? [])

  if (modelEntry.preferredDanceClip) {
    const preferredIndex = clips.findIndex(
      (clip) => clip.name === modelEntry.preferredDanceClip,
    )
    if (preferredIndex >= 0) {
      // Drop the generic Dance so MOTIONS / Auto always hit the unique clip.
      for (let i = clips.length - 1; i >= 0; i -= 1) {
        if (clips[i]!.name === 'Dance' && i !== preferredIndex) {
          clips.splice(i, 1)
        }
      }
      const preferred = clips.find((clip) => clip.name === modelEntry.preferredDanceClip)
      if (preferred) {
        if (pinNames.has(preferred.name) || pinNames.has('Dance')) {
          const pinned = stripLocomotionRootMotion(preferred)
          pinned.name = 'Dance'
          const idx = clips.indexOf(preferred)
          clips[idx] = pinned
        } else {
          preferred.name = 'Dance'
        }
        pinNames.delete(modelEntry.preferredDanceClip)
      }
    }
  }

  for (const name of pinNames) {
    const index = clips.findIndex((clip) => clip.name === name)
    if (index < 0) {
      continue
    }
    clips[index] = stripLocomotionRootMotion(clips[index]!)
  }
}

/**
 * Average RGB of a texture's image (downscaled). Returns null if the image is
 * not yet readable (CORS / not decoded).
 */
function averageColorFromMap(map: THREE.Texture | null | undefined): number | null {
  if (!map?.image) {
    return null
  }
  const image = map.image as {
    width?: number
    height?: number
    naturalWidth?: number
    naturalHeight?: number
  }
  const srcW = image.naturalWidth ?? image.width ?? 0
  const srcH = image.naturalHeight ?? image.height ?? 0
  if (srcW < 2 || srcH < 2) {
    return null
  }

  try {
    const size = 24
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      return null
    }
    ctx.drawImage(map.image as CanvasImageSource, 0, 0, size, size)
    const { data } = ctx.getImageData(0, 0, size, size)

    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] ?? 0
      if (a < 24) {
        continue
      }
      // Skip near-black voids / shadows that pull the average too dark.
      const pr = data[i] ?? 0
      const pg = data[i + 1] ?? 0
      const pb = data[i + 2] ?? 0
      if (pr + pg + pb < 30) {
        continue
      }
      r += pr
      g += pg
      b += pb
      n += 1
    }
    if (n < 8) {
      return null
    }
    const rr = Math.min(255, Math.round(r / n))
    const gg = Math.min(255, Math.round(g / n))
    const bb = Math.min(255, Math.round(b / n))
    return ((rr << 16) | (gg << 8) | bb) >>> 0
  } catch {
    return null
  }
}

/** Picks a costume-representative colour from the loaded scene. */
function resolveDefaultTint(
  scene: THREE.Object3D,
  fallback: number | undefined,
): number {
  let sampled: number | null = null
  scene.traverse((child) => {
    if (sampled !== null) {
      return
    }
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) {
      return
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      const std = material as THREE.MeshStandardMaterial
      if (!std) {
        continue
      }
      const fromMap = averageColorFromMap(std.map)
      if (fromMap !== null) {
        sampled = fromMap
        return
      }
      if (std.color && !std.map) {
        sampled = std.color.getHex() >>> 0
        return
      }
    }
  })
  if (sampled !== null) {
    return sampled
  }
  return (fallback ?? 0xffffff) >>> 0
}

export function loadModel(url: string): Promise<LoadedModel> {
  const existing = cache.get(url)
  if (existing) {
    return existing
  }

  const promise = new GLTFLoader().loadAsync(url).then((gltf) => {
    const built = buildMixamoRig(gltf.scene)
    if (!built) {
      throw new Error(`"${url}" has no recognisable Mixamo skeleton`)
    }

    const clips = gltf.animations.filter((clip) => clip.duration >= MIN_CLIP_SECONDS)
    for (const [rightName, leftName] of [
      ['Turn45', 'Turn45Left'],
      ['Turn90', 'Turn90Left'],
    ] as const) {
      const index = clips.findIndex((clip) => clip.name === rightName)
      if (index >= 0) {
        const right = stripTurnRootMotion(clips[index])
        clips[index] = right
        clips.push(mirrorMixamoClip(right, leftName))
      }
    }

    // Shadows have to be opted into per mesh, and the template is what gets
    // cloned, so doing it here covers every buddy. Mixamo exports often ship a
    // cool/blue body tint in material.color — force white so the figure reads
    // neutral under our lights (maps still multiply through white unchanged).
    const modelEntry = MODELS.find((entry) => entry.url === url)
    applyModelClipOverrides(clips, modelEntry)
    const materialBrightness = modelEntry?.brightness ?? 1
    const emissiveLift = modelEntry?.emissiveLift ?? 0
    const specularScale = modelEntry?.specularScale ?? 1

    // Sample only as a fallback when the registry did not declare part colours
    // (never overwrite explicit Buddy green / Ninja suit defaults).
    const sampledTint = resolveDefaultTint(gltf.scene, modelEntry?.defaultColor)
    const parts: CostumePartDef[] =
      modelEntry?.parts?.map((part) => ({ ...part })) ??
      [
        {
          id: 'color',
          label: 'Color',
          match: '.',
          channel: 'albedo' as const,
          defaultColor: sampledTint,
        },
      ]
    const defaultTint = (parts[0]?.defaultColor ?? modelEntry?.defaultColor ?? sampledTint) >>> 0

    gltf.scene.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) {
        return
      }
      mesh.castShadow = true
      mesh.receiveShadow = true

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (!material) {
          continue
        }
        const colored = material as THREE.MeshStandardMaterial
        const matLabel = `${mesh.name || ''} ${colored.name || material.name || ''}`
        const isHairLike = /hair|eyelash/i.test(matLabel)

        // Hair / lash cards are alpha atlases. Full BLEND often fails to draw
        // useful coverage here — cutout + depth write is a solid demo fix.
        if (isHairLike) {
          colored.transparent = true
          colored.alphaTest = 0.4
          colored.depthWrite = true
          colored.side = THREE.DoubleSide
          mesh.renderOrder = 2
          mesh.frustumCulled = false
          // Slight lift without full emissiveMap wash on transparent cards.
          if (colored.emissive) {
            colored.emissive.setRGB(0.08, 0.08, 0.08)
            colored.emissiveMap = null
            colored.emissiveIntensity = 1
          }
          if (colored.color) {
            // Keep hair near authored albedo (no stage brightness blowout).
            colored.color.setRGB(1.15, 1.15, 1.15)
          }
          if (specularScale !== 1) {
            const physical = colored as THREE.MeshPhysicalMaterial
            if (typeof physical.specularIntensity === 'number') {
              physical.specularIntensity *= specularScale
            }
            if (typeof colored.metalness === 'number') {
              colored.metalness *= specularScale
            }
          }
          material.needsUpdate = true
          continue
        }

        if (colored.color) {
          // Solid-colour assets (Buddy): bake the part default so spawn looks
          // correct before the first setPartTint. Textured assets stay white
          // so the map supplies the costume detail.
          if (!colored.map && modelEntry?.defaultColor !== undefined) {
            const hex = modelEntry.defaultColor >>> 0
            colored.color.setHex(hex)
            if (materialBrightness !== 1) {
              colored.color.multiplyScalar(materialBrightness)
            }
          } else {
            colored.color.setRGB(
              materialBrightness,
              materialBrightness,
              materialBrightness,
            )
          }
        }
        if (colored.emissive) {
          if (emissiveLift > 0) {
            // Soft self-illumination using the albedo so dark PBR maps still
            // read on a studio-dark stage without flattening to grey.
            colored.emissive.setRGB(1, 1, 1)
            colored.emissiveMap = colored.map
            colored.emissiveIntensity = emissiveLift
          } else {
            colored.emissive.set(0x000000)
            colored.emissiveIntensity = 1
          }
        }
        // Slightly glossier read helps plate / cloth catch key light.
        if (typeof colored.roughness === 'number') {
          colored.roughness = Math.min(colored.roughness, 0.72)
        }
        // Soften specular highlights (ninja / dancer default 0.8 = −20%).
        if (specularScale !== 1) {
          const physical = colored as THREE.MeshPhysicalMaterial
          if (typeof physical.specularIntensity === 'number') {
            physical.specularIntensity *= specularScale
          }
          if (typeof colored.metalness === 'number') {
            colored.metalness *= specularScale
          }
        }
        material.needsUpdate = true
      }
    })

    // Apply per-part solid defaults to matching untextured materials (Buddy
    // body vs joints) so the stage matches the menu before user edits.
    if (modelEntry?.parts) {
      gltf.scene.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh) {
          return
        }
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const material of materials) {
          const std = material as THREE.MeshStandardMaterial
          if (!std?.color || std.map) {
            continue
          }
          const label = `${std.name || ''} ${mesh.name || ''}`
          const part = modelEntry.parts!.find((entry) =>
            new RegExp(entry.match, 'i').test(label),
          )
          if (part && part.channel === 'albedo') {
            std.color.setHex(part.defaultColor >>> 0)
          }
        }
      })
    }

    return {
      scene: gltf.scene,
      rig: built.rig,
      normalisation: built.normalisation,
      offset: built.offset,
      clips,
      defaultTint,
      parts,
    }
  })

  // A rejected promise must not stay cached, or one dropped request makes the
  // model permanently unloadable for the rest of the session.
  promise.catch(() => {
    if (cache.get(url) === promise) {
      cache.delete(url)
    }
  })

  cache.set(url, promise)
  return promise
}

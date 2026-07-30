import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { FilterStack } from './filters/FilterStack'
import { initPhysics, PhysicsWorld } from './physics/createWorld'
import { GrabController } from './physics/grab'
import { Ragdoll } from './physics/ragdoll'
import RAPIER from '@dimforge/rapier3d-compat'
import { AnimationPoseSource } from './pose/animationPose'
import { BindPoseSource } from './pose/bindPose'
import { RaisedHandsPoseSource } from './pose/raisedHandsPose'
import type { PoseSource } from './pose/types'
import { applyRandomCostumeHue } from './costumeHue'
import { clipMeta, loadModel, MODELS, MOTIONS, isRecoveryClip, pickRecoveryClip, type LoadedModel } from './models/registry'
import { installCostumeTintShader } from './render/costumeTintShader'
import { PrimitiveView } from './render/primitiveView'
import { SkinnedView } from './render/skinnedView'
import { primitiveRig } from './rigs/primitive'
import type { BoneSlot, RigDefinition } from './rigs/types'
import type { VirtualBuddyParams } from './types'

const FOV = 40
/** Soft pad so toes sit just above the absolute bottom edge, not clipped. */
const FEET_FRAME_MARGIN = 0.04
/**
 * Below human density on purpose. A true ~70kg body is realistic and no fun to
 * throw; the whole buddy lands near 40kg at weight 1, and the Weight slider
 * reaches genuine human mass at its top end.
 */
const BASE_DENSITY = 600
/** Spawned buddies drop in from here if the click lands lower. */
/**
 * Time used to merge the live physics pose into a newly selected clip. Long
 * enough that standing up off the floor reads as a lift rather than a snap.
 */
const MOTION_BLEND_SECONDS = 0.45
/** Get Up starts from an arbitrary physics pose, so it needs a gentler handoff. */
const GET_UP_BLEND_SECONDS = 1.35
/**
 * Normalized points in a recovery clip between which tracking tightens from
 * loose joint-angle following onto exact world placement. The body is off the
 * floor well before the clip ends, so the last stretch can be tracked tightly
 * and hand over to Idle already on-pose.
 */
const RECOVERY_TIGHTEN_START = 0.45
const RECOVERY_TIGHTEN_END = 0.85
/** Floor on animation follow strength so a low Muscle tone still recovers a pose. */
const ANIMATION_TONE_FLOOR = 0.72
const AUTO_IDLE_MIN_SECONDS = 5
const AUTO_IDLE_VARIANCE_SECONDS = 10
/** Retry window when another buddy currently owns the crowd's attention. */
const AUTO_ACTION_RETRY_MIN_SECONDS = 1.5
const AUTO_ACTION_RETRY_VARIANCE_SECONDS = 3
/** Approximate maximum share of the crowd performing independent actions. */
const AUTO_ACTIVE_FRACTION = 0.34
/** Random settling window after a break-away, so a crowd does not recover in unison. */
const LIMP_RECOVER_MIN_SECONDS = 0.8
const LIMP_RECOVER_VARIANCE_SECONDS = 0.7
/** Recovery must wait for actual floor contact, especially in low gravity. */
const RECOVERY_GROUND_HEIGHT = 0.32
const RECOVERY_MAX_LINEAR_SPEED = 0.9
const RECOVERY_MAX_ANGULAR_SPEED = 2.5
const ANIMATION_RATE_MIN = 0.94
const ANIMATION_RATE_VARIANCE = 0.12
/** Inter-buddy contact force that is strong enough to knock a performer loose. */
const BUDDY_IMPACT_FORCE = 300
/** Softer contact between two walkers — enough to interrupt, not flatten. */
const WALKER_IMPACT_FORCE = 70
/** How far the centre of mass may hang outside the planted feet, in metres. */
const BALANCE_MAX_OFFSET = 0.24
/** A stride carries weight ahead of the support foot, so locomotion is looser. */
const BALANCE_MAX_OFFSET_MOVING = 0.5
/** Long enough to read as a stumble rather than a twitch, short enough to fall. */
const BALANCE_GRACE_SECONDS = 0.35
/** Head start a freshly started clip gets to plant its feet before being judged. */
const BALANCE_SETTLE_SECONDS = 0.8
/** Height above the rig's floor origin used for every entrance. */
const SPAWN_DROP_HEIGHT = 2.1
const SPAWN_MIN_FALL_SECONDS = 0.45
const SPAWN_FORCE_FINISH_SECONDS = 2.6
/** Per-buddy pause after landing, so a crowd does not get up in unison. */
const SPAWN_RECOVERY_DELAY_MIN = 0.15
const SPAWN_RECOVERY_DELAY_VARIANCE = 3.6
/** Stage travel matched to the authored in-place stride. */
const WALK_SPEED = 0.9
/** Time for root travel to build after a turn finishes. */
const WALK_ACCEL_SECONDS = 0.7
/** Distance over which a walker eases down before stopping to turn. */
const WALK_DECEL_DISTANCE = 0.55
/** Cadence never reaches zero, so the crossfade keeps visibly progressing. */
const WALK_MIN_PLAYBACK_SCALE = 0.42
const TURN_RATE = 2.4
const NAV_MARGIN = 0.4
const HANDSHAKE_DISTANCE = 0.9
/** How far each partner steps into the clasp at peak contact. */
const HANDSHAKE_INSET = 0.11
const HANDSHAKE_COOLDOWN_MIN = 7
const HANDSHAKE_COOLDOWN_VARIANCE = 8
/** Chance an idle Auto buddy starts walking instead of gesturing. */
const WALK_CHANCE = 0.4
/** Chance two eligible idle buddies begin a handshake instead of solo gestures. */
const HANDSHAKE_CHANCE = 0.35
/** Chance an eligible face-to-face pair begins dancing together. */
const FACING_DANCE_CHANCE = 0.65
/** Partners farther apart than this do not read as dancing together. */
const FACING_DANCE_MAX_DISTANCE = 2.6
/** Maximum facing error for each partner (about 30 degrees). */
const FACING_DANCE_MAX_ANGLE = Math.PI / 6
/** Gestures usually address the viewer, but sometimes acknowledge a neighbour. */
const MODEL_GESTURE_FOCUS_CHANCE = 0.35
/** After locomotion/recovery, most buddies settle facing the viewer. */
const CAMERA_SETTLE_CHANCE = 0.75

const _rootPosition = new THREE.Vector3()
const _rootRotation = new THREE.Quaternion()
const _blendedRootPosition = new THREE.Vector3()
const _blendedRootRotation = new THREE.Quaternion()
const _navDelta = new THREE.Vector3()
const _anchorScratch = new THREE.Vector3()

type RootTransition = {
  fromPosition: THREE.Vector3
  fromRotation: THREE.Quaternion
  duration: number
  /** Arbitrary physics poses need joint-relative correction until gathered. */
  useRelativePose: boolean
}

type AutoPhase =
  | 'idle'
  | 'gesture'
  | 'recover'
  | 'turn'
  | 'walk'
  | 'handshakeApproach'
  | 'handshake'
  | 'postInteractionWait'

type TurnNextPhase = 'walk' | 'handshakeApproach' | 'gesture' | 'idle'

export type BuddyPartSnapshot = {
  id: string
  label: string
  color: number
  defaultColor: number
}

/** Live snapshot for the Models panel — no scene handles leak into React. */
export type BuddySnapshot = {
  id: number
  label: string
  modelIndex: number
  motionIndex: number
  /** Primary chip colour (first costume part). */
  color: number
  defaultColor: number
  parts: BuddyPartSnapshot[]
}

type Buddy = {
  id: number
  /** Registry index of the mesh used for this instance. */
  modelIndex: number
  modelLabel: string
  /** Per-buddy motion choice (MOTIONS index). */
  motionIndex: number
  /** Packed 0xRRGGBB colours keyed by costume part id. */
  partColors: Record<string, number>
  /** Costume-matched defaults keyed by part id. */
  partDefaults: Record<string, number>
  /** Owned capsule material so tint + dispose stay instance-local. */
  capsuleMaterial: THREE.MeshStandardMaterial
  ragdoll: Ragdoll
  /** Rig-specific fallback pose; mixed models need independent skeletons. */
  bindPose: BindPoseSource
  /** Always built — doubles as the "show physics bodies" debug overlay. */
  view: PrimitiveView
  /** Only when a character model is active. */
  skin: SkinnedView | null
  /** Only when a character model is active — clips need a skeleton. */
  anim: AnimationPoseSource | null
  /** Whichever source is currently feeding muscle tone. */
  pose: PoseSource
  rootSlot: BoneSlot | null
  /** Last applied motion, so body types only switch when the choice changes. */
  motionKey: string
  /** 0..1 ramp that softens the first impulses of a new animation. */
  motionBlend: number
  rootTransition: RootTransition | null
  /** Torn loose by a hard pull: no clip, no pose forces, free hips. */
  limp: boolean
  /** New arrivals stay fully dynamic until their fall has reached the floor. */
  spawnDropping: boolean
  spawnTimer: number
  /** Time the landing was first judged settled; null while still falling. */
  spawnSettledAt: number | null
  /** Individual pause between landing and beginning the get-up clip. */
  spawnRecoveryDelay: number
  /** Animated hips become a dynamic spring while this buddy is touched. */
  rootCompliant: boolean
  /** Counts down once released, so the body settles before performing again. */
  limpTimer: number
  /** How long this buddy's weight has sat outside its own footing. */
  balanceTimer: number
  autoActive: boolean
  autoPhase: AutoPhase
  autoClip: string
  autoTimer: number
  /** Small per-buddy tempo difference keeps identical clips from synchronizing. */
  animationRate: number
  /** Personal tempo restored after a synchronized paired clip. */
  baseAnimationRate: number
  /** Stable per-buddy phase for looping Idle, preventing mirrored crowds. */
  idlePhaseOffset: number
  /** Scene-owned facing in radians. */
  heading: number
  /** Walk destination on the stage floor, or null when not navigating. */
  destination: THREE.Vector3 | null
  /** Reserved partner for a handshake, if any. */
  partnerId: number | null
  /** Pair spacing before the handshake's temporary inward movement. */
  handshakeBase: THREE.Vector3 | null
  /** Remaining cooldown before this buddy may socialise again. */
  socialCooldown: number
  turnStartHeading: number
  turnTargetHeading: number
  turnElapsed: number
  turnDuration: number
  turnNextPhase: TurnNextPhase
  /** Clip waiting behind a turn, normally Wave or Dance. */
  pendingClip: string
  /** 0..1 stage-travel acceleration independent of the walk pose crossfade. */
  walkBlend: number
}

export class VirtualBuddyScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly composer: EffectComposer
  private readonly filters: FilterStack
  private readonly hemiLight: THREE.HemisphereLight
  private readonly keyLight: THREE.DirectionalLight
  private readonly rimLight: THREE.DirectionalLight
  private readonly buddyMaterial: THREE.MeshStandardMaterial
  private readonly groundMaterial: THREE.MeshStandardMaterial
  private readonly groundGeometry: THREE.PlaneGeometry
  private readonly baseHemiIntensity = 1.55
  private readonly baseKeyIntensity = 3.1
  private readonly baseRimIntensity = 1.9
  private readonly raisedHandsPose = new RaisedHandsPoseSource()
  private activeRig: RigDefinition = primitiveRig
  private activeModel: LoadedModel | null = null
  private readonly loadedModels = new Map<string, LoadedModel>()
  private pendingModel: string | null = null
  private modelError: string | null = null
  private lastTime = 0

  private physics: PhysicsWorld | null = null
  private buddies: Buddy[] = []
  private nextBuddyId = 1
  private grab: GrabController | null = null
  /** Last bounds computed from the frustum, so spawns can be clamped inside. */
  private bounds = { halfWidth: 2, halfDepth: 1.2, ceiling: 4 }
  /** Kept so pointer-up can read throw power outside the render call. */
  private lastParams: VirtualBuddyParams | null = null
  /**
   * After Reset scene the stage may stay empty until the user adds a buddy.
   * Without this, syncBuddies would immediately re-seed a host character.
   */
  private allowEmptyStage = false

  private width = 1
  private height = 1
  private disposed = false

  /** Fires only on change, so the UI can show Ragdoll without polling. */
  onLimpChange: ((limp: boolean) => void) | null = null
  private lastReportedLimp = false

  /** Fires when buddies are added, removed, or their panel fields change. */
  onBuddiesChange: ((buddies: BuddySnapshot[]) => void) | null = null

  /**
   * Internal render scale, wired through the composer from day one. The retro
   * filters need chunky low-res buffers, and bolting resolution scaling onto a
   * finished post pipeline later is far more painful than reserving it now.
   */
  private renderScale = 1

  // Change detection, so we only rebuild what actually moved.
  private buildKey = ''
  private boundsKey = ''

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap

    // Slightly lifted from pure studio black so the stage reads under brightness 1.
    this.scene.background = new THREE.Color(0x1c1c1c)
    this.scene.fog = new THREE.Fog(0x1c1c1c, 10, 26)

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100)
    // Defaults: distance 4, height ≈ 4*tan(20°) so feet land on the bottom edge.
    this.camera.position.set(0, 1.46, 4)
    this.camera.lookAt(0, 1.46, 0)

    // Neutral sky fill — a cool hemi made white materials read blue.
    this.hemiLight = new THREE.HemisphereLight(0xe8e8e8, 0x2a2a2a, this.baseHemiIntensity)
    this.scene.add(this.hemiLight)

    this.keyLight = new THREE.DirectionalLight(0xffffff, this.baseKeyIntensity)
    this.keyLight.position.set(3.5, 6, 5)
    this.keyLight.castShadow = true
    this.keyLight.shadow.mapSize.set(1024, 1024)
    this.keyLight.shadow.camera.near = 1
    this.keyLight.shadow.camera.far = 20
    this.keyLight.shadow.camera.left = -4
    this.keyLight.shadow.camera.right = 4
    this.keyLight.shadow.camera.top = 5
    this.keyLight.shadow.camera.bottom = -1
    this.keyLight.shadow.bias = -0.0015
    this.scene.add(this.keyLight)

    // Brand green as a rim light — ties the sim to the palette without
    // tinting the whole figure.
    this.rimLight = new THREE.DirectionalLight(0x00e05a, this.baseRimIntensity)
    this.rimLight.position.set(-4.5, 2.5, -3.5)
    this.scene.add(this.rimLight)

    this.buddyMaterial = new THREE.MeshStandardMaterial({
      color: 0xc8c8c8,
      roughness: 0.6,
      metalness: 0.04,
    })

    this.groundGeometry = new THREE.PlaneGeometry(60, 60)
    this.groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a,
      roughness: 1,
    })
    const ground = new THREE.Mesh(this.groundGeometry, this.groundMaterial)
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.filters = new FilterStack(this.composer)

    if (import.meta.env.DEV) {
      // Console handle for poking at the sim. Worth keeping — "where actually
      // are the bodies" is the first question every physics bug asks.
      ;(window as unknown as Record<string, unknown>).__buddy = this
    }
  }

  /** First buddy, for console poking. */
  get ragdoll(): Ragdoll | null {
    return this.buddies[0]?.ragdoll ?? null
  }

  /** Dev snapshot: what exists, and where. */
  debugSnapshot(): Record<string, unknown> {
    return {
      physicsReady: Boolean(this.physics),
      buddies: this.buddies.map((buddy) => {
        const hips = buddy.ragdoll.parts.get('hips')?.body.translation()
        return {
          parts: buddy.ragdoll.parts.size,
          joints: buddy.ragdoll.joints.length,
          hips: hips ? [+hips.x.toFixed(2), +hips.y.toFixed(2), +hips.z.toFixed(2)] : null,
          visible: buddy.view.group.visible,
          inScene: this.scene.children.includes(buddy.view.group),
        }
      }),
      camera: this.camera.position.toArray(),
      size: [this.width, this.height],
      bounds: this.bounds,
      boundsKey: this.boundsKey,
      buildKey: this.buildKey,
    }
  }

  /**
   * Rapier's WASM boot. Separate from the constructor so Three.js can put
   * something on screen immediately, and so the caller can cancel: `dispose()`
   * during this await leaves nothing behind.
   */
  async init(): Promise<void> {
    await initPhysics()
    if (this.disposed) {
      return
    }
    this.physics = new PhysicsWorld()
    this.grab = new GrabController(this.camera, this.physics)
    // Fetch + GPU-warm textured models in the background so Ninja / Paladin
    // do not hitch the first time they drop onto the stage.
    void this.preloadSpawnableModels()
  }

  /**
   * Loads every character GLB (sequentially, lightest first) and uploads maps
   * / compiles materials off the critical spawn path.
   */
  private async preloadSpawnableModels(): Promise<void> {
    const entries = MODELS.filter((entry) => entry.url).sort((a, b) => {
      // Prefer smaller / default assets first so the host buddy is ready soon.
      const order = (id: string) =>
        id === 'buddy'
          ? 0
          : id === 'buddy-f'
            ? 1
            : id === 'paladin'
              ? 2
              : id === 'dancer'
                ? 3
                : 4
      return order(a.id) - order(b.id)
    })

    for (const entry of entries) {
      if (this.disposed || !entry.url) {
        return
      }
      if (this.loadedModels.has(entry.url)) {
        continue
      }
      try {
        const model = await loadModel(entry.url)
        if (this.disposed) {
          return
        }
        this.loadedModels.set(entry.url, model)
        this.warmLoadedModel(model)
        // Yield so a 50MB+ parse does not starve the render loop.
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 0)
        })
      } catch (error: unknown) {
        console.warn(`[virtual-buddy] preload failed for ${entry.label}`, error)
      }
    }
  }

  /** Upload textures and compile character programs once per template. */
  private warmLoadedModel(model: LoadedModel): void {
    const textures = new Set<THREE.Texture>()
    const collect = (material: THREE.Material | null | undefined) => {
      if (!material) {
        return
      }
      const std = material as THREE.MeshStandardMaterial
      if (std.map) {
        textures.add(std.map)
      }
      if (std.normalMap) {
        textures.add(std.normalMap)
      }
      if (std.emissiveMap) {
        textures.add(std.emissiveMap)
      }
      if (std.roughnessMap) {
        textures.add(std.roughnessMap)
      }
      if (std.metalnessMap) {
        textures.add(std.metalnessMap)
      }
      if (std.aoMap) {
        textures.add(std.aoMap)
      }
      const physical = material as THREE.MeshPhysicalMaterial
      if (physical.specularIntensityMap) {
        textures.add(physical.specularIntensityMap)
      }
      if (physical.specularColorMap) {
        textures.add(physical.specularColorMap)
      }
    }

    model.scene.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) {
        return
      }
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) {
        collect(material)
      }
    })

    for (const texture of textures) {
      this.renderer.initTexture(texture)
    }

    // Compile skinned + costume-tint programs so the first spawn is not the
    // first shader compile (main hitch after the network load).
    const usesSkinSplit = model.parts.some(
      (part) =>
        part.channel === 'skin' ||
        part.channel === 'armor' ||
        part.channel === 'trim',
    )
    const probe = cloneSkeleton(model.scene)
    probe.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh || !mesh.material) {
        return
      }
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const warmed = list.map((material) => {
        const cloned = material.clone() as THREE.MeshStandardMaterial
        if (usesSkinSplit && cloned.map) {
          installCostumeTintShader(cloned)
        }
        return cloned
      })
      mesh.material = Array.isArray(mesh.material) ? warmed : warmed[0]!
    })

    const tempScene = new THREE.Scene()
    tempScene.add(probe)
    try {
      this.renderer.compile(tempScene, this.camera)
    } catch {
      // Compile is best-effort — a failure here should not block spawning.
    }
    tempScene.remove(probe)
    probe.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) {
        return
      }
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) {
        material?.dispose()
      }
    })
  }

  /**
   * Returns true if a buddy was grabbed. Empty-space clicks do nothing — adding
   * another character is a dedicated stage button, not a canvas click.
   */
  pointerDown(ndcX: number, ndcY: number): boolean {
    if (!this.grab) {
      return false
    }

    if (
      this.grab.tryGrab(
        ndcX,
        ndcY,
        this.buddies.map((buddy) => buddy.ragdoll),
      )
    ) {
      const held = this.grab.grabbedRagdoll
      const buddy = this.buddies.find((candidate) => candidate.ragdoll === held)
      if (buddy?.anim?.isPlaying && !buddy.limp && buddy.rootSlot) {
        buddy.rootCompliant = true
        const root = buddy.ragdoll.parts.get(buddy.rootSlot)
        root?.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
      }
      return true
    }

    return false
  }

  /**
   * Adds another buddy on the stage floor. When at maxBuddies, the oldest is
   * removed first so new arrivals always land. Offset sideways so they do not
   * stack on the same origin as the first.
   *
   * @param randomizeHue Stage + button: random costume hue (S/V preserved).
   */
  spawnBuddy(
    modelIndex = Math.round(this.lastParams?.model ?? 0),
    options: { randomizeHue?: boolean } = {},
  ): boolean {
    const params = this.lastParams
    if (!params || !this.physics) {
      return false
    }

    this.allowEmptyStage = false
    const randomizeHue = Boolean(options.randomizeHue)
    const resolvedIndex = Math.max(0, Math.min(MODELS.length - 1, Math.round(modelIndex)))
    const entry = MODELS[resolvedIndex] ?? MODELS[Math.round(params.model)] ?? MODELS[0]
    if (!entry.url) {
      this.makeRoomForSpawn()
      this.spawnLoadedBuddy(null, resolvedIndex, randomizeHue)
      return true
    }

    const loaded = this.loadedModels.get(entry.url)
    if (loaded) {
      this.makeRoomForSpawn()
      this.spawnLoadedBuddy(loaded, resolvedIndex, randomizeHue)
      return true
    }

    // A model choice is accepted immediately; the stage remains responsive
    // while its asset loads, and the requested buddy drops once ready.
    loadModel(entry.url)
      .then((model) => {
        if (this.disposed) {
          return
        }
        if (!this.loadedModels.has(entry.url as string)) {
          this.loadedModels.set(entry.url as string, model)
          this.warmLoadedModel(model)
        }
        this.makeRoomForSpawn()
        this.spawnLoadedBuddy(model, resolvedIndex, randomizeHue)
      })
      .catch((error: unknown) => {
        console.error(`[virtual-buddy] failed to add ${entry.label}`, error)
      })
    return true
  }

  /** Drop oldest buddies until there is room under maxBuddies. */
  private makeRoomForSpawn(): void {
    const params = this.lastParams
    if (!params) {
      return
    }
    const max = Math.max(1, Math.round(params.maxBuddies))
    let removed = false
    while (this.buddies.length >= max) {
      const oldest = this.buddies.shift()
      if (!oldest) {
        break
      }
      this.removeBuddy(oldest)
      removed = true
    }
    if (removed) {
      this.notifyBuddiesChange()
    }
  }

  private spawnLoadedBuddy(
    model: LoadedModel | null,
    modelIndex = 1,
    randomizeHue = false,
  ): void {
    const params = this.lastParams
    if (!params || !this.physics) {
      return
    }
    // Room should already be cleared; keep a hard cap as a safety net.
    if (this.buddies.length >= Math.max(1, Math.round(params.maxBuddies))) {
      this.makeRoomForSpawn()
    }

    const halfW = Math.max(0.2, this.bounds.halfWidth - 0.4)
    // Fan new arrivals left/right of centre so a crowd is readable at a glance.
    const slot = this.buddies.length
    const x =
      slot === 0
        ? 0
        : THREE.MathUtils.clamp(
            (slot % 2 === 0 ? 1 : -1) * Math.ceil(slot / 2) * 0.55,
            -halfW,
            halfW,
          )
    this.addBuddy(
      new THREE.Vector3(x, SPAWN_DROP_HEIGHT, 0),
      params,
      true,
      model,
      modelIndex,
      randomizeHue,
    )
  }

  get buddyCount(): number {
    return this.buddies.length
  }

  listBuddies(): BuddySnapshot[] {
    return this.buddies.map((buddy) => this.toSnapshot(buddy))
  }

  setBuddyMotion(id: number, motionIndex: number): void {
    const buddy = this.buddies.find((candidate) => candidate.id === id)
    if (!buddy) {
      return
    }
    const next = Math.max(0, Math.min(MOTIONS.length - 1, Math.round(motionIndex)))
    if (buddy.motionIndex === next) {
      return
    }
    buddy.motionIndex = next
    buddy.motionKey = ''
    buddy.autoActive = false
    buddy.destination = null
    this.clearPartner(buddy)
    this.notifyBuddiesChange()
  }

  setBuddyPartColor(id: number, partId: string, color: number): void {
    const buddy = this.buddies.find((candidate) => candidate.id === id)
    if (!buddy || !(partId in buddy.partDefaults)) {
      return
    }
    const packed = color >>> 0
    if (buddy.partColors[partId] === packed) {
      return
    }
    buddy.partColors[partId] = packed
    // Primary part also drives the capsule debug colour / list chip.
    const primaryId = Object.keys(buddy.partDefaults)[0]
    if (partId === primaryId) {
      buddy.capsuleMaterial.color.setHex(packed)
      buddy.view.setTint(packed)
    }
    buddy.skin?.setPartTint(partId, packed)
    this.notifyBuddiesChange()
  }

  /** @deprecated Prefer setBuddyPartColor — sets the primary costume part. */
  setBuddyColor(id: number, color: number): void {
    const buddy = this.buddies.find((candidate) => candidate.id === id)
    if (!buddy) {
      return
    }
    const primaryId = Object.keys(buddy.partDefaults)[0] ?? 'color'
    this.setBuddyPartColor(id, primaryId, color)
  }

  removeBuddyById(id: number): void {
    const index = this.buddies.findIndex((candidate) => candidate.id === id)
    if (index < 0) {
      return
    }
    const [buddy] = this.buddies.splice(index, 1)
    this.removeBuddy(buddy)
    this.notifyBuddiesChange()
  }

  private toSnapshot(buddy: Buddy): BuddySnapshot {
    const parts = Object.keys(buddy.partDefaults).map((partId) => ({
      id: partId,
      label:
        buddy.skin?.parts.find((part) => part.id === partId)?.label ??
        MODELS[buddy.modelIndex]?.parts?.find((part) => part.id === partId)?.label ??
        partId,
      color: buddy.partColors[partId] ?? buddy.partDefaults[partId] ?? 0xffffff,
      defaultColor: buddy.partDefaults[partId] ?? 0xffffff,
    }))
    const primary = parts[0]
    return {
      id: buddy.id,
      label: buddy.modelLabel,
      modelIndex: buddy.modelIndex,
      motionIndex: buddy.motionIndex,
      color: primary?.color ?? 0xffffff,
      defaultColor: primary?.defaultColor ?? 0xffffff,
      parts,
    }
  }

  private notifyBuddiesChange(): void {
    this.onBuddiesChange?.(this.listBuddies())
  }

  pointerMove(ndcX: number, ndcY: number): void {
    this.grab?.moveTo(ndcX, ndcY)
  }

  pointerUp(): void {
    const held = this.grab?.grabbedRagdoll ?? null
    this.grab?.release(this.lastParams?.throwPower ?? 1)

    // A torn-loose buddy stays limp for a moment after release, so a throw
    // lands as a throw instead of snapping upright in mid-air.
    const buddy = this.buddies.find((candidate) => candidate.ragdoll === held)
    if (buddy?.limp) {
      buddy.limpTimer = this.nextLimpRecoverDelay()
    } else if (buddy?.rootCompliant && buddy.rootSlot) {
      buddy.rootCompliant = false
      const root = buddy.ragdoll.parts.get(buddy.rootSlot)
      const translation = root?.body.translation()
      const rotation = root?.body.rotation()
      if (root && translation && rotation) {
        const releasePosition = new THREE.Vector3(
          translation.x,
          translation.y,
          translation.z,
        )
        // The dynamic root has genuinely moved. Make that release point the
        // clip's new stage anchor before full spring strength resumes; otherwise
        // the animation target pulls it straight back to the spawn position.
        buddy.anim?.reanchorRoot(releasePosition)
        buddy.motionBlend = 0.2
        buddy.rootTransition = {
          fromPosition: releasePosition,
          fromRotation: new THREE.Quaternion(
            rotation.x,
            rotation.y,
            rotation.z,
            rotation.w,
          ),
          duration: MOTION_BLEND_SECONDS,
          useRelativePose: false,
        }
      }
    }
  }

  get isGrabbing(): boolean {
    return this.grab?.isGrabbing ?? false
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)

    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()

    this.renderer.setSize(this.width, this.height, false)
    const bufferW = Math.max(1, Math.round(this.width * this.renderScale))
    const bufferH = Math.max(1, Math.round(this.height * this.renderScale))
    this.composer.setSize(bufferW, bufferH)
    // Shader texel math must match the composer's internal render targets
    // (composer multiplies these by the renderer pixel ratio).
    this.filters.setSize(bufferW, bufferH, this.renderer.getPixelRatio())

    // Walls follow the frustum, so a resize invalidates them.
    this.boundsKey = ''
  }

  render(params: VirtualBuddyParams): void {
    if (this.disposed) {
      return
    }

    this.lastParams = params

    const now = performance.now()
    const dt = this.lastTime === 0 ? 1 / 60 : (now - this.lastTime) / 1000
    this.lastTime = now

    if (this.physics) {
      this.syncCamera(params)
      this.syncBrightness(params)
      this.syncSceneLook(params)
      this.syncBounds(params)
      this.syncBuddies(params)
      this.syncMotion(Math.min(dt, 0.1))
      this.updateBalance(Math.min(dt, 0.1))

      // Exposed as a positive magnitude — a negative-only slider reads badly.
      this.physics.setGravity(-params.gravity)
      // Mixers advance once per frame, not per physics step — a clip should
      // play at wall-clock speed regardless of how many steps the accumulator
      // ends up running.
      for (const buddy of this.buddies) {
        buddy.anim?.update(dt * buddy.animationRate)
      }

      this.physics.step(
        dt,
        (stepDt) => {
        const held = this.grab?.grabbedSlot ?? null
        const heldRagdoll = this.grab?.grabbedRagdoll ?? null
          const strain = this.grab?.strain ?? 0

        for (const buddy of this.buddies) {
            // Pull hard enough and the whole body tears out of its performance.
            // A light drag stays local, so touching an ankle bends the ankle
            // rather than dropping the character.
            if (
              !buddy.limp &&
              buddy.ragdoll === heldRagdoll &&
              strain > params.breakAwayPull
            ) {
              this.setLimp(buddy, true)
            }

          if (buddy.anim?.isPlaying && buddy.rootSlot) {
              const blendDuration =
                buddy.rootTransition?.duration ??
                (isRecoveryClip(buddy.anim.activeClipName)
                  ? GET_UP_BLEND_SECONDS
                  : MOTION_BLEND_SECONDS)
              buddy.motionBlend = Math.min(
                1,
                buddy.motionBlend + stepDt / blendDuration,
              )
            const root = buddy.ragdoll.parts.get(buddy.rootSlot)
            if (root && buddy.anim.getRootTransform(_rootPosition, _rootRotation)) {
                // Stand the collider figure on the floor rather than burying it
                // by the thickness of the soles. Every consumer below reads
                // `_rootPosition`, and pose support targets are offsets from the
                // live root, so lifting here carries through the whole body.
                _rootPosition.y += buddy.ragdoll.groundClearance
                // The pelvis always remains dynamic. During a grab, weaken its
                // spring according to graph distance from the held limb: a hand
                // barely shifts the hips while grabbing the pelvis yields fully.
                const rootYield = buddy.ragdoll.grabPoseInfluence(
                  buddy.rootSlot,
                  buddy.rootCompliant && buddy.ragdoll === heldRagdoll
                    ? held
                    : null,
                )

                let rootTargetPosition = _rootPosition
                let rootTargetRotation = _rootRotation
                if (buddy.rootTransition && buddy.motionBlend < 1) {
                  const t = buddy.motionBlend
                  const eased = t * t * (3 - 2 * t)
                  _blendedRootPosition
                    .copy(buddy.rootTransition.fromPosition)
                    .lerp(_rootPosition, eased)
                  _blendedRootRotation
                    .copy(buddy.rootTransition.fromRotation)
                    .slerp(_rootRotation, eased)
                  rootTargetPosition = _blendedRootPosition
                  rootTargetRotation = _blendedRootRotation
                } else {
                  buddy.rootTransition = null
                }

                buddy.ragdoll.driveRootToward(
                  buddy.rootSlot,
                  rootTargetPosition,
                  rootTargetRotation,
                  Math.max(params.muscleTone, ANIMATION_TONE_FLOOR) *
                    rootYield *
                    Math.max(0.12, buddy.motionBlend),
                  params.gravity,
                  stepDt,
                )
              }
            }

            const animating = Boolean(buddy.anim?.isPlaying)
          const entering = buddy.spawnDropping
          // Never start from zero — the root spring needs enough initial
          // authority to gather a limp body during the blend window.
          const animationGain = animating ? 0.35 + 0.65 * buddy.motionBlend : 1
          const followTone = entering
            ? 0.85
            : animating
              ? Math.max(params.muscleTone, ANIMATION_TONE_FLOOR) * animationGain
              : 0
          // Absolute world targets are what make Idle/Dance pull the body
          // upright again after a shove. They are the wrong tool while the body
          // is still far from the clip, though: a sprawled buddy gives limbs a
          // near-180° target, where the shortest-arc direction is unstable and
          // light limbs whip around instead of converging. Joint-angle space has
          // no such failure, and the dynamic root spring still carries world
          // orientation, so recovery poses stay correct.
          //
          // That reasoning expires partway through a get-up. Once the body is
          // off the floor its error is small, and staying loose to the end is
          // exactly what leaves it off-pose when Idle takes over — the drift
          // then gets corrected in one frame and reads as a jump. So a recovery
          // tightens onto the clip as it plays and hands over already matching.
          const activeClip = buddy.anim?.activeClipName
          const recovering =
            animating && isRecoveryClip(activeClip)
          const recoveryGathered = recovering
            ? THREE.MathUtils.smoothstep(
                buddy.anim?.getNormalizedTime() ?? 0,
                RECOVERY_TIGHTEN_START,
                RECOVERY_TIGHTEN_END,
              )
            : 0
          const settling =
            (recovering && recoveryGathered < 1) ||
            Boolean(
              buddy.rootTransition?.useRelativePose &&
                buddy.motionBlend < 1,
            )
          buddy.ragdoll.applyMuscleTone({
              pose: entering ? this.raisedHandsPose : buddy.pose,
              tone: followTone,
            // Only the held buddy's limb stands down, not the same slot on all.
            heldSlot: buddy.ragdoll === heldRagdoll ? held : null,
            gravity: params.gravity,
            stepDt,
              space:
                entering || (animating && !settling)
                  ? 'absolute'
                  : 'relative',
            })
            if (!entering && animating) {
              // Legs are supported throughout — that forward travel is what
              // stops the shins being left behind the hips. The torso joins in
              // gradually, because full support from a sprawl would yank the
              // chest rather than let the clip lift it.
              const torsoShare = recovering
                ? recoveryGathered
                : settling
                  ? buddy.motionBlend
                  : 1
              buddy.ragdoll.applyPoseSupport(
                buddy.pose,
                recovering
                  ? followTone * 0.85
                  : activeClip === 'Walk'
                    ? Math.max(0.95, followTone)
                    : followTone,
                buddy.ragdoll === heldRagdoll ? held : null,
                stepDt,
                torsoShare,
              )
            }
            if (!entering && animating) {
              const footLoad =
                activeClip === 'Walk'
                  ? 0.5
                  : activeClip?.startsWith('Turn') ||
                      isRecoveryClip(activeClip)
                    ? 0.3
                    : 1
              buddy.ragdoll.stabilizeFeet(
                stepDt,
                animationGain,
                buddy.pose,
                params.gravity,
                footLoad,
              )
            }
        }

        this.grab?.applyGrab(params.grabStrength, stepDt)
        },
        (collider1, collider2, force) => {
          this.handleBuddyImpact(collider1, collider2, force)
        },
      )

      for (const buddy of this.buddies) {
        buddy.view.sync()
        buddy.skin?.sync()
      }
    }

    this.filters.sync(params)
    this.composer.render()
  }

  /** Rebuild host after a hard model change (legacy reset path). */
  reset(): void {
    this.allowEmptyStage = false
    this.buildKey = ''
    this.teardownBuddies()
  }

  /**
   * Clear every buddy from the stage; slider / effect settings are untouched.
   * Stage stays empty until the user adds a model again.
   */
  clearStage(): void {
    this.allowEmptyStage = true
    this.teardownBuddies()
  }

  dispose(): void {
    this.disposed = true

    this.teardownBuddies()
    this.physics?.dispose()
    this.physics = null

    this.buddyMaterial.dispose()
    this.groundMaterial.dispose()
    this.groundGeometry.dispose()
    this.filters.dispose()
    this.composer.dispose()
    this.renderer.dispose()
  }

  private syncCamera(params: VirtualBuddyParams): void {
    const dist = params.cameraDistance
    const camY = params.cameraHeight
    // Horizontal look at the same height: visible span at z=0 is
    // [camY − dist·tan(fov/2), camY + dist·tan(fov/2)]. Defaults pick camY so
    // the lower edge sits on the floor (feet on the bottom of the frame).
    this.camera.position.set(0, camY, dist)
    this.camera.lookAt(0, camY - FEET_FRAME_MARGIN, 0)
  }

  private syncBrightness(params: VirtualBuddyParams): void {
    // Lights track brightness so unfiltered meshes and shadows lift together.
    // The filter pass also multiplies by the same gain (including Look = Off),
    // so palette-locked looks like Game Boy still respond to the control.
    const gain = Math.max(0, params.brightness)
    const rimGain = Math.max(0, params.rimLightStrength ?? 1)
    this.hemiLight.intensity = this.baseHemiIntensity * gain
    this.keyLight.intensity = this.baseKeyIntensity * gain
    this.rimLight.intensity = this.baseRimIntensity * gain * rimGain
  }

  private syncSceneLook(params: VirtualBuddyParams): void {
    const groundHex = (params.groundColor >>> 0) & 0xffffff
    this.groundMaterial.color.setHex(groundHex)
    // Bounce light from the hemi ground channel tracks the floor colour.
    this.hemiLight.groundColor.setHex(groundHex)

    const leftHex = (params.leftLightColor >>> 0) & 0xffffff
    this.rimLight.color.setHex(leftHex)
  }

  private syncBounds(params: VirtualBuddyParams): void {
    const key = `${this.width}x${this.height}|${params.cameraDistance}|${params.playDepth}`
    if (key === this.boundsKey || !this.physics) {
      return
    }
    this.boundsKey = key

    // Frustum size at the play plane (z = 0), so nothing can drift off-screen.
    const visibleHeight =
      2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * params.cameraDistance
    const visibleWidth = visibleHeight * (this.width / this.height)

    this.bounds = {
      halfWidth: Math.max(0.6, visibleWidth / 2 - 0.15),
      halfDepth: Math.max(0.3, params.playDepth),
      ceiling: Math.max(3, visibleHeight * 1.5),
    }
    this.physics.setBounds(this.bounds)
  }

  private addBuddy(
    origin: THREE.Vector3,
    params: VirtualBuddyParams,
    dropIn = true,
    model: LoadedModel | null = this.activeModel,
    modelIndex = Math.round(params.model),
    randomizeHue = false,
  ): void {
    if (!this.physics) {
      return
    }

    const resolvedModelIndex = Math.max(
      0,
      Math.min(MODELS.length - 1, Math.round(modelIndex)),
    )
    const rig = model?.rig ?? primitiveRig
    const bindPose = new BindPoseSource(rig)
    const ragdoll = new Ragdoll(this.physics, rig, params.bodyScale, {
      origin,
      density: BASE_DENSITY * params.weight,
      friction: params.friction,
      restitution: params.bounce,
      linearDamping: params.airDrag,
      // Matched to linear rather than doubled: extra angular damping is what
      // stops a thrown buddy tumbling, and the tumble is most of the appeal.
      angularDamping: params.airDrag,
    })

    const modelEntry = MODELS[resolvedModelIndex] ?? MODELS[0]
    const partDefs =
      model?.parts ??
      modelEntry.parts ??
      [
        {
          id: 'color',
          label: 'Color',
          match: '.',
          channel: 'albedo' as const,
          defaultColor: (modelEntry.defaultColor ?? 0xffffff) >>> 0,
        },
      ]
    const partDefaults: Record<string, number> = {}
    const partColors: Record<string, number> = {}
    for (const part of partDefs) {
      const hex = part.defaultColor >>> 0
      partDefaults[part.id] = hex
      partColors[part.id] = hex
    }
    if (randomizeHue) {
      applyRandomCostumeHue(modelEntry.id, partDefs, partColors)
    }
    const primaryTint =
      partColors[partDefs[0]?.id ?? 'color'] ??
      ((model?.defaultTint ?? modelEntry.defaultColor ?? 0xffffff) >>> 0)

    const capsuleMaterial = this.buddyMaterial.clone()
    capsuleMaterial.color.setHex(primaryTint)
    const view = new PrimitiveView(ragdoll, capsuleMaterial)
    this.scene.add(view.group)

    let skin: SkinnedView | null = null
    let anim: AnimationPoseSource | null = null
    if (model) {
      // Physics starts above the stage, but clips are authored against the
      // floor. Sharing the elevated drop origin with the hidden animation rig
      // makes recovery add that height a second time and launch the buddy.
      const animationOrigin = new THREE.Vector3(origin.x, 0, origin.z)
      anim = new AnimationPoseSource(
        model,
        rig,
        params.bodyScale,
        animationOrigin,
      )
      skin = new SkinnedView(ragdoll, model)
      // Bones without a rigid body (fingers, shoulders, neck) read their
      // rotation from the clip rather than staying pinned to bind pose.
      skin.setAnimationSource(anim)
      skin.setPartColors(partColors)
      this.scene.add(skin.group)
    }

    // With a character on, capsules become the debug overlay; without one they
    // are the character, so they stay on regardless of the toggle.
    view.group.visible = skin ? params.showPhysicsBodies > 0.5 : true

    const animationRate =
      ANIMATION_RATE_MIN + Math.random() * ANIMATION_RATE_VARIANCE
    // Prefer Auto for new characters so the stage feels alive; fall back to
    // the global Motion default if Auto is missing from the registry.
    const autoIndex = MOTIONS.findIndex((entry) => entry.auto)
    const defaultMotion =
      autoIndex >= 0 ? autoIndex : Math.round(params.motion)
    const buddy: Buddy = {
      id: this.nextBuddyId++,
      modelIndex: resolvedModelIndex,
      modelLabel: modelEntry.label,
      motionIndex: defaultMotion,
      partColors,
      partDefaults,
      capsuleMaterial,
      ragdoll,
      bindPose,
      view,
      skin,
      anim,
      pose: bindPose,
      rootSlot: rig.segments.find((segment) => !segment.parent)?.slot ?? null,
      motionKey: '',
      motionBlend: 1,
      rootTransition: null,
      limp: false,
      spawnDropping: dropIn,
      spawnTimer: 0,
      spawnSettledAt: null,
      spawnRecoveryDelay:
        SPAWN_RECOVERY_DELAY_MIN +
        Math.random() * SPAWN_RECOVERY_DELAY_VARIANCE,
      rootCompliant: false,
      limpTimer: 0,
      balanceTimer: 0,
      autoActive: false,
      autoPhase: 'idle',
      autoClip: 'Idle',
      autoTimer: this.nextAutoIdleDuration(),
      animationRate,
      baseAnimationRate: animationRate,
      idlePhaseOffset: Math.random(),
      heading: 0,
      destination: null,
      partnerId: null,
      handshakeBase: null,
      socialCooldown: 2 + Math.random() * 3,
      turnStartHeading: 0,
      turnTargetHeading: 0,
      turnElapsed: 0,
      turnDuration: 0,
      turnNextPhase: 'idle',
      pendingClip: 'Idle',
      walkBlend: 0,
    }
    this.buddies.push(buddy)
    if (!dropIn && anim) {
      // Start the host's controller on an already sampled standing pose. If
      // syncMotion sees no previous clip it intentionally begins with weak
      // recovery authority, which would make a newly standing host sag first.
      anim.play('Idle', new THREE.Vector3(origin.x, 0, origin.z))
      anim.setNormalizedTime(buddy.idlePhaseOffset)
      buddy.pose = anim
    }
    anim?.setYaw(0)
    this.notifyBuddiesChange()
  }

  /**
   * Applies the Motion control to every buddy.
   *
   * Playing a clip gives the dynamic root a spring target, so the body performs
   * the motion while remaining able to absorb impacts and topple. Every limb
   * stays dynamic and grabbable — yank an arm mid-dance and muscle tone fights
   * you for it.
   */
  private syncMotion(dt: number): void {
    for (const buddy of this.buddies) {
      const motion = MOTIONS[buddy.motionIndex] ?? MOTIONS[0]

      if (
        buddy.spawnDropping &&
        !this.advanceSpawnDrop(buddy, dt, Boolean(motion.auto))
      ) {
        continue
      }

      // Recovery only starts once released, grounded, and settled. A timer by
      // itself is unsafe in low gravity: it can expire while a thrown buddy is
      // still airborne, causing the standing-pose servos to fight a tumbling
      // body and launch it away.
      if (buddy.limp && !this.grab?.isGrabbing) {
        buddy.limpTimer = Math.max(0, buddy.limpTimer - dt)
        if (
          buddy.limpTimer <= 0 &&
          this.canBeginRecovery(buddy)
        ) {
          this.setLimp(buddy, false)
          if (motion.auto) {
            // Stand back up rather than popping straight into an idle.
            buddy.autoPhase = 'recover'
            buddy.autoClip = pickRecoveryClip()
            buddy.autoTimer =
              (buddy.anim?.getClipDuration(buddy.autoClip) ?? 4) /
              buddy.animationRate
            buddy.destination = null
            this.clearPartner(buddy)
          }
        }
      }

      let selectedClip = motion.clip
      if (motion.auto) {
        if (!buddy.autoActive) {
          buddy.autoActive = true
          buddy.autoPhase = 'idle'
          buddy.autoClip = 'Idle'
          buddy.autoTimer = this.nextAutoIdleDuration()
        }
        selectedClip = this.advanceAuto(
          buddy,
          dt,
          this.grab?.grabbedRagdoll === buddy.ragdoll,
        )
      } else {
        if (buddy.autoActive) {
          buddy.destination = null
          this.clearPartner(buddy)
        }
        buddy.autoActive = false
      }

      const clip = buddy.anim && !buddy.limp ? selectedClip : null
      const key = `${motion.auto ? 'auto:' : ''}${buddy.limp ? 'limp' : clip ?? 'ragdoll'}`
      if (key === buddy.motionKey) {
        // Navigation moves the stage anchor without changing the clip key.
        if (motion.auto && !buddy.limp) {
          this.updateNavigation(buddy, dt)
        }
        continue
      }
      buddy.motionKey = key
      // A clip that inherits a sprawled stance needs room to walk its feet back
      // underneath itself before the balance watchdog is entitled to an opinion.
      buddy.balanceTimer = -BALANCE_SETTLE_SECONDS

      const root = buddy.rootSlot ? buddy.ragdoll.parts.get(buddy.rootSlot) : undefined
      const translation = root?.body.translation()
      const rotation = root?.body.rotation()
      const currentPosition = translation
        ? new THREE.Vector3(translation.x, translation.y, translation.z)
        : undefined

      const previousClip = buddy.anim?.activeClipName ?? null
      buddy.anim?.play(clip, currentPosition)
      if (clip === 'Idle' && previousClip !== 'Idle') {
        buddy.anim?.setNormalizedTime(buddy.idlePhaseOffset)
      }
      buddy.anim?.setYaw(buddy.heading)
      buddy.pose = clip && buddy.anim ? buddy.anim : buddy.bindPose

      if (clip && root && currentPosition && rotation) {
        const touchesRecovery =
          isRecoveryClip(previousClip) || isRecoveryClip(clip)
        const continuingPerformance =
          previousClip !== null && !touchesRecovery
        if (continuingPerformance) {
          // The AnimationMixer already blends two live poses. Preserve limb
          // momentum and full pose authority here; damping both a second time
          // is what made Idle -> Wave hesitate before the arm started moving.
          buddy.motionBlend = 1
          buddy.rootTransition = null
        } else {
          // Recovery begins with little authority so a body on the floor is
          // gathered rather than yanked. The opposite handoff must retain most
          // of its authority: dropping a dynamic pelvis back to 20% at the end
          // of Get Up briefly removes its gravity support and sinks the body's
          // weight onto the hips before Idle catches it again.
          buddy.motionBlend = isRecoveryClip(clip)
            ? 0.05
            : isRecoveryClip(previousClip)
              ? 0.85
              : 0.2
          buddy.rootTransition = {
            fromPosition: currentPosition,
            fromRotation: new THREE.Quaternion(
              rotation.x,
              rotation.y,
              rotation.z,
              rotation.w,
            ),
            duration: touchesRecovery
              ? GET_UP_BLEND_SECONDS
              : MOTION_BLEND_SECONDS,
            // Entering from free physics or beginning a recovery can be nearly
            // 180 degrees from the authored world pose. Recovery -> Idle is
            // already gathered, so absolute targets can fade in immediately
            // instead of withholding torso support until the final frame.
            useRelativePose:
              previousClip === null || isRecoveryClip(clip),
          }
          // Clear residual spin only when entering animation from free physics.
          // Recovery -> Idle must retain the clip's outgoing momentum or the
          // torso visibly pauses before the new pose pulls it forward.
          if (previousClip === null) {
            for (const part of buddy.ragdoll.parts.values()) {
              if (part.segment.parent) {
                part.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
                part.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
              }
            }
          }
        }
      } else {
        buddy.motionBlend = 1
        buddy.rootTransition = null
      }

      // A kinematic body has infinite effective mass and pins the complete
      // articulated chain at the waist. Keep the pelvis physical at all times;
      // `driveRootToward` above supplies animation preference without removing
      // its ability to receive weight, impacts, or fall with displaced legs.
      root?.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true)

      if (motion.auto && !buddy.limp) {
        this.updateNavigation(buddy, dt)
      }
    }
  }

  /** Returns true on the frame an entrance has settled and animation may begin. */
  private advanceSpawnDrop(
    buddy: Buddy,
    dt: number,
    auto: boolean,
  ): boolean {
    buddy.spawnTimer += dt
    buddy.anim?.play(null)
    buddy.pose = buddy.bindPose
    buddy.rootTransition = null
    buddy.motionKey = 'spawn-drop'

    const root = buddy.rootSlot
      ? buddy.ragdoll.parts.get(buddy.rootSlot)
      : undefined
    root?.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true)

    let nearFloor = false
    for (const part of buddy.ragdoll.parts.values()) {
      if (part.body.translation().y <= 0.28 * buddy.ragdoll.scale) {
        nearFloor = true
        break
      }
    }
    const rootVelocity = root?.body.linvel()
    const slowEnough = !rootVelocity || Math.abs(rootVelocity.y) < 1.2
    const settled =
      buddy.spawnTimer >= SPAWN_MIN_FALL_SECONDS &&
      nearFloor &&
      slowEnough
    if (buddy.spawnSettledAt === null) {
      if (!settled && buddy.spawnTimer < SPAWN_FORCE_FINISH_SECONDS) {
        return false
      }
      buddy.spawnSettledAt = buddy.spawnTimer
    }

    if (
      buddy.spawnTimer - buddy.spawnSettledAt <
      buddy.spawnRecoveryDelay
    ) {
      return false
    }

    buddy.spawnDropping = false
    buddy.motionKey = ''
    if (auto) {
      buddy.autoActive = true
      buddy.autoPhase = 'recover'
      buddy.autoClip = pickRecoveryClip()
      buddy.autoTimer =
        (buddy.anim?.getClipDuration(buddy.autoClip) ?? 4) /
        buddy.animationRate
    }
    return true
  }

  /**
   * Auto behaves like a restrained character, not a playlist: mostly Idle,
   * occasional walks and gestures, paired handshakes when company allows, and
   * a one-shot recovery after being handled.
   */
  private advanceAuto(buddy: Buddy, dt: number, paused: boolean): string | null {
    if (buddy.socialCooldown > 0) {
      buddy.socialCooldown = Math.max(0, buddy.socialCooldown - dt)
    }

    // Never change clips under a user's hand. Aside from looking like a pop,
    // switching resets target poses and can make the newly selected animation
    // pull against the limb they are deliberately positioning.
    if (paused) {
      if (buddy.partnerId !== null) {
        this.cancelHandshake(buddy)
      }
      buddy.destination = null
      return buddy.autoClip
    }

    if (buddy.autoPhase === 'handshake') {
      return this.advanceHandshake(buddy, dt)
    }

    if (buddy.autoPhase === 'postInteractionWait') {
      buddy.autoTimer -= dt
      if (buddy.autoTimer > 0) {
        return 'Idle'
      }
      this.beginAuthoredTurn(buddy, buddy.turnTargetHeading, 'idle')
      return buddy.autoClip
    }

    if (
      buddy.autoPhase === 'turn' ||
      buddy.autoPhase === 'walk' ||
      buddy.autoPhase === 'handshakeApproach'
    ) {
      return buddy.autoClip
    }

    buddy.autoTimer -= dt
    if (buddy.autoTimer > 0) {
      return buddy.autoClip
    }

    if (buddy.autoPhase === 'recover') {
      if (Math.random() < CAMERA_SETTLE_CHANCE) {
        this.beginCameraTurn(buddy, 'idle')
        return buddy.autoClip
      }
      return this.enterIdle(buddy)
    }

    if (buddy.autoPhase === 'gesture') {
      return this.enterIdle(buddy)
    }

    // Random timers alone still overlap heavily because gestures are several
    // seconds long. Defer this elapsed buddy when enough of the crowd is
    // already performing, preserving visibly quiet characters between actions.
    if (!this.hasAutoActionCapacity(buddy)) {
      buddy.autoTimer =
        AUTO_ACTION_RETRY_MIN_SECONDS +
        Math.random() * AUTO_ACTION_RETRY_VARIANCE_SECONDS
      return buddy.autoClip
    }

    // Idle timer elapsed: paired dance, handshake, walk, or solo gesture.
    if (this.tryStartFacingDance(buddy)) {
      return buddy.autoClip
    }

    if (this.tryStartHandshake(buddy)) {
      return buddy.autoClip
    }

    if (Math.random() < WALK_CHANCE && this.beginWalk(buddy)) {
      return buddy.autoClip
    }

    this.beginFocusedGesture(
      buddy,
      Math.random() < 0.7 ? 'Wave' : 'Dance',
    )
    return buddy.autoClip
  }

  private beginFocusedGesture(buddy: Buddy, clip: string): void {
    const position = this.buddyPlanarPosition(buddy)
    if (!position) {
      buddy.autoPhase = 'gesture'
      buddy.autoClip = clip
      buddy.autoTimer =
        (buddy.anim?.getClipDuration(clip) ?? 3) / buddy.animationRate
      return
    }

    let targetX = this.camera.position.x
    let targetZ = this.camera.position.z
    if (Math.random() < MODEL_GESTURE_FOCUS_CHANCE) {
      const candidates = this.buddies.filter(
        (candidate) =>
          candidate.id !== buddy.id &&
          candidate.autoActive &&
          !candidate.limp &&
          (candidate.autoPhase === 'idle' ||
            candidate.autoPhase === 'gesture') &&
          this.grab?.grabbedRagdoll !== candidate.ragdoll,
      )
      const focus =
        candidates[Math.floor(Math.random() * candidates.length)]
      const focusPosition = focus
        ? this.buddyPlanarPosition(focus)
        : null
      if (focusPosition) {
        targetX = focusPosition.x
        targetZ = focusPosition.z
      }
    }

    buddy.pendingClip = clip
    this.beginAuthoredTurn(
      buddy,
      Math.atan2(targetX - position.x, targetZ - position.z),
      'gesture',
    )
  }

  private beginCameraTurn(
    buddy: Buddy,
    nextPhase: 'idle' | 'gesture',
  ): void {
    const position = this.buddyPlanarPosition(buddy)
    if (!position) {
      this.enterIdle(buddy)
      return
    }
    this.beginAuthoredTurn(
      buddy,
      Math.atan2(
        this.camera.position.x - position.x,
        this.camera.position.z - position.z,
      ),
      nextPhase,
    )
  }

  private enterIdle(buddy: Buddy): string {
    buddy.autoPhase = 'idle'
    buddy.autoClip = 'Idle'
    buddy.autoTimer = this.nextAutoIdleDuration()
    buddy.destination = null
    return buddy.autoClip
  }

  private beginWalk(buddy: Buddy, destination?: THREE.Vector3): boolean {
    const origin = this.buddyPlanarPosition(buddy)
    if (!origin) {
      return false
    }

    const target = destination ?? this.pickWalkDestination(origin)
    if (!target) {
      return false
    }

    buddy.destination = target
    buddy.autoTimer = 0
    _navDelta.set(target.x - origin.x, 0, target.z - origin.z)
    const desiredYaw = Math.atan2(_navDelta.x, _navDelta.z)
    this.beginAuthoredTurn(
      buddy,
      desiredYaw,
      buddy.partnerId !== null ? 'handshakeApproach' : 'walk',
    )
    return true
  }

  private beginAuthoredTurn(
    buddy: Buddy,
    desiredYaw: number,
    nextPhase: TurnNextPhase,
  ): void {
    let delta = desiredYaw - buddy.heading
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2

    if (Math.abs(delta) < THREE.MathUtils.degToRad(8)) {
      buddy.heading += delta
      buddy.anim?.setYaw(buddy.heading)
      this.enterTurnNextPhase(buddy, nextPhase)
      return
    }

    const ninety = Math.abs(delta) >= THREE.MathUtils.degToRad(67.5)
    const left = delta < 0
    const clip = `${ninety ? 'Turn90' : 'Turn45'}${left ? 'Left' : ''}`
    buddy.turnStartHeading = buddy.heading
    // Keep the target in the same unwrapped angular neighbourhood as start.
    buddy.turnTargetHeading = buddy.heading + delta
    buddy.turnElapsed = 0
    buddy.turnDuration =
      (buddy.anim?.getClipDuration(clip) ?? (ninety ? 1 : 1.5)) /
      buddy.animationRate
    buddy.turnNextPhase = nextPhase
    buddy.autoPhase = 'turn'
    buddy.autoClip = clip
    buddy.motionKey = ''
  }

  private updateAuthoredTurn(buddy: Buddy, dt: number): void {
    buddy.turnElapsed = Math.min(
      buddy.turnDuration,
      buddy.turnElapsed + dt,
    )
    const raw =
      buddy.turnDuration > 1e-5
        ? buddy.turnElapsed / buddy.turnDuration
        : 1
    const eased = raw * raw * (3 - 2 * raw)
    buddy.heading = THREE.MathUtils.lerp(
      buddy.turnStartHeading,
      buddy.turnTargetHeading,
      eased,
    )
    buddy.anim?.setYaw(buddy.heading)

    if (raw < 1) {
      return
    }

    this.enterTurnNextPhase(buddy, buddy.turnNextPhase)
  }

  private enterTurnNextPhase(
    buddy: Buddy,
    next: TurnNextPhase,
  ): void {
    buddy.motionKey = ''
    if (next === 'idle') {
      this.enterIdle(buddy)
      return
    }
    if (next === 'gesture') {
      buddy.autoPhase = 'gesture'
      buddy.autoClip = buddy.pendingClip
      buddy.autoTimer =
        (buddy.anim?.getClipDuration(buddy.autoClip) ?? 3) /
        buddy.animationRate
      return
    }
    buddy.autoPhase = next
    buddy.autoClip = 'Walk'
    buddy.walkBlend = 0
  }

  private pickWalkDestination(from: THREE.Vector3): THREE.Vector3 | null {
    const halfW = Math.max(0.2, this.bounds.halfWidth - NAV_MARGIN)
    const halfD = Math.max(0.15, this.bounds.halfDepth - NAV_MARGIN)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const x = THREE.MathUtils.randFloat(-halfW, halfW)
      const z = THREE.MathUtils.randFloat(-halfD, halfD)
      const dx = x - from.x
      const dz = z - from.z
      if (dx * dx + dz * dz < 0.35 * 0.35) {
        continue
      }
      return new THREE.Vector3(x, 0, z)
    }
    return null
  }

  private buddyPlanarPosition(buddy: Buddy): THREE.Vector3 | null {
    if (buddy.anim?.getRootAnchor(_anchorScratch)) {
      return _anchorScratch.clone().setY(0)
    }
      const root = buddy.rootSlot ? buddy.ragdoll.parts.get(buddy.rootSlot) : undefined
    const translation = root?.body.translation()
    if (!translation) {
      return null
    }
    return new THREE.Vector3(translation.x, 0, translation.z)
  }

  private updateNavigation(buddy: Buddy, dt: number): void {
    if (
      buddy.autoPhase !== 'turn' &&
      buddy.autoPhase !== 'walk' &&
      buddy.autoPhase !== 'handshakeApproach'
    ) {
      return
    }

    if (buddy.autoPhase === 'turn') {
      this.updateAuthoredTurn(buddy, dt)
      return
    }

    const destination = buddy.destination
    if (!destination) {
      // Arrived early for a handshake — face the partner and wait.
      if (buddy.autoPhase === 'handshakeApproach' && buddy.partnerId !== null) {
        const partner = this.buddies.find((candidate) => candidate.id === buddy.partnerId)
        const a = this.buddyPlanarPosition(buddy)
        const b = partner ? this.buddyPlanarPosition(partner) : null
        if (a && b) {
          this.turnToward(buddy, Math.atan2(b.x - a.x, b.z - a.z), dt)
        }
        if (partner && partner.destination === null) {
          this.beginHandshakeClip(buddy)
        }
        return
      }
      this.enterIdle(buddy)
      buddy.motionKey = ''
      return
    }

    const position = this.buddyPlanarPosition(buddy)
    if (!position) {
      return
    }

    _navDelta.set(destination.x - position.x, 0, destination.z - position.z)
    const distance = _navDelta.length()
    if (distance <= 0.08) {
      if (buddy.partnerId !== null) {
        this.beginHandshakeClip(buddy)
      } else {
        if (Math.random() < CAMERA_SETTLE_CHANCE) {
          this.beginCameraTurn(buddy, 'idle')
        } else {
          this.enterIdle(buddy)
          buddy.motionKey = ''
        }
      }
      return
    }

    buddy.walkBlend = Math.min(
      1,
      buddy.walkBlend + dt / WALK_ACCEL_SECONDS,
    )
    const acceleration =
      buddy.walkBlend * buddy.walkBlend * (3 - 2 * buddy.walkBlend)
    // Ease the stage anchor down before the destination, allowing the final
    // planted foot to absorb the walk before an authored turn takes over.
    const deceleration = THREE.MathUtils.lerp(
      0.18,
      1,
      THREE.MathUtils.smoothstep(distance, 0.08, WALK_DECEL_DISTANCE),
    )
    const motionGain = acceleration * deceleration
    buddy.anim?.setPlaybackScale(
      THREE.MathUtils.lerp(
        WALK_MIN_PLAYBACK_SCALE,
        1,
        motionGain,
      ),
    )
    const step = Math.min(
      distance,
      WALK_SPEED *
        buddy.animationRate *
        motionGain *
        dt,
    )
    _navDelta.normalize().multiplyScalar(step)
    const nextX = THREE.MathUtils.clamp(
      position.x + _navDelta.x,
      -(this.bounds.halfWidth - NAV_MARGIN),
      this.bounds.halfWidth - NAV_MARGIN,
    )
    const nextZ = THREE.MathUtils.clamp(
      position.z + _navDelta.z,
      -(this.bounds.halfDepth - NAV_MARGIN),
      this.bounds.halfDepth - NAV_MARGIN,
    )
    buddy.anim?.setRootAnchorXZ(nextX, nextZ)
    buddy.autoClip = 'Walk'
  }

  /** Returns true once the buddy is facing `desiredYaw`. */
  private turnToward(buddy: Buddy, desiredYaw: number, dt: number): boolean {
    let delta = desiredYaw - buddy.heading
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    const maxStep = TURN_RATE * dt
    if (Math.abs(delta) <= maxStep) {
      buddy.heading = desiredYaw
      buddy.anim?.setYaw(buddy.heading)
      return true
    }
    buddy.heading += Math.sign(delta) * maxStep
    buddy.anim?.setYaw(buddy.heading)
    return false
  }

  /**
   * Starts an intentional paired dance when two idle buddies are already
   * acknowledging one another. Their personal playback rates remain intact,
   * so the pair moves together without becoming frame-perfect copies.
   */
  private tryStartFacingDance(buddy: Buddy): boolean {
    if (
      buddy.autoPhase !== 'idle' ||
      buddy.partnerId !== null ||
      buddy.socialCooldown > 0 ||
      buddy.limp ||
      Math.random() > FACING_DANCE_CHANCE
    ) {
      return false
    }

    const a = this.buddyPlanarPosition(buddy)
    if (!a) {
      return false
    }

    const candidates = this.buddies.filter((candidate) => {
      if (
        candidate.id === buddy.id ||
        !candidate.autoActive ||
        candidate.autoPhase !== 'idle' ||
        candidate.partnerId !== null ||
        candidate.socialCooldown > 0 ||
        candidate.limp ||
        this.grab?.grabbedRagdoll === candidate.ragdoll
      ) {
        return false
      }

      const b = this.buddyPlanarPosition(candidate)
      if (!b) {
        return false
      }
      const distance = Math.hypot(b.x - a.x, b.z - a.z)
      if (distance > FACING_DANCE_MAX_DISTANCE || distance < 0.2) {
        return false
      }

      const towardCandidate = Math.atan2(b.x - a.x, b.z - a.z)
      const towardBuddy = Math.atan2(a.x - b.x, a.z - b.z)
      return (
        this.headingDifference(buddy.heading, towardCandidate) <=
          FACING_DANCE_MAX_ANGLE &&
        this.headingDifference(candidate.heading, towardBuddy) <=
          FACING_DANCE_MAX_ANGLE
      )
    })

    const partner = candidates[Math.floor(Math.random() * candidates.length)]
    if (!partner) {
      return false
    }

    for (const dancer of [buddy, partner]) {
      dancer.autoPhase = 'gesture'
      dancer.autoClip = 'Dance'
      dancer.autoTimer =
        (dancer.anim?.getClipDuration('Dance') ?? 3) / dancer.animationRate
      dancer.destination = null
      dancer.socialCooldown =
        HANDSHAKE_COOLDOWN_MIN +
        Math.random() * HANDSHAKE_COOLDOWN_VARIANCE
    }
    return true
  }

  private headingDifference(first: number, second: number): number {
    let delta = second - first
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    return Math.abs(delta)
  }

  /** Returns true if a pair was reserved and both partners began approaching. */
  private tryStartHandshake(buddy: Buddy): boolean {
    if (
      buddy.partnerId !== null ||
      buddy.socialCooldown > 0 ||
      buddy.autoPhase !== 'idle' ||
      buddy.limp ||
      Math.random() > HANDSHAKE_CHANCE
    ) {
      return false
    }

    const partner = this.buddies.find(
      (candidate) =>
        candidate.id !== buddy.id &&
        candidate.autoActive &&
        candidate.autoPhase === 'idle' &&
        candidate.partnerId === null &&
        candidate.socialCooldown <= 0 &&
        !candidate.limp &&
        this.grab?.grabbedRagdoll !== candidate.ragdoll,
    )
    if (!partner) {
      return false
    }

    const a = this.buddyPlanarPosition(buddy)
    const b = this.buddyPlanarPosition(partner)
    if (!a || !b) {
      return false
    }

    // Meet halfway, then stand a handshake-width apart along the pair axis.
    const midX = (a.x + b.x) * 0.5
    const midZ = (a.z + b.z) * 0.5
    let axisX = b.x - a.x
    let axisZ = b.z - a.z
    const axisLen = Math.hypot(axisX, axisZ)
    if (axisLen < 1e-3) {
      axisX = 1
      axisZ = 0
    } else {
      axisX /= axisLen
      axisZ /= axisLen
    }

    const half = HANDSHAKE_DISTANCE * 0.5
    const destA = new THREE.Vector3(midX - axisX * half, 0, midZ - axisZ * half)
    const destB = new THREE.Vector3(midX + axisX * half, 0, midZ + axisZ * half)
    this.clampToStage(destA)
    this.clampToStage(destB)

    buddy.partnerId = partner.id
    partner.partnerId = buddy.id
    this.beginWalk(buddy, destA)
    this.beginWalk(partner, destB)
    buddy.motionKey = ''
    partner.motionKey = ''
    return true
  }

  private clampToStage(point: THREE.Vector3): void {
    point.x = THREE.MathUtils.clamp(
      point.x,
      -(this.bounds.halfWidth - NAV_MARGIN),
      this.bounds.halfWidth - NAV_MARGIN,
    )
    point.z = THREE.MathUtils.clamp(
      point.z,
      -(this.bounds.halfDepth - NAV_MARGIN),
      this.bounds.halfDepth - NAV_MARGIN,
    )
  }

  private beginHandshakeClip(buddy: Buddy): void {
    const partner = this.buddies.find((candidate) => candidate.id === buddy.partnerId)
    if (!partner) {
      this.clearPartner(buddy)
      this.enterIdle(buddy)
      buddy.motionKey = ''
      return
    }

    const partnerReady =
      partner.autoPhase === 'handshakeApproach' ||
      partner.autoPhase === 'turn' ||
      partner.autoPhase === 'handshake' ||
      (partner.destination === null && partner.partnerId === buddy.id)

    const a = this.buddyPlanarPosition(buddy)
    const b = this.buddyPlanarPosition(partner)
    if (a && b) {
      this.turnToward(buddy, Math.atan2(b.x - a.x, b.z - a.z), 1)
      this.turnToward(partner, Math.atan2(a.x - b.x, a.z - b.z), 1)
    }

    // Wait until the partner has also arrived (or is already shaking).
    if (
      partner.autoPhase !== 'handshake' &&
      partner.destination !== null &&
      partner.autoPhase !== 'handshakeApproach'
    ) {
      // Partner still turning/walking; park this buddy facing them.
      buddy.autoPhase = 'handshakeApproach'
      buddy.autoClip = 'Idle'
      buddy.destination = null
      return
    }

    if (!partnerReady && partner.autoPhase !== 'handshake') {
      buddy.autoPhase = 'handshakeApproach'
      buddy.autoClip = 'Idle'
      buddy.destination = null
      return
    }

    if (a && b) {
      buddy.handshakeBase = a.clone()
      partner.handshakeBase = b.clone()
    }
    const duration = buddy.anim?.getClipDuration('Shake Hands') ?? 4
    // Shared tempo so the clasp does not drift out of phase.
    const sharedRate = (buddy.animationRate + partner.animationRate) * 0.5
    buddy.animationRate = sharedRate
    partner.animationRate = sharedRate

    buddy.autoPhase = 'handshake'
    partner.autoPhase = 'handshake'
    buddy.autoClip = 'Shake Hands'
    partner.autoClip = 'Shake Hands'
    buddy.autoTimer = duration / sharedRate
    partner.autoTimer = duration / sharedRate
    buddy.destination = null
    partner.destination = null
    buddy.motionKey = ''
    partner.motionKey = ''
  }

  private advanceHandshake(buddy: Buddy, dt: number): string | null {
    const partner = this.buddies.find((candidate) => candidate.id === buddy.partnerId)
    if (!partner || partner.limp || this.grab?.grabbedRagdoll === partner.ragdoll) {
      this.cancelHandshake(buddy)
      return this.enterIdle(buddy)
    }

    // Keep both mixers on the same frame of the clip.
    if (buddy.id < partner.id && buddy.anim && partner.anim) {
      const time = buddy.anim.getNormalizedTime()
      partner.anim.setNormalizedTime(time)
      this.updateHandshakeSpacing(buddy, partner, time)
    }

    buddy.autoTimer -= dt
    if (buddy.autoTimer > 0) {
      return 'Shake Hands'
    }

    this.finishHandshake(buddy)
    return buddy.autoClip
  }

  private updateHandshakeSpacing(
    first: Buddy,
    second: Buddy,
    normalizedTime: number,
  ): void {
    const firstBase = first.handshakeBase
    const secondBase = second.handshakeBase
    if (!firstBase || !secondBase) {
      return
    }

    _navDelta
      .set(
        secondBase.x - firstBase.x,
        0,
        secondBase.z - firstBase.z,
      )
    if (_navDelta.lengthSq() < 1e-6) {
      return
    }
    _navDelta.normalize()

    // Step into the reach, hold through the clasp, then return to the approach
    // marks before the independently timed turn-away begins.
    const enter = THREE.MathUtils.smoothstep(normalizedTime, 0.08, 0.32)
    const leave =
      1 - THREE.MathUtils.smoothstep(normalizedTime, 0.76, 0.97)
    const inset = HANDSHAKE_INSET * enter * leave
    first.anim?.setRootAnchorXZ(
      firstBase.x + _navDelta.x * inset,
      firstBase.z + _navDelta.z * inset,
    )
    second.anim?.setRootAnchorXZ(
      secondBase.x - _navDelta.x * inset,
      secondBase.z - _navDelta.z * inset,
    )
  }

  private finishHandshake(buddy: Buddy): void {
    const partner = this.buddies.find((candidate) => candidate.id === buddy.partnerId)
    const direction = Math.random() < 0.5 ? -1 : 1
    this.clearPartner(buddy)
    this.scheduleTurnAway(buddy, direction)
    if (partner) {
      this.scheduleTurnAway(partner, direction)
    }
  }

  private scheduleTurnAway(buddy: Buddy, direction: number): void {
    buddy.animationRate = buddy.baseAnimationRate
    buddy.socialCooldown =
      HANDSHAKE_COOLDOWN_MIN +
      Math.random() * HANDSHAKE_COOLDOWN_VARIANCE
    buddy.autoPhase = 'postInteractionWait'
    buddy.autoClip = 'Idle'
    // Each participant decides and turns on its own beat.
    buddy.autoTimer = 0.35 + Math.random() * 1.5
    const angle =
      Math.random() < 0.55
        ? THREE.MathUtils.degToRad(45)
        : THREE.MathUtils.degToRad(90)
    buddy.turnTargetHeading = buddy.heading + direction * angle
    buddy.destination = null
    buddy.motionKey = ''
  }

  private cancelHandshake(buddy: Buddy): void {
    const partner = this.buddies.find((candidate) => candidate.id === buddy.partnerId)
    buddy.animationRate = buddy.baseAnimationRate
    this.clearPartner(buddy)
    buddy.destination = null
    if (partner) {
      partner.animationRate = partner.baseAnimationRate
      this.clearPartner(partner)
      partner.destination = null
      if (
        partner.autoPhase === 'handshake' ||
        partner.autoPhase === 'handshakeApproach' ||
        partner.autoPhase === 'turn' ||
        partner.autoPhase === 'walk'
      ) {
        this.enterIdle(partner)
        partner.motionKey = ''
      }
    }
  }

  private clearPartner(buddy: Buddy): void {
    buddy.handshakeBase = null
    if (buddy.partnerId === null) {
      return
    }
    const partner = this.buddies.find((candidate) => candidate.id === buddy.partnerId)
    buddy.partnerId = null
    if (partner && partner.partnerId === buddy.id) {
      partner.partnerId = null
      partner.handshakeBase = null
    }
  }

  private nextAutoIdleDuration(): number {
    return AUTO_IDLE_MIN_SECONDS + Math.random() * AUTO_IDLE_VARIANCE_SECONDS
  }

  private hasAutoActionCapacity(buddy: Buddy): boolean {
    const active = this.buddies.reduce((count, candidate) => {
      if (
        candidate.id === buddy.id ||
        candidate.limp ||
        candidate.spawnDropping ||
        candidate.autoPhase === 'idle' ||
        candidate.autoPhase === 'postInteractionWait'
      ) {
        return count
      }
      return count + 1
    }, 0)
    const capacity = Math.max(
      1,
      Math.floor(this.buddies.length * AUTO_ACTIVE_FRACTION),
    )
    return active < capacity
  }

  private nextLimpRecoverDelay(): number {
    return (
      LIMP_RECOVER_MIN_SECONDS +
      Math.random() * LIMP_RECOVER_VARIANCE_SECONDS
    )
  }

  private canBeginRecovery(buddy: Buddy): boolean {
    let nearFloor = false
    for (const part of buddy.ragdoll.parts.values()) {
      if (
        part.body.translation().y <=
        RECOVERY_GROUND_HEIGHT * buddy.ragdoll.scale
      ) {
        nearFloor = true
        break
      }
    }
    if (!nearFloor) {
      return false
    }

    const root = buddy.rootSlot
      ? buddy.ragdoll.parts.get(buddy.rootSlot)
      : undefined
    if (!root) {
      return false
    }
    const velocity = root.body.linvel()
    const angularVelocity = root.body.angvel()
    return (
      Math.hypot(velocity.x, velocity.y, velocity.z) <=
        RECOVERY_MAX_LINEAR_SPEED &&
      Math.hypot(
        angularVelocity.x,
        angularVelocity.y,
        angularVelocity.z,
      ) <= RECOVERY_MAX_ANGULAR_SPEED
    )
  }

  private handleBuddyImpact(collider1: number, collider2: number, force: number): void {
    const first = this.buddies.find((buddy) =>
      buddy.ragdoll.bodyForCollider(collider1),
    )
    const second = this.buddies.find((buddy) =>
      buddy.ragdoll.bodyForCollider(collider2),
    )
    if (!first || !second || first === second) {
      return
    }

    const firstIsRagdoll = !first.anim?.isPlaying || first.limp
    const secondIsRagdoll = !second.anim?.isPlaying || second.limp

    // A free ragdoll is the projectile. Ordinary contact between two animated
    // performers should not make a crowded stage collapse on its own.
    if (force >= BUDDY_IMPACT_FORCE) {
      const struck =
        firstIsRagdoll && !secondIsRagdoll
          ? second
          : secondIsRagdoll && !firstIsRagdoll
            ? first
            : null
      if (struck && !struck.limp) {
        this.knockDown(struck)
        return
      }
    }

    // Two walkers bumping into each other stop, recoil slightly, and turn away.
    if (force < WALKER_IMPACT_FORCE) {
      return
    }
    const firstWalking =
      first.autoPhase === 'walk' || first.autoPhase === 'handshakeApproach'
    const secondWalking =
      second.autoPhase === 'walk' || second.autoPhase === 'handshakeApproach'
    if (!firstWalking && !secondWalking) {
      return
    }

    // Handshake partners deliberately approach one another; their incidental
    // arm/torso contact must not turn the greeting into a tackle.
    if (first.partnerId === second.id || second.partnerId === first.id) {
      return
    }

    // A locomoting root has authored intent beyond its instantaneous physics
    // velocity. Promote the contact to a reliable knockdown on the stationary
    // buddy instead of depending on one solver frame to transfer enough force.
    if (firstWalking && !secondWalking && !second.limp) {
      this.knockDown(second)
      return
    }
    if (secondWalking && !firstWalking && !first.limp) {
      this.knockDown(first)
      return
    }

    // Two walkers meeting head-on both retain agency, so they recoil and pick
    // separating headings instead of one arbitrarily winning.
    this.bumpWalker(first, second)
    this.bumpWalker(second, first)
  }

  /**
   * Topples buddies whose legs no longer sit under them.
   *
   * The pelvis is dynamic, so most losses of footing now topple naturally. This
   * remains as a low-frequency safety net for muscle tone that manages to hold
   * an implausible pose: once the centre of mass has hung outside the planted
   * feet longer than a stumble, the performance is abandoned and the body
   * drops.
   */
  private updateBalance(dt: number): void {
    for (const buddy of this.buddies) {
      const clip = buddy.anim?.activeClipName ?? null
      if (
        buddy.limp ||
        buddy.spawnDropping ||
        clip === null ||
        // A get-up starts from a sprawl, so it is unbalanced by definition.
        isRecoveryClip(clip)
      ) {
        buddy.balanceTimer = 0
        continue
      }

      // Walking is controlled falling: a stride legitimately carries the mass
      // ahead of the planted foot, so locomotion is judged far more loosely.
      const locomotion = clipMeta(clip)?.kind === 'locomotion'
      const limit =
        (locomotion ? BALANCE_MAX_OFFSET_MOVING : BALANCE_MAX_OFFSET) *
        buddy.ragdoll.scale

      if (buddy.ragdoll.balanceOffset() > limit) {
        buddy.balanceTimer += dt
        if (buddy.balanceTimer >= BALANCE_GRACE_SECONDS) {
          buddy.balanceTimer = 0
          this.knockDown(buddy)
        }
      } else {
        // Recovering credit faster than it accrues keeps brief overshoots in a
        // gesture from stacking up into a fall over several seconds.
        buddy.balanceTimer = Math.max(0, buddy.balanceTimer - dt * 2)
      }
    }
  }

  private knockDown(buddy: Buddy): void {
    if (buddy.partnerId !== null) {
      this.cancelHandshake(buddy)
    }
    buddy.destination = null
    this.setLimp(buddy, true)
    // Unlike the cursor-held source, the struck buddy has no pointer-up event
    // to start recovery. Give the impact time to play out, then let Auto stand.
    buddy.limpTimer = this.nextLimpRecoverDelay()
  }

  private bumpWalker(buddy: Buddy, other: Buddy): void {
    if (buddy.partnerId !== null) {
      this.cancelHandshake(buddy)
    }

    const a = this.buddyPlanarPosition(buddy)
    const b = this.buddyPlanarPosition(other)
    if (a && b) {
      _navDelta.set(a.x - b.x, 0, a.z - b.z)
      if (_navDelta.lengthSq() < 1e-6) {
        _navDelta.set(Math.sin(buddy.heading), 0, Math.cos(buddy.heading))
      }
      _navDelta.normalize()
      const nextX = THREE.MathUtils.clamp(
        a.x + _navDelta.x * 0.18,
        -(this.bounds.halfWidth - NAV_MARGIN),
        this.bounds.halfWidth - NAV_MARGIN,
      )
      const nextZ = THREE.MathUtils.clamp(
        a.z + _navDelta.z * 0.18,
        -(this.bounds.halfDepth - NAV_MARGIN),
        this.bounds.halfDepth - NAV_MARGIN,
      )
      buddy.anim?.setRootAnchorXZ(nextX, nextZ)
      buddy.heading = Math.atan2(_navDelta.x, _navDelta.z)
      buddy.anim?.setYaw(buddy.heading)
    }

    buddy.destination = null
    this.enterIdle(buddy)
    buddy.autoTimer = 1.2 + Math.random() * 1.5
    buddy.motionKey = ''
  }

  private setLimp(buddy: Buddy, limp: boolean): void {
    if (buddy.limp === limp) {
      return
    }
    buddy.limp = limp
    buddy.limpTimer = 0
    if (limp) {
      buddy.spawnDropping = false
      if (buddy.partnerId !== null) {
        this.cancelHandshake(buddy)
      }
      buddy.destination = null
      buddy.rootCompliant = false
      buddy.anim?.play(null)
      buddy.pose = buddy.bindPose
      buddy.rootTransition = null
      const root = buddy.rootSlot ? buddy.ragdoll.parts.get(buddy.rootSlot) : undefined
      root?.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
    }
    // Force `syncMotion` to reapply: it short-circuits on an unchanged key, and
    // the key is what carries the limp state.
    buddy.motionKey = ''
    this.notifyLimpChange()
  }

  private notifyLimpChange(): void {
    const limp = this.buddies.some((buddy) => buddy.limp)
    if (limp !== this.lastReportedLimp) {
      this.lastReportedLimp = limp
      this.onLimpChange?.(limp)
    }
  }

  /**
   * Resolves the Model control to a rig. Loading is async, so this keeps the
   * capsule rig running until the asset lands and then forces one rebuild.
   */
  private syncModel(params: VirtualBuddyParams): void {
    const entry = MODELS[Math.round(params.model)] ?? MODELS[0]

    if (!entry.url) {
      this.activeModel = null
      this.activeRig = primitiveRig
      return
    }

    const loaded = this.loadedModels.get(entry.url)
    if (loaded) {
      this.activeModel = loaded
      this.activeRig = loaded.rig
      return
    }

    this.activeModel = null
    this.activeRig = primitiveRig

    if (this.pendingModel === entry.url || this.modelError) {
      return
    }

    this.pendingModel = entry.url
    loadModel(entry.url)
      .then((model) => {
        if (this.disposed) {
          return
        }
        this.loadedModels.set(entry.url as string, model)
        // Force a rebuild: the rig proportions come from the model, so the
        // bodies built against the capsule rig are now wrong.
        this.buildKey = ''
      })
      .catch((error: unknown) => {
        this.modelError = error instanceof Error ? error.message : String(error)
        console.error('[virtual-buddy] model load failed', error)
      })
      .finally(() => {
        this.pendingModel = null
      })
  }

  private syncBuddies(params: VirtualBuddyParams): void {
    if (!this.physics) {
      return
    }

    this.syncModel(params)
    const selectedModel = MODELS[Math.round(params.model)] ?? MODELS[0]
    if (selectedModel.url && !this.activeModel) {
      // Do not flash the primitive fallback while the GLB is still loading.
      // The stage stays empty, then the real buddy enters once all rig and clip
      // data is ready.
      if (this.buddies.length > 0) {
        this.teardownBuddies()
      }
      this.buildKey = 'loading'
      return
    }

    // Collider dimensions and the rig itself are baked at build time, so scale
    // and model changes need a rebuild. Everything else is applied live.
    const key = `${selectedModel.id}|${this.activeRig.id}|${params.bodyScale.toFixed(3)}`
    if (key !== this.buildKey) {
      this.buildKey = key
      this.teardownBuddies()
      // The initial buddy is the stage host and begins already standing.
      // Buddies added with the button still use the falling entrance.
      this.addBuddy(new THREE.Vector3(0, 0, 0), params, false)
      return
    }

    // Empty stage: re-seed a host unless the user explicitly cleared the scene.
    if (this.buddies.length === 0) {
      if (this.allowEmptyStage) {
        return
      }
      this.addBuddy(new THREE.Vector3(0, 0, 0), params, false)
      return
    }

    // Cap lowered below the current population: drop the newest first, so the
    // buddy you have been playing with survives.
    const max = Math.max(1, Math.round(params.maxBuddies))
    let removedByCap = false
    while (this.buddies.length > max) {
      const buddy = this.buddies.pop()
      if (!buddy) {
        break
      }
      this.removeBuddy(buddy)
      removedByCap = true
    }
    if (removedByCap) {
      this.notifyBuddiesChange()
    }

    for (const buddy of this.buddies) {
      buddy.ragdoll.updateMaterial({
        friction: params.friction,
        restitution: params.bounce,
        linearDamping: params.airDrag,
        angularDamping: params.airDrag,
        density: BASE_DENSITY * params.weight,
      })
      buddy.view.group.visible = buddy.skin ? params.showPhysicsBodies > 0.5 : true
    }
  }

  private removeBuddy(buddy: Buddy): void {
    // The grab may be holding a body that is about to be freed.
    if (this.grab?.grabbedRagdoll === buddy.ragdoll) {
      this.grab.cancel()
    }
    this.disposeBuddy(buddy)
  }

  private disposeBuddy(buddy: Buddy): void {
    if (buddy.partnerId !== null) {
      this.cancelHandshake(buddy)
    }
    if (buddy.limp) {
      buddy.limp = false
      this.notifyLimpChange()
    }

    this.scene.remove(buddy.view.group)
    buddy.view.dispose()
    if (buddy.skin) {
      this.scene.remove(buddy.skin.group)
      buddy.skin.dispose()
    }
    buddy.anim?.dispose()
    buddy.ragdoll.dispose()
    // PrimitiveView already disposed the material instance.
  }

  private teardownBuddies(): void {
    this.grab?.cancel()
    for (const buddy of this.buddies) {
      this.disposeBuddy(buddy)
    }
    this.buddies = []
    this.notifyBuddiesChange()
  }
}

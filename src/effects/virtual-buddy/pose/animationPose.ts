import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { clipMeta, type LoadedModel } from '../models/registry'
import {
  segmentCenter,
  segmentQuaternion,
  type BoneSlot,
  type RigDefinition,
} from '../rigs/types'
import type { PoseSource } from './types'

const Y_AXIS = new THREE.Vector3(0, 1, 0)

function crossfadeDuration(previous: string, next: string): number {
  const previousMeta = clipMeta(previous)
  const nextMeta = clipMeta(next)
  if (
    (previous.startsWith('Turn') && next === 'Walk') ||
    (previous === 'Walk' && next.startsWith('Turn'))
  ) {
    return 0.55
  }
  if (previous.startsWith('Turn') || next.startsWith('Turn')) {
    return 0.4
  }
  // A get-up often finishes with the torso still pitched differently from the
  // Idle loop. Give that outgoing pose time to settle instead of immediately
  // pulling the chest and head toward Idle at full authority.
  if (previousMeta?.recovery && !nextMeta?.recovery) {
    return 1.1
  }
  if (nextMeta?.recovery) {
    return 0.65
  }
  if (previousMeta?.kind === 'social' || nextMeta?.kind === 'social') {
    return 0.55
  }
  if (previousMeta?.kind === 'gesture' || nextMeta?.kind === 'gesture') {
    return 0.7
  }
  if (
    previousMeta?.kind === 'locomotion' ||
    nextMeta?.kind === 'locomotion'
  ) {
    return 0.4
  }
  return 0.45
}

type Tracked = {
  bone: THREE.Bone
  /** Inverse of the bone's world rotation in the bind pose. */
  bindInverse: THREE.Quaternion
  /** Segment orientation at rest. */
  rest: THREE.Quaternion
  /** Segment head relative to its centre, in rig metres. */
  headOffset: THREE.Vector3
}

const _worldQuat = new THREE.Quaternion()
const _delta = new THREE.Quaternion()
const _rootBodyPosition = new THREE.Vector3()
const _rotatedHeadOffset = new THREE.Vector3()
const _relativeRoot = new THREE.Vector3()

/**
 * Muscle-tone targets taken from a running animation clip.
 *
 * A hidden reference skeleton — never added to the scene — is driven by an
 * `AnimationMixer`, and the rigid bodies chase it. Keeping the mixer off the
 * visible character is what avoids the two-writer problem: animation owns the
 * reference skeleton, physics owns the visible one, and neither fights the
 * other for the same bones.
 *
 * The reference carries the same normalisation as the visible model, so its
 * bone world transforms are already in rig space and can be compared with body
 * transforms directly.
 */
export class AnimationPoseSource implements PoseSource {
  /**
   * Every bone on the reference skeleton, by name.
   *
   * Physics owns 13 of them; the other ~50 — fingers, shoulders, neck, toes,
   * the intermediate spine — have no rigid body and would otherwise sit frozen
   * at bind pose forever. `SkinnedView` copies their local rotations straight
   * from here, so a clip's hand and shoulder detail survives.
   */
  readonly referenceBones = new Map<string, THREE.Bone>()
  private readonly root = new THREE.Group()
  private readonly mixer: THREE.AnimationMixer
  private readonly tracked = new Map<BoneSlot, Tracked>()
  private readonly targets = new Map<BoneSlot, THREE.Quaternion>()
  private readonly rootSlot: BoneSlot | null
  private current: THREE.AnimationAction | null = null
  /** Physics-space root position at the instant the current clip started. */
  private readonly rootAnchor = new THREE.Vector3()
  /** Reference-skeleton root position at the instant the current clip started. */
  private readonly clipRootStart = new THREE.Vector3()
  private hasRootAnchor = false
  private followFullRoot = false
  /** Scene-owned facing. Clips stay authored facing +Z; the scene turns them. */
  private yaw = 0
  private readonly yawQuat = new THREE.Quaternion()

  constructor(
    private readonly model: LoadedModel,
    rig: RigDefinition,
    scale: number,
    origin: THREE.Vector3,
  ) {
    const clone = cloneSkeleton(model.scene)
    this.root.add(clone)

    const normalised = model.normalisation * scale
    this.root.scale.setScalar(normalised)
    this.root.position.copy(model.offset).multiplyScalar(-normalised).add(origin)

    this.mixer = new THREE.AnimationMixer(clone)
    this.root.updateMatrixWorld(true)

    const bones = new Map<string, THREE.Bone>()
    clone.traverse((child) => {
      if ((child as THREE.Bone).isBone) {
        bones.set(child.name, child as THREE.Bone)
        this.referenceBones.set(child.name, child as THREE.Bone)
      }
    })

    let rootSlot: BoneSlot | null = null
    for (const segment of rig.segments) {
      const bone = segment.bone ? bones.get(segment.bone) : undefined
      if (!bone) {
        continue
      }

      this.tracked.set(segment.slot, {
        bone,
        bindInverse: bone.getWorldQuaternion(new THREE.Quaternion()).invert(),
        rest: segmentQuaternion(segment),
        headOffset: new THREE.Vector3(...segment.head)
          .sub(segmentCenter(segment))
          .multiplyScalar(scale),
      })
      this.targets.set(segment.slot, new THREE.Quaternion())

      if (segment.parent === null) {
        rootSlot = segment.slot
      }
    }
    this.rootSlot = rootSlot
  }

  get clipNames(): string[] {
    return this.model.clips.map((clip) => clip.name)
  }

  get isPlaying(): boolean {
    return this.current !== null
  }

  get activeClipName(): string | null {
    return this.current?.getClip().name ?? null
  }

  getYaw(): number {
    return this.yaw
  }

  /**
   * Scene-owned facing used for walking and social orientation.
   *
   * Applied to root rotation, limb targets and root-relative offsets so an
   * absolute pose chase still matches a turned character.
   */
  setYaw(yaw: number): void {
    this.yaw = yaw
    this.yawQuat.setFromAxisAngle(Y_AXIS, yaw)
  }

  getClipDuration(clipName: string): number | null {
    return this.model.clips.find((clip) => clip.name === clipName)?.duration ?? null
  }

  /**
   * Moves the active performance's stage anchor without restarting its clip.
   *
   * A light drag makes the hips temporarily dynamic. On release, retaining the
   * original anchor makes the kinematic root pull the whole buddy back to where
   * it was spawned. Re-anchoring preserves the current animation frame while
   * making the release position the buddy's new place on stage.
   */
  reanchorRoot(rootAnchor: THREE.Vector3): void {
    if (!this.current) {
      return
    }

    this.rootAnchor.copy(rootAnchor)
    this.hasRootAnchor = true
    if (this.followFullRoot) {
      // Preserve the remaining travel of a root-moving clip from this point,
      // rather than replaying all movement accumulated before the drag.
      this.sampleRootBodyPosition(this.clipRootStart)
    }
  }

  /** Horizontal stage placement for locomotion without restarting the clip. */
  setRootAnchorXZ(x: number, z: number): void {
    this.rootAnchor.x = x
    this.rootAnchor.z = z
    this.hasRootAnchor = true
  }

  getRootAnchor(target: THREE.Vector3): boolean {
    if (!this.hasRootAnchor) {
      return false
    }
    target.copy(this.rootAnchor)
    return true
  }

  /** Fraction through the active clip, for synchronising a pair. */
  getNormalizedTime(): number {
    if (!this.current) {
      return 0
    }
    const duration = this.current.getClip().duration
    return duration > 1e-6 ? this.current.time / duration : 0
  }

  setNormalizedTime(t: number): void {
    if (!this.current) {
      return
    }
    const duration = this.current.getClip().duration
    this.current.time = THREE.MathUtils.clamp(t, 0, 1) * duration
    this.mixer.update(0)
    this.refreshTargets()
  }

  /**
   * Pass null to stop, which drops the buddy back to a free ragdoll.
   *
   * `rootAnchor` keeps a newly selected clip where the physics body already is
   * instead of snapping back to the model's original spawn point.
   */
  play(clipName: string | null, rootAnchor?: THREE.Vector3): void {
    if (!clipName) {
      // A fade cannot finish once `current` is cleared because `update()` no
      // longer advances the mixer. Leaving that action enabled causes the next
      // clip to average with a frozen old pose (most visibly in the head/arms).
      this.mixer.stopAllAction()
      this.current = null
      this.hasRootAnchor = false
      this.followFullRoot = false
      return
    }

    if (this.current?.getClip().name === clipName) {
      return
    }

    const clip = this.model.clips.find((candidate) => candidate.name === clipName)
    if (!clip) {
      return
    }

    const previous = this.current
    if (!previous) {
      // Also clears any action left behind by an interrupted/HMR transition.
      this.mixer.stopAllAction()
    }

    const meta = clipMeta(clip.name)
    const next = this.mixer.clipAction(clip)
    this.followFullRoot = Boolean(meta?.followRoot)
    if (meta?.once) {
      // Recovery / handshake are one-shot performances, not looping.
      next.reset().setLoop(THREE.LoopOnce, 1)
      next.clampWhenFinished = true
      next.play()
    } else {
      next.reset().setLoop(THREE.LoopRepeat, Infinity).play()
    }

    if (previous) {
      const previousName = previous.getClip().name
      next.crossFadeFrom(
        previous,
        crossfadeDuration(previousName, clip.name),
        false,
      )
    }
    this.current = next

    // `reset()` places the action at its first frame. Sample that frame now so
    // exported hips translation can be made relative to the hand-off point, and
    // refresh limb targets before the first physics step.
    this.mixer.update(0)
    this.refreshTargets()
    if (rootAnchor && this.sampleRootBodyPosition(this.clipRootStart)) {
      this.rootAnchor.copy(rootAnchor)
      this.hasRootAnchor = true
    } else {
      this.hasRootAnchor = false
    }
  }

  update(dt: number): void {
    if (!this.current) {
      return
    }

    this.mixer.update(dt)
    this.refreshTargets()
  }

  getTargetQuaternion(slot: BoneSlot, target: THREE.Quaternion): boolean {
    const quaternion = this.targets.get(slot)
    if (!quaternion || !this.current) {
      return false
    }
    // Scene yaw turns the whole authored pose to face the walk / handshake.
    target.copy(this.yawQuat).multiply(quaternion)
    return true
  }

  /**
   * Where the root rigid body should be to match the clip.
   *
   * Muscle tone can hold a pose's shape but not its balance — a free-rooted
   * ragdoll told to dance just collapses while twitching. Driving the root
   * kinematically is what makes the motion actually read, and leaves every
   * other limb dynamic and grabbable.
   */
  getRootTransform(position: THREE.Vector3, rotation: THREE.Quaternion): boolean {
    const tracked = this.rootSlot ? this.tracked.get(this.rootSlot) : undefined
    if (!tracked || !this.current) {
      return false
    }

    tracked.bone.getWorldQuaternion(_worldQuat)
    _delta.copy(_worldQuat).multiply(tracked.bindInverse)

    rotation.copy(this.yawQuat).multiply(_delta)
    if (!this.sampleRootBodyPosition(_rootBodyPosition)) {
      return false
    }

    if (this.hasRootAnchor) {
      // Mixamo "in place" clips still contain hips sway. Keeping the kinematic
      // root anchored in X/Z lets the legs express that motion without towing
      // both feet across the floor; get-up clips opt out because travelling is
      // the point of them. Walk stays anchored too — scene navigation moves the
      // stage point instead of trusting Mixamo's authored stride distance.
      if (this.followFullRoot) {
        _rotatedHeadOffset.copy(_rootBodyPosition).sub(this.clipRootStart)
        _rotatedHeadOffset.applyQuaternion(this.yawQuat)
        position.copy(this.rootAnchor).add(_rotatedHeadOffset)
      } else {
        position.copy(this.rootAnchor)
      }
      // Height always comes from the clip, never the anchor. Anchoring Y as
      // well is what left a knocked-over buddy performing at floor level: the
      // pelvis has to rise to standing height for the body to recover at all.
      position.y = _rootBodyPosition.y
    } else {
      position.copy(_rootBodyPosition)
    }
    return true
  }

  private refreshTargets(): void {
    this.root.updateMatrixWorld(true)

    for (const [slot, tracked] of this.tracked) {
      const target = this.targets.get(slot)
      if (!target) {
        continue
      }
      // The rotation the clip has applied since bind, carried onto the
      // segment's rest orientation.
      tracked.bone.getWorldQuaternion(_worldQuat)
      target.copy(_worldQuat).multiply(tracked.bindInverse).multiply(tracked.rest)
    }
  }

  /**
   * Where a limb's body belongs relative to the hips, in rig metres.
   *
   * Lets callers judge limb *placement*, which orientation cannot express: a
   * foot left behind the body after a recovery can be flat on the floor and
   * still be in completely the wrong spot.
   */
  getRootRelativePosition(slot: BoneSlot, target: THREE.Vector3): boolean {
    const tracked = this.tracked.get(slot)
    const rootTracked = this.rootSlot ? this.tracked.get(this.rootSlot) : undefined
    if (!tracked || !rootTracked || !this.current) {
      return false
    }

    this.sampleBodyPosition(tracked, target)
    this.sampleBodyPosition(rootTracked, _relativeRoot)
    target.sub(_relativeRoot)
    // Match the yaw applied to orientations, or pose support would fight the
    // turned body by pulling limbs toward the unyawed clip offsets.
    target.applyQuaternion(this.yawQuat)
    return true
  }

  private sampleRootBodyPosition(target: THREE.Vector3): boolean {
    const tracked = this.rootSlot ? this.tracked.get(this.rootSlot) : undefined
    if (!tracked) {
      return false
    }

    this.sampleBodyPosition(tracked, target)
    return true
  }

  private sampleBodyPosition(tracked: Tracked, target: THREE.Vector3): void {
    tracked.bone.getWorldQuaternion(_worldQuat)
    _delta.copy(_worldQuat).multiply(tracked.bindInverse)
    tracked.bone.getWorldPosition(target)
    // Bones sit at the joint; bodies sit at the capsule centre.
    target.sub(_rotatedHeadOffset.copy(tracked.headOffset).applyQuaternion(_delta))
  }

  dispose(): void {
    this.mixer.stopAllAction()
    this.root.clear()
    this.tracked.clear()
    this.targets.clear()
  }
}

import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import type { PhysicsWorld } from './createWorld'
import type { Ragdoll, RagdollPart } from './ragdoll'
import type { BoneSlot } from '../rigs/types'

/**
 * Grab is a damped spring, not a velocity snap.
 *
 * Driving the held point straight to its target velocity each step is a
 * deadbeat controller: heavy parts absorb it, but on a forearm or the head the
 * impulse lands, the joint immediately undoes it, and the limb buzzes at step
 * rate. Spreading the correction over several steps costs a little
 * responsiveness and removes the shake entirely.
 */
const STIFFNESS = 500
/**
 * Deliberately under-damped (0.45 of critical).
 *
 * A damped spring's drag speed settles at roughly (K/C)·error, so the damping
 * ratio — not the stiffness — is what decides whether the buddy feels light or
 * waterlogged. At critical damping that ratio is ~2·√K/K, giving about 5·error
 * m/s: a cursor 20cm ahead can only tow him at 1.1 m/s, which reads as heavy.
 * At 0.45 it is ~25·error, four times quicker, and the overshoot is what lets
 * him actually swing around a held wrist.
 *
 * √500 ≈ 22 rad/s, so the spring still resolves over ~17 steps at 1/60 and
 * stays well clear of the stability edge.
 */
const DAMPING = 2 * Math.sqrt(STIFFNESS) * 0.45
/** Ceiling on commanded acceleration, m/s². Keeps a big yank from exploding. */
const MAX_ACCEL = 700
/** Window used to estimate release velocity, ms. */
const THROW_WINDOW_MS = 120
const MAX_RAY_DISTANCE = 100

type Grab = {
  ragdoll: Ragdoll
  part: RagdollPart
  /** Grab point in the grabbed body's local frame. */
  localPoint: THREE.Vector3
  /** Camera-space depth of the drag plane, fixed at grab time. */
  planeDistance: number
}

type Sample = { time: number; x: number; y: number; z: number }

const _bodyPos = new THREE.Vector3()
const _bodyRot = new THREE.Quaternion()
const _grabWorld = new THREE.Vector3()
const _offset = new THREE.Vector3()
const _pointVel = new THREE.Vector3()
const _delta = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _hitWorld = new THREE.Vector3()
const _throwVel = new THREE.Vector3()

/**
 * Click-drag-throw, the way *Interactive Buddy* did it.
 *
 * Picking goes through Rapier's raycast against the colliders rather than a
 * Three.js raycast against meshes — skinned-mesh raycasting is slow and
 * unreliable, and once a character replaces the capsules the colliders stay the
 * honest representation of where the body actually is.
 *
 * Dragging applies an impulse *at the grab point* rather than pinning the body
 * with a joint. Two reasons: grabbing a hand then rotates the whole body the way
 * it should, and it leaves a meaningful strength control — a rigid joint is
 * either attached or not.
 */
export class GrabController {
  private active: Grab | null = null
  private readonly target = new THREE.Vector3()
  private readonly raycaster = new THREE.Raycaster()
  private samples: Sample[] = []
  private strainDistance = 0

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly physics: PhysicsWorld,
  ) {}

  get isGrabbing(): boolean {
    return this.active !== null
  }

  /** Slot currently held, so muscle tone can stand down for it. */
  get grabbedSlot(): BoneSlot | null {
    return this.active?.part.segment.slot ?? null
  }

  /** Which buddy is held — the stand-down must not apply to all of them. */
  get grabbedRagdoll(): Ragdoll | null {
    return this.active?.ragdoll ?? null
  }

  /**
   * How far the cursor has pulled the held point away from where the body is
   * willing to follow, in metres.
   *
   * This is the spring's extension, so it reads as pull effort: a limb that
   * comes along freely barely separates, while one anchored by a posed body
   * resists and the gap opens up.
   */
  get strain(): number {
    return this.active ? this.strainDistance : 0
  }

  /** Returns true if something was grabbed; false means the click hit nothing. */
  tryGrab(ndcX: number, ndcY: number, ragdolls: Ragdoll[]): boolean {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const { origin, direction } = this.raycaster.ray

    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: direction.x, y: direction.y, z: direction.z },
    )
    // EXCLUDE_FIXED, or every click lands on the invisible front wall — the
    // cage sits between the camera and the stage, so it shadows the buddy.
    const hit = this.physics.world.castRay(
      ray,
      MAX_RAY_DISTANCE,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_FIXED,
    )
    if (!hit) {
      return false
    }

    let part: RagdollPart | undefined
    let owner: Ragdoll | undefined
    for (const ragdoll of ragdolls) {
      part = ragdoll.bodyForCollider(hit.collider.handle)
      if (part) {
        owner = ragdoll
        break
      }
    }
    // A wall was hit rather than a buddy.
    if (!part || !owner) {
      return false
    }

    _hitWorld.copy(origin).addScaledVector(direction, hit.timeOfImpact)

    const translation = part.body.translation()
    const rotation = part.body.rotation()
    _bodyPos.set(translation.x, translation.y, translation.z)
    _bodyRot.set(rotation.x, rotation.y, rotation.z, rotation.w)

    // Store the grab in body-local space so it tracks the limb as it tumbles.
    const localPoint = _hitWorld
      .clone()
      .sub(_bodyPos)
      .applyQuaternion(_bodyRot.clone().invert())

    this.camera.getWorldDirection(_forward)
    const planeDistance = _hitWorld.clone().sub(this.camera.position).dot(_forward)

    this.active = { ragdoll: owner, part, localPoint, planeDistance }
    this.target.copy(_hitWorld)
    this.samples = [{ time: performance.now(), x: _hitWorld.x, y: _hitWorld.y, z: _hitWorld.z }]
    return true
  }

  moveTo(ndcX: number, ndcY: number): void {
    if (!this.active) {
      return
    }

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const { origin, direction } = this.raycaster.ray
    this.camera.getWorldDirection(_forward)

    // Drag across a plane parallel to the screen, pinned at the grab's depth —
    // so the buddy stays roughly where you grabbed it in Z instead of sliding
    // toward or away from the camera.
    const denominator = direction.dot(_forward)
    const distance =
      Math.abs(denominator) > 1e-6 ? this.active.planeDistance / denominator : this.active.planeDistance

    this.target.copy(origin).addScaledVector(direction, distance)

    const now = performance.now()
    this.samples.push({ time: now, x: this.target.x, y: this.target.y, z: this.target.z })
    while (this.samples.length > 2 && now - this.samples[0].time > THROW_WINDOW_MS) {
      this.samples.shift()
    }
  }

  /** Must run once per physics step, alongside muscle tone. */
  applyGrab(strength: number, stepDt: number): void {
    const grab = this.active
    if (!grab) {
      return
    }

    const body = grab.part.body
    const translation = body.translation()
    const rotation = body.rotation()
    _bodyPos.set(translation.x, translation.y, translation.z)
    _bodyRot.set(rotation.x, rotation.y, rotation.z, rotation.w)

    _grabWorld.copy(grab.localPoint).applyQuaternion(_bodyRot).add(_bodyPos)
    _offset.copy(_grabWorld).sub(_bodyPos)
    this.strainDistance = this.target.distanceTo(_grabWorld)

    // Velocity of the material point being held: v + ω × r.
    const linvel = body.linvel()
    const angvel = body.angvel()
    _pointVel.set(angvel.x, angvel.y, angvel.z).cross(_offset)
    _pointVel.x += linvel.x
    _pointVel.y += linvel.y
    _pointVel.z += linvel.z

    // accel = k·error − c·velocity, the standard damped spring.
    _delta
      .copy(this.target)
      .sub(_grabWorld)
      .multiplyScalar(STIFFNESS)
      .addScaledVector(_pointVel, -DAMPING)

    if (_delta.lengthSq() > MAX_ACCEL * MAX_ACCEL) {
      _delta.setLength(MAX_ACCEL)
    }

    _delta.multiplyScalar(body.mass() * stepDt * Math.min(1, Math.max(0, strength)))

    body.applyImpulseAtPoint(
      { x: _delta.x, y: _delta.y, z: _delta.z },
      { x: _grabWorld.x, y: _grabWorld.y, z: _grabWorld.z },
      true,
    )
  }

  release(throwPower: number): void {
    const grab = this.active
    this.active = null
    this.strainDistance = 0
    if (!grab || this.samples.length < 2) {
      this.samples = []
      return
    }

    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const dt = (last.time - first.time) / 1000
    this.samples = []

    // A slow drag then a stop should drop the buddy, not fling it.
    if (dt <= 1e-3) {
      return
    }

    _throwVel
      .set(last.x - first.x, last.y - first.y, last.z - first.z)
      .divideScalar(dt)
      .multiplyScalar(throwPower)

    const body = grab.part.body
    const translation = body.translation()
    const rotation = body.rotation()
    _bodyPos.set(translation.x, translation.y, translation.z)
    _bodyRot.set(rotation.x, rotation.y, rotation.z, rotation.w)
    _grabWorld.copy(grab.localPoint).applyQuaternion(_bodyRot).add(_bodyPos)
    _offset.copy(_grabWorld).sub(_bodyPos)

    const linvel = body.linvel()
    const angvel = body.angvel()
    _pointVel.set(angvel.x, angvel.y, angvel.z).cross(_offset)
    _pointVel.x += linvel.x
    _pointVel.y += linvel.y
    _pointVel.z += linvel.z

    // Hand over what the cursor was actually doing, rather than whatever the
    // chase happened to have reached — the throw should feel like your gesture.
    _delta.copy(_throwVel).sub(_pointVel).multiplyScalar(body.mass())

    body.applyImpulseAtPoint(
      { x: _delta.x, y: _delta.y, z: _delta.z },
      { x: _grabWorld.x, y: _grabWorld.y, z: _grabWorld.z },
      true,
    )
  }

  /** Called when the grabbed ragdoll is torn down under us. */
  cancel(): void {
    this.active = null
    this.samples = []
    this.strainDistance = 0
  }
}

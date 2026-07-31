import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import type { PoseSource } from '../pose/types'
import type { PhysicsWorld } from './createWorld'
import {
  capsuleHalfHeight,
  segmentCenter,
  segmentQuaternion,
  segmentsInHierarchyOrder,
  segmentsOverlapAtRest,
  type BoneSlot,
  type RigDefinition,
  type RigSegment,
} from '../rigs/types'

export type RagdollOptions = {
  origin: THREE.Vector3
  density: number
  friction: number
  restitution: number
  linearDamping: number
  angularDamping: number
}

export type RagdollPart = {
  segment: RigSegment
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  /** Hand/toe coverage attached to this body beyond the mapped bone tail. */
  proxies: RAPIER.Collider[]
  /** Segment orientation at rest. Converts pose targets into body rotations. */
  restQuaternion: THREE.Quaternion
  restQuaternionInverse: THREE.Quaternion
  /** Segment head relative to its centre, scaled — bodies sit at the capsule
   *  centre, but the joint they hang from is at the head. */
  headOffset: THREE.Vector3
}

/** Angular speed aimed for, per radian of pose error. */
const CORRECTION_RATE = 12
/** Faster chase when a clip owns the pose — relative tone alone cannot stand a body up. */
const ANIMATION_CORRECTION_RATE = 22
/** Ceiling on the target speed, so a half-turn error cannot ask for a whip-crack. */
const MAX_ANGULAR_SPEED = 14
const ANIMATION_MAX_ANGULAR_SPEED = 22
/**
 * Corrections smaller than this (rad/s) are skipped entirely rather than applied
 * as a tiny impulse. Every `applyTorqueImpulse` wakes its body, so without a
 * deadzone a buddy lying against a pose it can never reach — supine, but still
 * targeting the standing pose — twitches forever and never sleeps.
 */
const MIN_CORRECTION = 0.05
/** Pose miss beyond which a *stationary* limb counts as stuck rather than lagging. */
const STALL_ANGLE = THREE.MathUtils.degToRad(12)
/** Angular speed below which a limb is judged to have stopped converging, rad/s. */
const STALL_SPEED = 0.7
/** Modest on purpose — enough to unstick a limb, not enough to make it ring. */
const STALL_BOOST = 1.8
/**
 * Compliant animated-root chase while the user is touching the body.
 *
 * Stiff enough to carry the character's weight — a soft root sags under the
 * whole body and reads as the torso going limp — but still a spring, so a real
 * pull moves the hips instead of hitting an immovable pin.
 */
const ROOT_POSITION_RATE = 16
const ROOT_ROTATION_RATE = 14
const ROOT_RESPONSE_RATE = 30
const ROOT_MAX_SPEED = 6
const ROOT_MAX_ANGULAR_SPEED = 10
/** Gentle positional follow shared by the whole body during stable clips. */
const POSE_SUPPORT_RATE = 9
const POSE_SUPPORT_RESPONSE_RATE = 12
const POSE_SUPPORT_MAX_SPEED = 2.5
/**
 * How much of a limb's angular correction is applied per step.
 *
 * Anything at 1 is a deadbeat controller: it commands the whole velocity change
 * in a single step, the joint immediately undoes most of it, and light limbs
 * ring. Arms are the worst case — a shoulder is spherical, so nothing resists
 * twist about the limb's own axis, and a twist error asks for a fast spin that
 * nothing damps. Spreading the correction turns that spin into a settle.
 */
const LIMB_RESPONSE = new Map<BoneSlot, number>([
  ['upperArmL', 0.5],
  ['upperArmR', 0.5],
  ['forearmL', 0.55],
  ['forearmR', 0.55],
  ['head', 0.7],
])
/** Arms are light and unconstrained in twist, so they get a far lower ceiling. */
const ARM_MAX_ANGULAR_SPEED = 9
const ARM_SLOTS = new Set<BoneSlot>([
  'upperArmL',
  'upperArmR',
  'forearmL',
  'forearmR',
])

const _qBody = new THREE.Quaternion()
const _qBodyInverse = new THREE.Quaternion()
const _qParentBody = new THREE.Quaternion()
const _qTargetSegment = new THREE.Quaternion()
const _qTargetParentSegment = new THREE.Quaternion()
const _qTargetBody = new THREE.Quaternion()
const _qTargetParentBody = new THREE.Quaternion()
const _qRelativeTarget = new THREE.Quaternion()
const _qError = new THREE.Quaternion()
const _qPrincipal = new THREE.Quaternion()
const _qPrincipalInverse = new THREE.Quaternion()
const _axis = new THREE.Vector3()
const _targetOmega = new THREE.Vector3()
const _deltaOmega = new THREE.Vector3()
const _center = new THREE.Vector3()
const _anchor = new THREE.Vector3()
const _jointWorld = new THREE.Vector3()
const _comWorld = new THREE.Vector3()
const _lever = new THREE.Vector3()
const _gravityTorque = new THREE.Vector3()
const _partCentre = new THREE.Vector3()
const _gravityRotation = new THREE.Quaternion()
const _rootError = new THREE.Vector3()
const _rootTargetVelocity = new THREE.Vector3()
const _footTarget = new THREE.Vector3()
const _balanceCom = new THREE.Vector3()
const _footA = new THREE.Vector3()
const _footB = new THREE.Vector3()
const _supportSpan = new THREE.Vector3()
const _supportClosest = new THREE.Vector3()
const _poseTarget = new THREE.Vector3()
const _poseVelocity = new THREE.Vector3()
const _poseDeltaVelocity = new THREE.Vector3()
const _downRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })

const FOOT_SLOTS: BoneSlot[] = ['footL', 'footR']
/** How close a sole must be to fixed geometry to count as carrying weight. */
const BALANCE_GROUND_REACH = 0.2
const DISTAL_SLOTS = new Set<BoneSlot>(['forearmL', 'forearmR', 'footL', 'footR'])
/** Stale-pose recovery exists for legs left behind after Get Up, not arms. */
const STALL_RECOVERY_SLOTS = new Set<BoneSlot>([
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
])
/**
 * Share of its own animated placement each limb helps hold.
 *
 * Without this every body hangs from its parent joints and the character reads
 * as suspended by the waist. Spreading it means the stance is carried by the
 * legs, the posture by the torso, and the arms merely keep station. The head
 * receives enough support not to droop during low-authority transitions.
 */
const POSE_SUPPORT_SLOTS = new Map<BoneSlot, number>([
  ['chest', 0.85],
  ['head', 0.55],
  ['upperArmL', 0.45],
  ['upperArmR', 0.45],
  ['forearmL', 0.35],
  ['forearmR', 0.35],
  ['thighL', 1.1],
  ['shinL', 1.2],
  ['footL', 1.4],
  ['thighR', 1.1],
  ['shinR', 1.2],
  ['footR', 1.4],
])
/** The chain a recovery drives forward on its own, before the torso joins in. */
const LEG_CHAIN_SLOTS = new Set<BoneSlot>([
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
])
const FOOT_GRIP_RATE = 22
/** Past this pose miss a foot is repositioning, so grip would fight the clip. */
const FOOT_GRIP_MAX_ERROR = THREE.MathUtils.degToRad(25)
/** Horizontal distance from its animated spot past which a foot must be free, metres. */
const FOOT_GRIP_MAX_OFFSET = 0.14
/**
 * Friction a displaced foot falls back to while it travels.
 *
 * Standing wants a high-grip sole, but that same grip welds a stranded foot to
 * the floor: suppressing our own damping is not enough, because Coulomb
 * friction is a solver constraint and outlasts anything we do to the velocity.
 */
const FOOT_SLIDE_FRICTION = 0.12
/** Extra body-weight share pressed through planted soles instead of the hips. */
const FOOT_LOAD_SHARE = 0.18
/** Shins and feet travel further than the torso, so they get a higher ceiling. */
const LEG_SUPPORT_MAX_SPEED = 4
const LEG_SUPPORT_SLOTS = new Set<BoneSlot>(['shinL', 'footL', 'shinR', 'footR'])

/**
 * An articulated body: one capsule rigid body per rig segment, joined by
 * hinges at the elbows and knees and ball joints everywhere else.
 *
 * Every body is created at **identity rotation**, with the limb's direction
 * living in its collider's local rotation instead. That one choice keeps joint
 * anchors and hinge axes expressible in plain world coordinates at build time,
 * which removes most of the frame-conversion arithmetic a ragdoll usually needs.
 * The cost is that a body's rotation is an offset from rest rather than the
 * limb's actual orientation — hence `restQuaternion` on each part.
 */
export class Ragdoll {
  readonly parts = new Map<BoneSlot, RagdollPart>()
  readonly joints: RAPIER.ImpulseJoint[] = []
  /**
   * How far the animated root must be lifted for the feet to rest on the floor.
   *
   * A clip's hip height is measured against the skeleton, whose floor plane is
   * the lowest bone. Colliders add radius below that, so driving the root to
   * the raw clip height buries the feet: the floor then pushes the dynamic feet
   * back up, the leg chain has to absorb the difference, and the knees buckle
   * and the feet skate out behind. Derived from rest geometry, so it follows a
   * swapped-in character's proportions.
   */
  readonly groundClearance: number

  private readonly world: RAPIER.World
  /** Contact exclusions registered with the world, withdrawn on dispose. */
  private readonly excluded: Array<[number, number]> = []
  /** Ceiling pairs suppressed while a drop-in falls through the top of the cage. */
  private readonly ceilingIgnored: Array<[number, number]> = []
  /** Each slot's subtree including itself — what its joint has to hold up. */
  private readonly descendants = new Map<BoneSlot, RagdollPart[]>()
  /** The parentless part, used as the frame for limb-placement checks. */
  private rootPart: RagdollPart | null = null
  /** Sole friction to restore once a travelling foot reaches its stance. */
  private footGripFriction: number
  /** Feet currently let loose, so friction is only written when it changes. */
  private readonly slidingFeet = new Set<BoneSlot>()
  /** Number of joints between any two slots, used for local grab blending. */
  private readonly jointDistances = new Map<BoneSlot, Map<BoneSlot, number>>()

  constructor(
    private readonly physics: PhysicsWorld,
    readonly rig: RigDefinition,
    readonly scale: number,
    options: RagdollOptions,
  ) {
    const world = physics.world
    this.world = world
    this.footGripFriction = Math.max(options.friction, 1.2)
    const ordered = segmentsInHierarchyOrder(rig)

    const neighbours = new Map<BoneSlot, BoneSlot[]>()
    for (const segment of ordered) {
      neighbours.set(segment.slot, [])
    }
    for (const segment of ordered) {
      if (segment.parent) {
        neighbours.get(segment.slot)?.push(segment.parent)
        neighbours.get(segment.parent)?.push(segment.slot)
      }
    }
    for (const start of neighbours.keys()) {
      const distances = new Map<BoneSlot, number>([[start, 0]])
      const queue: BoneSlot[] = [start]
      while (queue.length > 0) {
        const slot = queue.shift()!
        const distance = distances.get(slot)!
        for (const neighbour of neighbours.get(slot) ?? []) {
          if (!distances.has(neighbour)) {
            distances.set(neighbour, distance + 1)
            queue.push(neighbour)
          }
        }
      }
      this.jointDistances.set(start, distances)
    }

    // Lowest point any collider reaches in the rest pose, in rig metres. The
    // rig's floor plane is the lowest *bone*, which on a Mixamo skeleton is the
    // toe joint — colliders wrap radius around that, so the figure's true sole
    // sits below y = 0. See `groundClearance`.
    let lowestRest = Infinity
    // Where the visible sole sits. Foot colliders are lifted onto this line, so
    // the capsule's padding stops pushing the whole figure into the air.
    const soleLine = -(rig.soleDepth ?? 0)

    for (const segment of ordered) {
      segmentCenter(segment, _center).multiplyScalar(scale).add(options.origin)
      const isDistal = DISTAL_SLOTS.has(segment.slot)
      const isFoot = FOOT_SLOTS.includes(segment.slot)
      const capsuleBottom = Math.min(segment.head[1], segment.tail[1]) - segment.radius
      // Only the feet are corrected: they are what carries the figure's weight,
      // and shifting a collider inside its body leaves the body's own transform
      // — and so the bone the renderer reads — untouched.
      const footLift = isFoot ? Math.max(0, soleLine - capsuleBottom) : 0
      lowestRest = Math.min(lowestRest, capsuleBottom + footLift)

      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(_center.x, _center.y, _center.z)
          .setLinearDamping(options.linearDamping)
          .setAngularDamping(options.angularDamping)
          // Every link can tunnel the thin ceiling on a hard throw, especially
          // under low gravity where upward speed never bleeds off.
          .setCcdEnabled(true),
      )

      const rest = segmentQuaternion(segment)
      const collider = world.createCollider(
        RAPIER.ColliderDesc.capsule(
          capsuleHalfHeight(segment) * scale,
          segment.radius * scale,
        )
          .setRotation({ x: rest.x, y: rest.y, z: rest.z, w: rest.w })
          .setTranslation(0, footLift * scale, 0)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setFriction(options.friction)
          .setRestitution(options.restitution)
          .setDensity(options.density)
          // Required for the world's contact filter to be consulted at all.
          .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS),
        body,
      )

      const proxies: RAPIER.Collider[] = []
      if (isDistal) {
        const centre = segmentCenter(segment, new THREE.Vector3())
        const direction = new THREE.Vector3(...segment.tail)
          .sub(new THREE.Vector3(...segment.head))
          .normalize()
        const proxyRadius = segment.radius * 1.2
        const proxyCentreRig = new THREE.Vector3(...segment.tail).addScaledVector(
          direction,
          proxyRadius * 0.9,
        )
        // The toe ball is wider than the capsule, so it needs its own lift or
        // it alone would keep the character standing on air.
        const proxyLift = isFoot
          ? Math.max(0, soleLine - (proxyCentreRig.y - proxyRadius))
          : 0
        proxyCentreRig.y += proxyLift
        lowestRest = Math.min(lowestRest, proxyCentreRig.y - proxyRadius)
        const proxyCentre = proxyCentreRig.clone().sub(centre).multiplyScalar(scale)

        proxies.push(
          world.createCollider(
            RAPIER.ColliderDesc.ball(proxyRadius * scale)
              .setTranslation(proxyCentre.x, proxyCentre.y, proxyCentre.z)
              .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
              .setFriction(
                segment.slot === 'footL' || segment.slot === 'footR'
                  ? Math.max(options.friction, 1.2)
                  : options.friction,
              )
              .setRestitution(options.restitution)
              .setDensity(options.density)
              .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS),
            body,
          ),
        )

        // The capsule runs ankle -> toe, and the ankle sits well above the toe,
        // so the only thing under the foot is its toe end. That leaves the heel
        // standing on nothing, which reads as the back of the foot hovering
        // whenever the body is resting on physics rather than held by a clip.
        if (isFoot) {
          const heelRadius = segment.radius * 0.85
          const heelCentreRig = new THREE.Vector3(...segment.head).addScaledVector(
            direction,
            -heelRadius * 0.5,
          )
          heelCentreRig.y = soleLine + heelRadius
          lowestRest = Math.min(lowestRest, heelCentreRig.y - heelRadius)
          const heelCentre = heelCentreRig.sub(centre).multiplyScalar(scale)

          proxies.push(
            world.createCollider(
              RAPIER.ColliderDesc.ball(heelRadius * scale)
                .setTranslation(heelCentre.x, heelCentre.y, heelCentre.z)
                .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
                .setFriction(Math.max(options.friction, 1.2))
                .setRestitution(options.restitution)
                .setDensity(options.density)
                .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS),
              body,
            ),
          )
        }
      }

      this.parts.set(segment.slot, {
        segment,
        body,
        collider,
        proxies,
        restQuaternion: rest,
        restQuaternionInverse: rest.clone().invert(),
        headOffset: new THREE.Vector3(...segment.head)
          .sub(segmentCenter(segment))
          .multiplyScalar(scale),
      })
    }

    for (const segment of ordered) {
      if (!segment.parent) {
        continue
      }

      const child = this.parts.get(segment.slot)
      const parent = this.parts.get(segment.parent)
      if (!child || !parent) {
        throw new Error(`Rig "${rig.id}": segment "${segment.slot}" has no parent body`)
      }

      _anchor.fromArray(segment.head).multiplyScalar(scale).add(options.origin)
      const parentAt = parent.body.translation()
      const childAt = child.body.translation()

      // Identity body rotation means a world delta is already a local anchor.
      const anchor1 = {
        x: _anchor.x - parentAt.x,
        y: _anchor.y - parentAt.y,
        z: _anchor.z - parentAt.z,
      }
      const anchor2 = {
        x: _anchor.x - childAt.x,
        y: _anchor.y - childAt.y,
        z: _anchor.z - childAt.z,
      }

      const isHinge = segment.joint === 'revolute' && segment.axis
      const params = isHinge
        ? RAPIER.JointData.revolute(anchor1, anchor2, {
            x: segment.axis![0],
            y: segment.axis![1],
            z: segment.axis![2],
          })
        : RAPIER.JointData.spherical(anchor1, anchor2)

      const joint = world.createImpulseJoint(params, parent.body, child.body, true)

      // Jointed capsules overlap by construction. Leave contacts enabled here
      // and the ragdoll tears itself apart on the first step.
      joint.setContactsEnabled(false)

      // Symmetric hinge travel only — see `limitRange` for why an asymmetric
      // anatomical range cannot be placed reliably. Without any limit the ankle
      // spins freely and the foot swings up through the shin, which per-joint
      // contact suppression cannot catch.
      if (isHinge && segment.limitRange !== undefined) {
        ;(joint as RAPIER.RevoluteImpulseJoint).setLimits(
          -segment.limitRange,
          segment.limitRange,
        )
      }

      this.joints.push(joint)
    }

    // Suppress contacts only where capsules genuinely cannot separate: directly
    // jointed pairs, plus any pair already overlapping in the rest pose — the
    // chest and the thighs share space around the hip line, and those two are
    // *not* jointed to each other, so per-joint filtering misses them.
    //
    // Everything else keeps colliding, so a forearm still cannot swing through
    // the torso. Rest geometry is checked unscaled: uniform body scale cannot
    // change whether two capsules overlap.
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const a = ordered[i]
        const b = ordered[j]
        const jointed = a.parent === b.slot || b.parent === a.slot

        if (!jointed && !segmentsOverlapAtRest(a, b)) {
          continue
        }

        const partA = this.parts.get(a.slot)
        const partB = this.parts.get(b.slot)
        if (!partA || !partB) {
          continue
        }

        // Proxies belong to the same inseparable pair as the capsule they hang
        // off. Excluding only the capsules leaves a heel ball grinding against
        // the shin it is jointed to, which the solver can never resolve.
        for (const colliderA of [partA.collider, ...partA.proxies]) {
          for (const colliderB of [partB.collider, ...partB.proxies]) {
            physics.excludeContactPair(colliderA.handle, colliderB.handle)
            this.excluded.push([colliderA.handle, colliderB.handle])
          }
        }
      }
    }

    // Subtrees, for gravity compensation: holding an upper arm in place means
    // supporting the forearm hanging off it too.
    for (const segment of ordered) {
      const chain: RagdollPart[] = []
      const collect = (slot: BoneSlot): void => {
        const part = this.parts.get(slot)
        if (part) {
          chain.push(part)
        }
        for (const candidate of ordered) {
          if (candidate.parent === slot) {
            collect(candidate.slot)
          }
        }
      }
      collect(segment.slot)
      this.descendants.set(segment.slot, chain)
    }

    this.rootPart =
      [...this.parts.values()].find((part) => !part.segment.parent) ?? null

    this.groundClearance = Number.isFinite(lowestRest)
      ? Math.max(0, -lowestRest) * scale
      : 0
  }

  /**
   * Drives every limb toward the pose source.
   *
   * Stands in for Rapier's joint motors, whose API differs across versions and
   * is awkward on spherical joints. Doing it by hand also means a single slider
   * spans limp to rigid, which is the control the brief wants.
   *
   * Formulated as an angular-velocity target rather than a torque spring, for
   * two reasons. It is inherently damped — subtracting current ω is the damping
   * term — and the impulse can be weighted by real angular inertia, so a
   * forearm and a torso respond identically to the same slider.
   *
   * Weighting by *mass* instead is off by roughly 1/r², which for limbs this
   * size is a factor of ~100 and tears the ragdoll apart on the first step.
   *
   * Assumes the caller's fixed 1/60 step, so `tone` reads directly as the
   * fraction of remaining error corrected per step.
   */
  applyMuscleTone(options: {
    pose: PoseSource
    tone: number
    /** Slot the user is dragging, if any. */
    heldSlot?: BoneSlot | null
    /** Positive magnitude, for gravity compensation. */
    gravity: number
    stepDt: number
    /**
     * `relative` keeps joint angles while letting the whole body stay slumped
     * (ragdoll). `absolute` drives each limb to the clip's world orientation so
     * a kinematic pelvis can actually pull the character back into the motion.
     */
    space?: 'relative' | 'absolute'
  }): void {
    const { pose, tone, gravity, stepDt } = options
    const heldSlot = options.heldSlot ?? null
    const space = options.space ?? 'relative'
    if (tone <= 0) {
      return
    }

    const gain = Math.min(1, tone)
    const rate = space === 'absolute' ? ANIMATION_CORRECTION_RATE : CORRECTION_RATE
    const maxSpeed =
      space === 'absolute' ? ANIMATION_MAX_ANGULAR_SPEED : MAX_ANGULAR_SPEED

    for (const part of this.parts.values()) {
      // A touched limb yields completely, its neighbours soften, and the rest
      // keeps performing. This creates a local physics/animation merge instead
      // of dropping the entire character because one ankle was touched.
      const localGain = gain * this.grabPoseInfluence(part.segment.slot, heldSlot)
      if (localGain <= 0) {
        continue
      }

      // The root has no parent to be posed against. Giving it an absolute
      // target would mean the whole body permanently tries to stand up,
      // which is not muscle tone — that is balance, and it belongs to the
      // idle state machine / kinematic root drive.
      if (!part.segment.parent) {
        continue
      }
      const parent = this.parts.get(part.segment.parent)
      if (!parent) {
        continue
      }

      if (!pose.getTargetQuaternion(part.segment.slot, _qTargetSegment)) {
        continue
      }
      if (
        space === 'relative' &&
        !pose.getTargetQuaternion(parent.segment.slot, _qTargetParentSegment)
      ) {
        continue
      }

      const rotation = part.body.rotation()
      _qBody.set(rotation.x, rotation.y, rotation.z, rotation.w)
      const parentRotation = parent.body.rotation()
      _qParentBody.set(
        parentRotation.x,
        parentRotation.y,
        parentRotation.z,
        parentRotation.w,
      )

      this.compensateGravity(part, parent, localGain, gravity, stepDt)

      if (space === 'absolute') {
        // Clip owns world orientation. Relative joint angles alone leave a
        // kinematic waist holding a limp ragdoll — exactly the wrong look.
        _qTargetBody.copy(_qTargetSegment).multiply(part.restQuaternionInverse)
      } else {
        // Target expressed *relative to the parent limb*, then rebuilt against
        // the parent's current orientation. That is what makes a limp buddy on
        // its back settle: its joint angles are already correct, only its overall
        // orientation differs, and overall orientation is not tone's business.
        _qTargetBody.copy(_qTargetSegment).multiply(part.restQuaternionInverse)
        _qTargetParentBody
          .copy(_qTargetParentSegment)
          .multiply(parent.restQuaternionInverse)
          .invert()
        _qRelativeTarget.copy(_qTargetParentBody).multiply(_qTargetBody)

        _qTargetBody.copy(_qParentBody).multiply(_qRelativeTarget)
      }

      // Rotation carrying current onto target.
      _qBodyInverse.copy(_qBody).invert()
      _qError.copy(_qTargetBody).multiply(_qBodyInverse)
      if (_qError.w < 0) {
        // Take the shorter arc, or limbs unwind the long way round.
        _qError.set(-_qError.x, -_qError.y, -_qError.z, -_qError.w)
      }

      const w = Math.min(1, Math.max(-1, _qError.w))
      const angle = 2 * Math.acos(w)

      const omega = part.body.angvel()

      // A limb that is well off its target *and barely moving* has stalled —
      // held short by gravity, a contact, or a joint limit — and is the case
      // that leaves a leg bent after a clip ends. Extra authority is spent only
      // there. Boosting on error alone would fire constantly during normal
      // motion, since a chase controller always trails its target by a little,
      // and over-driving every joint like that makes the arms oscillate.
      const stalled =
        space === 'absolute' &&
        STALL_RECOVERY_SLOTS.has(part.segment.slot) &&
        angle > STALL_ANGLE &&
        omega.x * omega.x + omega.y * omega.y + omega.z * omega.z <
          STALL_SPEED * STALL_SPEED
      const effectiveRate = stalled ? rate * STALL_BOOST : rate

      _targetOmega.set(0, 0, 0)
      if (angle > 1e-4) {
        const sin = Math.sqrt(Math.max(1e-8, 1 - w * w))
        _axis.set(_qError.x / sin, _qError.y / sin, _qError.z / sin)
        // The speed cap deliberately does not scale with the boost: a stalled
        // limb needs persistence, not a whip-crack.
        const limbMaxSpeed = ARM_SLOTS.has(part.segment.slot)
          ? Math.min(maxSpeed, ARM_MAX_ANGULAR_SPEED)
          : maxSpeed
        _targetOmega
          .copy(_axis)
          .multiplyScalar(Math.min(angle * effectiveRate, limbMaxSpeed))
      }

      const response = LIMB_RESPONSE.get(part.segment.slot) ?? 1
      _deltaOmega
        .set(_targetOmega.x - omega.x, _targetOmega.y - omega.y, _targetOmega.z - omega.z)
        .multiplyScalar(localGain * response)

      if (_deltaOmega.lengthSq() < MIN_CORRECTION * MIN_CORRECTION) {
        continue
      }

      // impulse = I · Δω, with I diagonal only in its own principal frame — so
      // rotate in, scale per axis, rotate back out.
      const inertia = part.body.principalInertia()
      const frame = part.body.principalInertiaLocalFrame()
      _qPrincipal.set(frame.x, frame.y, frame.z, frame.w).premultiply(_qBody)
      _qPrincipalInverse.copy(_qPrincipal).invert()

      _deltaOmega.applyQuaternion(_qPrincipalInverse)
      _deltaOmega.set(
        _deltaOmega.x * inertia.x,
        _deltaOmega.y * inertia.y,
        _deltaOmega.z * inertia.z,
      )
      _deltaOmega.applyQuaternion(_qPrincipal)

      part.body.applyTorqueImpulse(
        { x: _deltaOmega.x, y: _deltaOmega.y, z: _deltaOmega.z },
        true,
      )
      // Newton's third law. A muscle pulls on both bones it spans, and without
      // the reaction the chain gains angular momentum from nowhere — the
      // ragdoll visibly winds itself up instead of settling. Safe against a
      // kinematic root: Rapier simply ignores the impulse there.
      parent.body.applyTorqueImpulse(
        { x: -_deltaOmega.x, y: -_deltaOmega.y, z: -_deltaOmega.z },
        true,
      )
    }
  }

  /**
   * Shares positional support across the torso and legs during stable clips.
   *
   * Angular muscle tone alone leaves every body hanging from the kinematic
   * pelvis. This low-gain velocity servo lets the chest and leg chain help hold
   * their animated placement, so balance reads through the whole stance rather
   * than as though the character were suspended by its waist.
   */
  applyPoseSupport(
    pose: PoseSource,
    tone: number,
    heldSlot: BoneSlot | null,
    stepDt: number,
    /**
     * Scales support for everything above the hips. A recovery ramps this up as
     * the body rises, so the torso is eased onto the clip during the clip
     * rather than corrected all at once when the next one starts.
     */
    torsoShare = 1,
  ): void {
    if (
      tone <= 0 ||
      !this.rootPart ||
      !pose.getRootRelativePosition
    ) {
      return
    }

    const rootAt = this.rootPart.body.translation()
    const response =
      (1 - Math.exp(-POSE_SUPPORT_RESPONSE_RATE * stepDt)) *
      THREE.MathUtils.clamp(tone, 0, 1)

    for (const [slot, share] of POSE_SUPPORT_SLOTS) {
      const slotShare = LEG_CHAIN_SLOTS.has(slot) ? share : share * torsoShare
      if (slotShare <= 0) {
        continue
      }
      const part = this.parts.get(slot)
      if (
        !part ||
        !pose.getRootRelativePosition(slot, _poseTarget)
      ) {
        continue
      }

      const localGain = this.grabPoseInfluence(slot, heldSlot) * slotShare
      if (localGain <= 0) {
        continue
      }

      const at = part.body.translation()
      const velocity = part.body.linvel()
      _poseTarget.add(_partCentre.set(rootAt.x, rootAt.y, rootAt.z))
      _poseVelocity
        .set(_poseTarget.x - at.x, _poseTarget.y - at.y, _poseTarget.z - at.z)
        .multiplyScalar(POSE_SUPPORT_RATE)
      // The lower leg swings through a far bigger arc than the torso does, so
      // the torso's ceiling would leave it permanently trailing the clip.
      const maxSpeed = LEG_SUPPORT_SLOTS.has(slot)
        ? LEG_SUPPORT_MAX_SPEED
        : POSE_SUPPORT_MAX_SPEED
      if (_poseVelocity.lengthSq() > maxSpeed * maxSpeed) {
        _poseVelocity.setLength(maxSpeed)
      }

      _poseDeltaVelocity
        .copy(_poseVelocity)
        .sub(_partCentre.set(velocity.x, velocity.y, velocity.z))
        .multiplyScalar(part.body.mass() * response * localGain)
      part.body.applyImpulse(
        {
          x: _poseDeltaVelocity.x,
          y: _poseDeltaVelocity.y,
          z: _poseDeltaVelocity.z,
        },
        true,
      )
    }
  }

  /**
   * How much pose authority a slot keeps while `heldSlot` is being dragged.
   *
   * Softening falls off sharply with joint distance. Grabbing a hand should
   * free the wrist and take the edge off the elbow, not drain the torso — that
   * reads as the whole character giving up because one finger was touched.
   */
  grabPoseInfluence(slot: BoneSlot, heldSlot: BoneSlot | null): number {
    if (!heldSlot) {
      return 1
    }

    const distance = this.jointDistances.get(heldSlot)?.get(slot) ?? Infinity
    if (distance === 0) {
      return 0
    }
    if (distance === 1) {
      return 0.45
    }
    if (distance === 2) {
      return 0.85
    }
    return 1
  }

  /**
   * Compliantly follows the animated hips while keeping them fully dynamic.
   *
   * This velocity spring gives the body a readable preference for the authored
   * animation without creating an infinite-mass pin at the waist. It can yield
   * under pulls, receive impacts, and fall naturally when footing is lost. It
   * is disabled entirely after a break-away.
   */
  driveRootToward(
    slot: BoneSlot,
    targetPosition: THREE.Vector3,
    targetRotation: THREE.Quaternion,
    strength: number,
    gravity: number,
    stepDt: number,
  ): void {
    const root = this.parts.get(slot)
    if (!root) {
      return
    }

    const body = root.body
    const position = body.translation()
    const velocity = body.linvel()
    const response =
      (1 - Math.exp(-ROOT_RESPONSE_RATE * stepDt)) *
      THREE.MathUtils.clamp(strength, 0, 1)

    // Feed-forward the weight the pelvis carries. Without it the spring settles
    // wherever its restoring force happens to balance gravity, and that
    // steady-state droop is what makes the torso look like it has given up.
    if (gravity !== 0) {
      let carried = 0
      for (const part of this.parts.values()) {
        carried += part.body.mass()
      }
      body.applyImpulse({ x: 0, y: carried * gravity * stepDt * response, z: 0 }, true)
    }

    _rootError.set(
      targetPosition.x - position.x,
      targetPosition.y - position.y,
      targetPosition.z - position.z,
    )
    _rootTargetVelocity.copy(_rootError).multiplyScalar(ROOT_POSITION_RATE)
    if (_rootTargetVelocity.lengthSq() > ROOT_MAX_SPEED * ROOT_MAX_SPEED) {
      _rootTargetVelocity.setLength(ROOT_MAX_SPEED)
    }
    _rootTargetVelocity
      .sub(_partCentre.set(velocity.x, velocity.y, velocity.z))
      .multiplyScalar(body.mass() * response)
    body.applyImpulse(
      {
        x: _rootTargetVelocity.x,
        y: _rootTargetVelocity.y,
        z: _rootTargetVelocity.z,
      },
      true,
    )

    const rotation = body.rotation()
    _qBody.set(rotation.x, rotation.y, rotation.z, rotation.w)
    _qBodyInverse.copy(_qBody).invert()
    _qError.copy(targetRotation).multiply(_qBodyInverse)
    if (_qError.w < 0) {
      _qError.set(-_qError.x, -_qError.y, -_qError.z, -_qError.w)
    }

    const w = Math.min(1, Math.max(-1, _qError.w))
    const angle = 2 * Math.acos(w)
    _targetOmega.set(0, 0, 0)
    if (angle > 1e-4) {
      const sin = Math.sqrt(Math.max(1e-8, 1 - w * w))
      _axis.set(_qError.x / sin, _qError.y / sin, _qError.z / sin)
      _targetOmega
        .copy(_axis)
        .multiplyScalar(
          Math.min(angle * ROOT_ROTATION_RATE, ROOT_MAX_ANGULAR_SPEED),
        )
    }

    const angularVelocity = body.angvel()
    _deltaOmega
      .set(
        _targetOmega.x - angularVelocity.x,
        _targetOmega.y - angularVelocity.y,
        _targetOmega.z - angularVelocity.z,
      )
      .multiplyScalar(response)

    const inertia = body.principalInertia()
    const frame = body.principalInertiaLocalFrame()
    _qPrincipal.set(frame.x, frame.y, frame.z, frame.w).premultiply(_qBody)
    _qPrincipalInverse.copy(_qPrincipal).invert()
    _deltaOmega.applyQuaternion(_qPrincipalInverse)
    _deltaOmega.set(
      _deltaOmega.x * inertia.x,
      _deltaOmega.y * inertia.y,
      _deltaOmega.z * inertia.z,
    )
    _deltaOmega.applyQuaternion(_qPrincipal)
    body.applyTorqueImpulse(
      { x: _deltaOmega.x, y: _deltaOmega.y, z: _deltaOmega.z },
      true,
    )
  }

  /**
   * Cancels the gravitational moment each joint has to hold.
   *
   * The pose controller commands angular velocity proportional to pose error,
   * which under a constant load settles at a steady-state droop — error stops
   * shrinking once the per-step correction balances gravity's impulse. That
   * droop scales with the gravitational moment, so a limb held out sideways
   * sags badly while one hanging parallel to gravity looks fine. Arms wrong,
   * legs right, which is exactly the symptom this fixes.
   *
   * Extra stiffness only trades droop for jitter. Removing the load is the fix.
   */
  private compensateGravity(
    part: RagdollPart,
    parent: RagdollPart,
    gain: number,
    gravity: number,
    stepDt: number,
  ): void {
    const chain = this.descendants.get(part.segment.slot)
    if (gravity === 0 || !chain || chain.length === 0) {
      return
    }

    let mass = 0
    _comWorld.set(0, 0, 0)
    for (const member of chain) {
      const memberMass = member.body.mass()
      const centre = member.body.translation()
      _partCentre.set(centre.x, centre.y, centre.z)
      _comWorld.addScaledVector(_partCentre, memberMass)
      mass += memberMass
    }
    if (mass <= 0) {
      return
    }
    _comWorld.divideScalar(mass)

    // The joint sits at the segment head, not the body's centre.
    const rotation = part.body.rotation()
    const translation = part.body.translation()
    _gravityRotation.set(rotation.x, rotation.y, rotation.z, rotation.w)
    _jointWorld
      .copy(part.headOffset)
      .applyQuaternion(_gravityRotation)
      .add(_partCentre.set(translation.x, translation.y, translation.z))

    _lever.copy(_comWorld).sub(_jointWorld)
    // τ = r × F with F = (0, −m·g, 0). Negated, so it cancels rather than adds.
    _gravityTorque.set(0, -mass * gravity, 0)
    _gravityTorque.crossVectors(_lever, _gravityTorque).multiplyScalar(-gain * stepDt)

    part.body.applyTorqueImpulse(
      { x: _gravityTorque.x, y: _gravityTorque.y, z: _gravityTorque.z },
      true,
    )
    // Gravity compensation is still a muscle torque: the parent receives the
    // equal reaction. Omitting it adds angular momentum on every physics step.
    parent.body.applyTorqueImpulse(
      { x: -_gravityTorque.x, y: -_gravityTorque.y, z: -_gravityTorque.z },
      true,
    )
  }

  /**
   * Adds static-friction-like grip while an animated foot is touching the floor.
   *
   * The hips are kinematic during a clip, so ordinary Coulomb friction alone
   * cannot always resist the whole articulated chain pulling sideways. This
   * removes only horizontal slip, only near fixed geometry, and leaves airborne
   * feet completely free.
   */
  stabilizeFeet(
    stepDt: number,
    strength = 1,
    pose?: PoseSource,
    gravity = 0,
    loadStrength = 1,
  ): void {
    const retain = Math.exp(-FOOT_GRIP_RATE * Math.max(0, strength) * stepDt)
    let carriedMass = 0
    if (gravity > 0 && loadStrength > 0) {
      for (const part of this.parts.values()) {
        carriedMass += part.body.mass()
      }
    }

    for (const slot of FOOT_SLOTS) {
      const foot = this.parts.get(slot)
      if (!foot) {
        continue
      }

      // A foot that is far from where the clip wants it has to be free to get
      // there. Gripping regardless is what pins the legs in whatever stance the
      // previous clip ended in — most visible right after a get-up.
      let displaced = false
      if (pose && pose.getTargetQuaternion(slot, _qTargetSegment)) {
        _qTargetBody.copy(_qTargetSegment).multiply(foot.restQuaternionInverse)
        const rotation = foot.body.rotation()
        _qBody.set(rotation.x, rotation.y, rotation.z, rotation.w)
        _qBodyInverse.copy(_qBody).invert()
        _qError.copy(_qTargetBody).multiply(_qBodyInverse)
        const angle = 2 * Math.acos(Math.min(1, Math.abs(_qError.w)))
        displaced = angle > FOOT_GRIP_MAX_ERROR
      }

      // Orientation says nothing about placement: a foot stranded behind the
      // hips after a recovery can be perfectly flat, and gripping it there is
      // what leaves the character standing with its legs trailing behind. Only
      // hold a foot that is already roughly under where the clip wants it.
      if (
        !displaced &&
        this.rootPart &&
        pose?.getRootRelativePosition &&
        pose.getRootRelativePosition(slot, _footTarget)
      ) {
        const rootAt = this.rootPart.body.translation()
        const footAt = foot.body.translation()
        const offsetX = rootAt.x + _footTarget.x - footAt.x
        const offsetZ = rootAt.z + _footTarget.z - footAt.z
        const limit = FOOT_GRIP_MAX_OFFSET * this.scale
        displaced = offsetX * offsetX + offsetZ * offsetZ > limit * limit
      }

      // Suppressing our own damping is not enough on its own: the sole also
      // carries a deliberately high Coulomb friction, and that is a solver
      // constraint we cannot out-push. A travelling foot has to lose its grip
      // on the floor as well, or it stays welded where the last clip left it
      // while the hips walk away from it.
      this.setFootSliding(slot, foot, displaced)
      if (displaced) {
        continue
      }

      const at = foot.body.translation()
      _downRay.origin = { x: at.x, y: at.y, z: at.z }
      const hit = this.world.castRay(
        _downRay,
        0.18 * this.scale,
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
      )
      const velocity = foot.body.linvel()
      if (!hit || Math.abs(velocity.y) > 0.45) {
        continue
      }

      foot.body.setLinvel(
        {
          x: velocity.x * retain,
          y: velocity.y,
          z: velocity.z * retain,
        },
        true,
      )

      // The kinematic pelvis otherwise supplies almost all visible support.
      // Pressing a modest share of the complete body's weight through each
      // planted sole gives the floor a reaction force to carry through the leg
      // chain, so the character reads as standing rather than hanging at the
      // waist. Airborne/displaced feet never receive this load.
      if (carriedMass > 0) {
        const load =
          carriedMass *
          gravity *
          FOOT_LOAD_SHARE *
          0.5 *
          THREE.MathUtils.clamp(loadStrength, 0, 1) *
          stepDt
        foot.body.applyImpulse({ x: 0, y: -load, z: 0 }, true)
      }
    }
  }

  /**
   * Horizontal distance, in metres, from the body's centre of mass to the
   * nearest point of the footing it is actually standing on.
   *
   * A kinematic pelvis has infinite mass, so Rapier will happily hold a buddy
   * upright on legs that have been swept out from under it. Nothing in the
   * simulation can report that as a fall, so the scene needs this measurement
   * to decide when the performance has stopped being physically plausible.
   *
   * Returns Infinity when no foot is near the floor at all.
   */
  balanceOffset(): number {
    let mass = 0
    _balanceCom.set(0, 0, 0)
    for (const part of this.parts.values()) {
      const partMass = part.body.mass()
      if (partMass <= 0) {
        continue
      }
      const at = part.body.translation()
      _balanceCom.x += at.x * partMass
      _balanceCom.y += at.y * partMass
      _balanceCom.z += at.z * partMass
      mass += partMass
    }
    if (mass <= 0) {
      return 0
    }
    _balanceCom.divideScalar(mass)
    _balanceCom.y = 0

    let grounded = 0
    for (const slot of FOOT_SLOTS) {
      const foot = this.parts.get(slot)
      if (!foot) {
        continue
      }
      const at = foot.body.translation()
      _downRay.origin = { x: at.x, y: at.y, z: at.z }
      const hit = this.world.castRay(
        _downRay,
        BALANCE_GROUND_REACH * this.scale,
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
      )
      if (!hit) {
        continue
      }
      ;(grounded === 0 ? _footA : _footB).set(at.x, 0, at.z)
      grounded += 1
    }

    if (grounded === 0) {
      return Number.POSITIVE_INFINITY
    }
    if (grounded === 1) {
      return _balanceCom.distanceTo(_footA)
    }

    // Two planted feet give a support line rather than a point, which is what
    // lets a wide stance stay stable while a splayed one does not.
    _supportSpan.copy(_footB).sub(_footA)
    const spanSq = _supportSpan.lengthSq()
    if (spanSq < 1e-8) {
      return _balanceCom.distanceTo(_footA)
    }
    const along = THREE.MathUtils.clamp(
      _supportClosest.copy(_balanceCom).sub(_footA).dot(_supportSpan) / spanSq,
      0,
      1,
    )
    _supportClosest.copy(_footA).addScaledVector(_supportSpan, along)
    return _balanceCom.distanceTo(_supportClosest)
  }

  /** Writes sole friction only on a change of state — this runs every step. */
  private setFootSliding(slot: BoneSlot, foot: RagdollPart, sliding: boolean): void {
    if (this.slidingFeet.has(slot) === sliding) {
      return
    }

    const friction = sliding ? FOOT_SLIDE_FRICTION : this.footGripFriction
    for (const collider of [foot.collider, ...foot.proxies]) {
      collider.setFriction(friction)
    }

    if (sliding) {
      this.slidingFeet.add(slot)
    } else {
      this.slidingFeet.delete(slot)
    }
  }

  /** Live-update material, damping and mass without rebuilding the ragdoll. */
  updateMaterial(options: {
    friction: number
    restitution: number
    linearDamping: number
    angularDamping: number
    density: number
  }): void {
    this.footGripFriction = Math.max(options.friction, 1.2)

    for (const part of this.parts.values()) {
      const isFoot = part.segment.slot === 'footL' || part.segment.slot === 'footR'
      // A foot mid-stride keeps its low friction until it arrives, otherwise a
      // slider change would re-weld it to the floor part-way through a step.
      const friction = isFoot
        ? this.slidingFeet.has(part.segment.slot)
          ? FOOT_SLIDE_FRICTION
          : this.footGripFriction
        : options.friction
      for (const collider of [part.collider, ...part.proxies]) {
        collider.setFriction(friction)
        collider.setRestitution(options.restitution)
        collider.setDensity(options.density)
      }
      part.body.setLinearDamping(options.linearDamping)
      part.body.setAngularDamping(options.angularDamping)
    }
  }

  bodyForCollider(handle: number): RagdollPart | undefined {
    for (const part of this.parts.values()) {
      if (
        part.collider.handle === handle ||
        part.proxies.some((collider) => collider.handle === handle)
      ) {
        return part
      }
    }
    return undefined
  }

  /**
   * Drop-ins start above / through the ceiling slab. Ignoring it for the fall
   * lets them enter under gravity instead of being crushed downward.
   */
  setIgnoreCeiling(ignore: boolean): void {
    const ceiling = this.physics.ceilingColliderHandle
    if (ceiling === null) {
      return
    }

    if (!ignore) {
      for (const [a, b] of this.ceilingIgnored) {
        this.physics.removeContactPair(a, b)
      }
      this.ceilingIgnored.length = 0
      return
    }

    if (this.ceilingIgnored.length > 0) {
      return
    }

    for (const part of this.parts.values()) {
      for (const collider of [part.collider, ...part.proxies]) {
        this.physics.excludeContactPair(collider.handle, ceiling)
        this.ceilingIgnored.push([collider.handle, ceiling])
      }
    }
  }

  dispose(): void {
    this.setIgnoreCeiling(false)
    for (const [a, b] of this.excluded) {
      this.physics.removeContactPair(a, b)
    }
    this.excluded.length = 0

    for (const joint of this.joints) {
      this.world.removeImpulseJoint(joint, false)
    }
    this.joints.length = 0

    for (const part of this.parts.values()) {
      this.world.removeRigidBody(part.body)
    }
    this.parts.clear()
  }
}

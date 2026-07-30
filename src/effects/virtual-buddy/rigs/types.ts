import * as THREE from 'three'

/**
 * Semantic skeleton slots. Every part of the ragdoll addresses bones through
 * these, never through a model's bone names — that indirection is what lets a
 * different character be dropped in as a config change rather than a rewrite.
 */
export type BoneSlot =
  | 'hips'
  | 'chest'
  | 'head'
  | 'upperArmL'
  | 'forearmL'
  | 'upperArmR'
  | 'forearmR'
  | 'thighL'
  | 'shinL'
  | 'footL'
  | 'thighR'
  | 'shinR'
  | 'footR'

export type JointKind = 'spherical' | 'revolute'

export type RigSegment = {
  slot: BoneSlot
  /** null for the root (hips). */
  parent: BoneSlot | null
  /**
   * Segment endpoints in rest-pose model space: metres, Y up, origin on the
   * floor between the feet. The capsule spans head -> tail, and the joint to
   * the parent sits at `head`.
   *
   * For skinned rigs these are overwritten from the model's bind pose at load;
   * the values here are the primitive figure and a fallback.
   */
  head: [number, number, number]
  tail: [number, number, number]
  radius: number
  /** Hinge axis in rest space. Revolute only. */
  axis?: [number, number, number]
  /**
   * Half-range of hinge travel in radians, applied as [-r, +r]. Revolute only.
   *
   * Deliberately symmetric. Rapier picks an arbitrary perpendicular basis when
   * building a revolute joint and offers no way to read the angle back, so an
   * asymmetric anatomical range (elbows bend one way) cannot be positioned
   * reliably — get it wrong and the limit fights the solver every step. A
   * symmetric range is sign-agnostic: both bodies are built at identity
   * rotation from the same axis, so the rest pose sits at the centre regardless.
   */
  limitRange?: number
  joint: JointKind
  /** Source-model bone name. Populated for skinned rigs (e.g. 'mixamorig:Hips'). */
  bone?: string
}

export type RigDefinition = {
  id: string
  label: string
  segments: RigSegment[]
  /**
   * How far the visible mesh hangs below y = 0, in rig metres.
   *
   * The floor plane is the lowest *bone*, but a shoe's sole sits below its toe
   * joint. Foot colliders are aligned to this rather than to the bone, so the
   * character stands on what you can actually see.
   */
  soleDepth?: number
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

export function segmentLength(segment: RigSegment): number {
  return _a.fromArray(segment.head).distanceTo(_b.fromArray(segment.tail))
}

export function segmentCenter(segment: RigSegment, target = new THREE.Vector3()): THREE.Vector3 {
  return target.fromArray(segment.head).add(_b.fromArray(segment.tail)).multiplyScalar(0.5)
}

/** Rotation taking +Y onto the segment's head -> tail direction. */
export function segmentQuaternion(
  segment: RigSegment,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  _a.fromArray(segment.tail).sub(_b.fromArray(segment.head)).normalize()
  return target.setFromUnitVectors(UP, _a)
}

/**
 * Rapier's capsule halfHeight measures the cylinder only — the hemispherical
 * caps add `radius` at each end. Subtract it or every limb comes out too long.
 */
export function capsuleHalfHeight(segment: RigSegment): number {
  return Math.max(0.01, segmentLength(segment) * 0.5 - segment.radius)
}

export function findSegment(rig: RigDefinition, slot: BoneSlot): RigSegment | undefined {
  return rig.segments.find((segment) => segment.slot === slot)
}

const _p1 = new THREE.Vector3()
const _q1 = new THREE.Vector3()
const _p2 = new THREE.Vector3()
const _q2 = new THREE.Vector3()
const _d1 = new THREE.Vector3()
const _d2 = new THREE.Vector3()
const _r = new THREE.Vector3()
const _c1 = new THREE.Vector3()
const _c2 = new THREE.Vector3()

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Closest distance between two line segments (Ericson, Real-Time Collision Detection). */
function segmentDistance(
  p1: THREE.Vector3,
  q1: THREE.Vector3,
  p2: THREE.Vector3,
  q2: THREE.Vector3,
): number {
  _d1.copy(q1).sub(p1)
  _d2.copy(q2).sub(p2)
  _r.copy(p1).sub(p2)

  const a = _d1.dot(_d1)
  const e = _d2.dot(_d2)
  const f = _d2.dot(_r)
  const EPS = 1e-9

  let s = 0
  let t = 0

  if (a <= EPS && e <= EPS) {
    return _r.length()
  }

  if (a <= EPS) {
    t = clamp01(f / e)
  } else {
    const c = _d1.dot(_r)
    if (e <= EPS) {
      s = clamp01(-c / a)
    } else {
      const b = _d1.dot(_d2)
      const denom = a * e - b * b
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = clamp01(-c / a)
      } else if (t > 1) {
        t = 1
        s = clamp01((b - c) / a)
      }
    }
  }

  _c1.copy(_d1).multiplyScalar(s).add(p1)
  _c2.copy(_d2).multiplyScalar(t).add(p2)
  return _c1.distanceTo(_c2)
}

/**
 * Do two segments' capsules interpenetrate in the rest pose?
 *
 * Such pairs can never be separated by the solver — they are overlapping by
 * construction — so their contacts fight the joints holding them together and
 * feed energy into the ragdoll until it flails. Detecting them from geometry
 * means a swapped-in character is handled without hand-maintained exclusions.
 */
export function segmentsOverlapAtRest(
  a: RigSegment,
  b: RigSegment,
  margin = 0.01,
): boolean {
  const distance = segmentDistance(
    _p1.fromArray(a.head),
    _q1.fromArray(a.tail),
    _p2.fromArray(b.head),
    _q2.fromArray(b.tail),
  )
  return distance < a.radius + b.radius + margin
}

/** Parents always precede children, so a single forward pass can rely on order. */
export function segmentsInHierarchyOrder(rig: RigDefinition): RigSegment[] {
  const ordered: RigSegment[] = []
  const remaining = [...rig.segments]
  const placed = new Set<BoneSlot>()

  while (remaining.length > 0) {
    const index = remaining.findIndex(
      (segment) => segment.parent === null || placed.has(segment.parent),
    )
    if (index === -1) {
      throw new Error(`Rig "${rig.id}" has a cycle or a missing parent`)
    }
    const [segment] = remaining.splice(index, 1)
    ordered.push(segment)
    placed.add(segment.slot)
  }

  return ordered
}

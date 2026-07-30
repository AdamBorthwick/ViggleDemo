import type * as THREE from 'three'
import type { BoneSlot } from '../rigs/types'

/**
 * Supplies the world orientation each limb is trying to hold. Muscle-tone
 * torques drive the rigid bodies toward these targets.
 *
 * Targets are expressed as **segment** orientations — "this is the direction
 * the limb should point" — not body rotations. The ragdoll converts between the
 * two, so an animated source can hand over bone orientations directly.
 */
export interface PoseSource {
  /** Fills `target` and returns true, or returns false to leave the slot free. */
  getTargetQuaternion(slot: BoneSlot, target: THREE.Quaternion): boolean
  /**
   * Where a slot's body should sit relative to the root, in rig metres.
   *
   * Orientation alone cannot say whether a limb is in the right *place* — a
   * foot can be perfectly flat and still be half a metre behind the hips — so
   * anything that reasons about limb placement needs this as well.
   */
  getRootRelativePosition?(slot: BoneSlot, target: THREE.Vector3): boolean
  /** Optional per-frame advance, for animated sources. */
  update?(dt: number): void
}

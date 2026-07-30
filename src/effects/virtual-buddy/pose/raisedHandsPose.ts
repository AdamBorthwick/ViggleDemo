import * as THREE from 'three'
import type { BoneSlot } from '../rigs/types'
import type { PoseSource } from './types'

const RAISED_ARM_SLOTS = new Set<BoneSlot>([
  'upperArmL',
  'forearmL',
  'upperArmR',
  'forearmR',
])

/**
 * Entrance pose that only asks the arms to point upward.
 *
 * Identity is the segment orientation for +Y because ragdoll segment
 * quaternions map local +Y onto their target direction. Returning false for
 * every other slot leaves the torso and legs completely under physics while
 * the buddy falls in.
 */
export class RaisedHandsPoseSource implements PoseSource {
  getTargetQuaternion(
    slot: BoneSlot,
    target: THREE.Quaternion,
  ): boolean {
    if (!RAISED_ARM_SLOTS.has(slot)) {
      return false
    }
    target.identity()
    return true
  }
}

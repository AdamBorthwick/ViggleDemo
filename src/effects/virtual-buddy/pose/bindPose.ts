import * as THREE from 'three'
import { segmentQuaternion, type BoneSlot, type RigDefinition } from '../rigs/types'
import type { PoseSource } from './types'

/**
 * The rig's own rest pose, baked once. Needs no model and no animation clip,
 * so phase-one muscle tone works before any asset exists.
 */
export class BindPoseSource implements PoseSource {
  private readonly quaternions = new Map<BoneSlot, THREE.Quaternion>()

  constructor(rig: RigDefinition) {
    for (const segment of rig.segments) {
      this.quaternions.set(segment.slot, segmentQuaternion(segment))
    }
  }

  getTargetQuaternion(slot: BoneSlot, target: THREE.Quaternion): boolean {
    const quaternion = this.quaternions.get(slot)
    if (!quaternion) {
      return false
    }
    target.copy(quaternion)
    return true
  }
}

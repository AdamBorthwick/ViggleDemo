import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import type { Ragdoll, RagdollPart } from '../physics/ragdoll'
import { segmentCenter, segmentsInHierarchyOrder } from '../rigs/types'
import type { CostumePartDef, LoadedModel } from '../models/registry'
import type { AnimationPoseSource } from '../pose/animationPose'

type Bound = {
  part: RagdollPart
  bone: THREE.Bone
  bindRotation: THREE.Quaternion
  headOffset: THREE.Vector3
  isRoot: boolean
}

type Passenger = {
  bone: THREE.Bone
  bindLocal: THREE.Quaternion
}

type TintTarget = {
  material: THREE.MeshStandardMaterial
  /** Load-time albedo (includes brightness). */
  baseColor: THREE.Color
  /** Load-time emissive colour. */
  baseEmissive: THREE.Color
  baseEmissiveIntensity: number
  channel: 'albedo' | 'emissive'
  defaultColor: number
  hasMap: boolean
}

const _bodyPos = new THREE.Vector3()
const _bodyRot = new THREE.Quaternion()
const _worldRot = new THREE.Quaternion()
const _worldPos = new THREE.Vector3()
const _parentRot = new THREE.Quaternion()
const _parentScale = new THREE.Vector3()
const _parentPos = new THREE.Vector3()
const _parentInverse = new THREE.Matrix4()
const _tint = new THREE.Color()
const _default = new THREE.Color()

function safeChannelRatio(value: number, baseline: number): number {
  if (baseline < 1e-4) {
    return value
  }
  return value / baseline
}

function matchPart(
  parts: CostumePartDef[],
  meshName: string,
  materialName: string,
): CostumePartDef | null {
  const label = `${meshName} ${materialName}`
  for (const part of parts) {
    try {
      if (new RegExp(part.match, 'i').test(label)) {
        return part
      }
    } catch {
      // ignore bad patterns
    }
  }
  return parts[0] ?? null
}

/**
 * Draws the actual character, driven by the ragdoll, with per-part costume tints.
 */
export class SkinnedView {
  readonly group = new THREE.Group()
  readonly defaultTint: number
  readonly parts: CostumePartDef[]
  private readonly bound: Bound[] = []
  private readonly passengers: Passenger[] = []
  private readonly partTargets = new Map<string, TintTarget[]>()
  private readonly ownedMaterials: THREE.Material[] = []
  private anim: AnimationPoseSource | null = null

  constructor(ragdoll: Ragdoll, model: LoadedModel) {
    this.parts = model.parts.length > 0 ? model.parts.map((part) => ({ ...part })) : []
    this.defaultTint = (model.defaultTint ?? this.parts[0]?.defaultColor ?? 0xffffff) >>> 0

    const root = cloneSkeleton(model.scene)
    this.group.add(root)

    const scale = model.normalisation * ragdoll.scale
    this.group.scale.setScalar(scale)
    this.group.position.copy(model.offset).multiplyScalar(-scale)

    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh || !mesh.material) {
        return
      }

      const sourceList = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const clonedList = sourceList.map((material) => {
        const cloned = material.clone() as THREE.MeshStandardMaterial
        this.ownedMaterials.push(cloned)

        const matName = cloned.name || material.name || ''
        const meshName = mesh.name || ''
        const part = matchPart(this.parts, meshName, matName)
        if (part && cloned.color) {
          const list = this.partTargets.get(part.id) ?? []
          list.push({
            material: cloned,
            baseColor: cloned.color.clone(),
            baseEmissive: cloned.emissive?.clone() ?? new THREE.Color(0x000000),
            baseEmissiveIntensity: cloned.emissiveIntensity ?? 1,
            channel: part.channel,
            defaultColor: part.defaultColor >>> 0,
            hasMap: Boolean(cloned.map),
          })
          this.partTargets.set(part.id, list)
        }
        return cloned
      })
      mesh.material = Array.isArray(mesh.material) ? clonedList : clonedList[0]!
    })

    // Ensure every declared part has at least the first costume material if
    // matching failed (single-mesh ninja still gets suit + trim channels).
    if (this.parts.length > 0 && this.partTargets.size === 0) {
      for (const material of this.ownedMaterials) {
        const std = material as THREE.MeshStandardMaterial
        if (!std.color) {
          continue
        }
        for (const part of this.parts) {
          const list = this.partTargets.get(part.id) ?? []
          list.push({
            material: std,
            baseColor: std.color.clone(),
            baseEmissive: std.emissive?.clone() ?? new THREE.Color(0x000000),
            baseEmissiveIntensity: std.emissiveIntensity ?? 1,
            channel: part.channel,
            defaultColor: part.defaultColor >>> 0,
            hasMap: Boolean(std.map),
          })
          this.partTargets.set(part.id, list)
        }
        break
      }
    }

    const bones = new Map<string, THREE.Bone>()
    root.traverse((child) => {
      if ((child as THREE.Bone).isBone) {
        bones.set(child.name, child as THREE.Bone)
      }
    })

    this.group.updateMatrixWorld(true)

    for (const segment of segmentsInHierarchyOrder(ragdoll.rig)) {
      const part = ragdoll.parts.get(segment.slot)
      const bone = segment.bone ? bones.get(segment.bone) : undefined
      if (!part || !bone) {
        continue
      }

      const bindRotation = bone.getWorldQuaternion(new THREE.Quaternion())
      const centre = segmentCenter(segment)
      const headOffset = new THREE.Vector3(...segment.head)
        .sub(centre)
        .multiplyScalar(ragdoll.scale)

      this.bound.push({
        part,
        bone,
        bindRotation,
        headOffset,
        isRoot: segment.parent === null,
      })
    }

    const driven = new Set(this.bound.map((entry) => entry.bone))
    for (const bone of bones.values()) {
      if (!driven.has(bone)) {
        this.passengers.push({ bone, bindLocal: bone.quaternion.clone() })
      }
    }
  }

  setAnimationSource(anim: AnimationPoseSource | null): void {
    this.anim = anim
  }

  /** Applies every part colour from a map of partId → hex. */
  setPartColors(colors: Record<string, number>): void {
    for (const part of this.parts) {
      const hex = colors[part.id] ?? part.defaultColor
      this.setPartTint(part.id, hex)
    }
  }

  setPartTint(partId: string, hex: number): void {
    const targets = this.partTargets.get(partId)
    if (!targets || targets.length === 0) {
      return
    }
    const packed = hex >>> 0
    _tint.setHex(packed)

    for (const target of targets) {
      _default.setHex(target.defaultColor)
      if (target.channel === 'emissive') {
        // At the part default, restore load-time emissive; otherwise scale it.
        if (packed === target.defaultColor) {
          target.material.emissive.copy(target.baseEmissive)
          target.material.emissiveIntensity = target.baseEmissiveIntensity
        } else {
          target.material.emissive.setRGB(
            target.baseEmissive.r * safeChannelRatio(_tint.r, _default.r),
            target.baseEmissive.g * safeChannelRatio(_tint.g, _default.g),
            target.baseEmissive.b * safeChannelRatio(_tint.b, _default.b),
          )
          target.material.emissiveIntensity = Math.max(
            target.baseEmissiveIntensity,
            0.35,
          )
        }
        continue
      }

      // Albedo
      if (target.hasMap) {
        // Textured costume: keep map fidelity at the default colour.
        if (packed === target.defaultColor) {
          target.material.color.copy(target.baseColor)
        } else {
          target.material.color.setRGB(
            target.baseColor.r * safeChannelRatio(_tint.r, _default.r),
            target.baseColor.g * safeChannelRatio(_tint.g, _default.g),
            target.baseColor.b * safeChannelRatio(_tint.b, _default.b),
          )
        }
      } else {
        // Solid materials (Buddy body / joints): the colour IS the control.
        target.material.color.setHex(packed)
      }
    }
  }

  /** Convenience: set every albedo part to one colour (capsule fallback path). */
  setTint(hex: number): void {
    const packed = hex >>> 0
    for (const part of this.parts) {
      if (part.channel === 'albedo') {
        this.setPartTint(part.id, packed)
      }
    }
  }

  sync(): void {
    const playing = this.anim?.isPlaying ?? false
    for (const { bone, bindLocal } of this.passengers) {
      const reference = playing ? this.anim?.referenceBones.get(bone.name) : undefined
      bone.quaternion.copy(reference ? reference.quaternion : bindLocal)
    }

    for (const { part, bone, bindRotation, headOffset, isRoot } of this.bound) {
      const translation = part.body.translation()
      const rotation = part.body.rotation()
      _bodyPos.set(translation.x, translation.y, translation.z)
      _bodyRot.set(rotation.x, rotation.y, rotation.z, rotation.w)

      _worldRot.copy(_bodyRot).multiply(bindRotation)

      const parent = bone.parent
      if (!parent) {
        continue
      }
      parent.updateWorldMatrix(true, false)

      parent.matrixWorld.decompose(_parentPos, _parentRot, _parentScale)
      bone.quaternion.copy(_parentRot.invert()).multiply(_worldRot)

      if (isRoot) {
        _worldPos.copy(headOffset).applyQuaternion(_bodyRot).add(_bodyPos)
        _parentInverse.copy(parent.matrixWorld).invert()
        bone.position.copy(_worldPos.applyMatrix4(_parentInverse))
      }

      bone.updateWorldMatrix(false, false)
    }
  }

  dispose(): void {
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (mesh.isMesh) {
        mesh.geometry?.dispose()
      }
    })
    for (const material of this.ownedMaterials) {
      material.dispose()
    }
    this.ownedMaterials.length = 0
    this.partTargets.clear()
    this.group.clear()
    this.bound.length = 0
    this.passengers.length = 0
    this.anim = null
  }
}

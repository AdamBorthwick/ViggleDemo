import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import type { Ragdoll, RagdollPart } from '../physics/ragdoll'
import { segmentCenter, segmentsInHierarchyOrder } from '../rigs/types'
import type { CostumePartDef, LoadedModel } from '../models/registry'
import type { AnimationPoseSource } from '../pose/animationPose'
import {
  installCostumeTintShader,
  type CostumeTintUniforms,
} from './costumeTintShader'

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
  baseColor: THREE.Color
  baseEmissive: THREE.Color
  baseEmissiveIntensity: number
  channel: CostumePartDef['channel']
  defaultColor: number
  hasMap: boolean
  /** Present when this material uses the skin/armour split shader. */
  splitUniforms: CostumeTintUniforms | null
  /** Helmet / full-mesh armour: no skin classification. */
  forceArmorOnly: boolean
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

/**
 * Draws the actual character, driven by the ragdoll, with per-part costume tints.
 *
 * For single-atlas Mixamo assets (Paladin body, Ninja), skin and armour share a
 * texture — those materials use a shader that classifies flesh vs cloth/metal
 * so the Models panel can recolour them independently.
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

    const usesSkinSplit = this.parts.some(
      (part) =>
        part.channel === 'skin' || part.channel === 'armor' || part.channel === 'trim',
    )
    const usesTrimSplit = this.parts.some((part) => part.channel === 'trim')
    // Shirt id → yellow-cloth armour mask (dancer). Trim → metal plate mode.
    const usesYellowShirt = this.parts.some((part) => part.id === 'shirt')
    const armorMode = usesYellowShirt ? 2 : usesTrimSplit ? 1 : 0

    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh || !mesh.material) {
        return
      }

      // Ragdoll / Mixamo skinning moves vertices far from the bind-pose bounds.
      // Default frustum culling then drops hair, cloth cards, and body parts
      // when the camera gets close — most noticeable on multi-mesh assets
      // like the Dancer (separate hair / body skins).
      mesh.frustumCulled = false

      const sourceList = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const clonedList = sourceList.map((material) => {
        const cloned = material.clone() as THREE.MeshStandardMaterial
        this.ownedMaterials.push(cloned)

        const matName = cloned.name || material.name || ''
        const meshName = mesh.name || ''
        const label = `${meshName} ${matName}`
        const isHelmet = /helmet/i.test(label)
        const isHair = /hair|eyelash/i.test(label)

        // Hair cards ship as alpha-blend atlases; cutout + depth write keeps them
        // visible in this stage lighting (full blend often sorts away to nothing).
        if (isHair) {
          cloned.transparent = true
          cloned.alphaTest = 0.4
          cloned.depthWrite = true
          cloned.side = THREE.DoubleSide
          mesh.renderOrder = 2
        }

        let splitUniforms: CostumeTintUniforms | null = null
        if (usesSkinSplit && cloned.map && !isHair) {
          splitUniforms = installCostumeTintShader(cloned)
          splitUniforms.uUseSkinSplit.value = isHelmet ? 0 : 1
          splitUniforms.uUseTrimSplit.value = isHelmet || !usesTrimSplit ? 0 : 1
          splitUniforms.uArmorMode.value = isHelmet ? 0 : armorMode
          // material.color stays as brightness lift; region tints live in uniforms.
        }

        for (const part of this.parts) {
          let matched = false
          try {
            matched = new RegExp(part.match, 'i').test(label)
          } catch {
            matched = false
          }
          if (!matched || !cloned.color) {
            continue
          }

          // Skin / trim controls do not attach to pure-armour meshes (helmet).
          if ((part.channel === 'skin' || part.channel === 'trim') && isHelmet) {
            continue
          }

          const list = this.partTargets.get(part.id) ?? []
          list.push({
            material: cloned,
            baseColor: cloned.color.clone(),
            baseEmissive: cloned.emissive?.clone() ?? new THREE.Color(0x000000),
            baseEmissiveIntensity: cloned.emissiveIntensity ?? 1,
            channel: part.channel,
            defaultColor: part.defaultColor >>> 0,
            hasMap: Boolean(cloned.map),
            splitUniforms,
            forceArmorOnly: isHelmet || part.channel === 'albedo',
          })
          this.partTargets.set(part.id, list)
        }
        return cloned
      })
      mesh.material = Array.isArray(mesh.material) ? clonedList : clonedList[0]!
    })

    // Single-mesh fallback: bind every part to the first textured material.
    if (this.parts.length > 0 && this.partTargets.size === 0) {
      for (const material of this.ownedMaterials) {
        const std = material as THREE.MeshStandardMaterial
        if (!std.color) {
          continue
        }
        let splitUniforms: CostumeTintUniforms | null = null
        if (usesSkinSplit && std.map) {
          splitUniforms = installCostumeTintShader(std)
          splitUniforms.uUseSkinSplit.value = 1
          splitUniforms.uUseTrimSplit.value = usesTrimSplit ? 1 : 0
          splitUniforms.uArmorMode.value = armorMode
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
            splitUniforms,
            forceArmorOnly: false,
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

      // Skin / armour / trim split path (textured Mixamo body).
      // Absolute multipliers: default → (1,1,1) so the map reads as authored;
      // any other colour multiplies that region of the texture only.
      if (
        target.splitUniforms &&
        (target.channel === 'skin' ||
          target.channel === 'armor' ||
          target.channel === 'trim')
      ) {
        const multiply = new THREE.Color(1, 1, 1)
        if (packed !== target.defaultColor) {
          multiply.setHex(packed)
        }
        if (target.channel === 'skin') {
          target.splitUniforms.uSkinTint.value.copy(multiply)
        } else if (target.channel === 'trim') {
          target.splitUniforms.uTrimTint.value.copy(multiply)
        } else {
          target.splitUniforms.uArmorTint.value.copy(multiply)
        }
        // Keep material.color as the stage brightness lift only.
        target.material.color.copy(target.baseColor)
        continue
      }

      // Simple albedo path (Buddy solids, helmet as whole mesh, etc.)
      if (target.hasMap) {
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
        target.material.color.setHex(packed)
      }
    }
  }

  setTint(hex: number): void {
    const packed = hex >>> 0
    for (const part of this.parts) {
      if (part.channel === 'albedo' || part.channel === 'armor') {
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
    // Geometry is deliberately left alone. `SkeletonUtils.clone` copies the
    // scene graph but shares buffers (`Mesh.copy` assigns `source.geometry` by
    // reference), so the meshes here point at the cached template's geometry —
    // the same instance every future buddy of this model will use. Disposing it
    // drops the GPU buffers for the whole character and forces a full re-upload
    // on the next frame that draws one. Only the cloned materials are ours.
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

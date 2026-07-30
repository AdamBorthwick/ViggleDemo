import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import type { Ragdoll } from '../physics/ragdoll'
import { capsuleHalfHeight, segmentQuaternion } from '../rigs/types'

type Bound = { mesh: THREE.Mesh; body: RAPIER.RigidBody }

/**
 * One capsule mesh per rigid body.
 *
 * Not scaffolding — this stays as the permanent "show physics bodies" view once
 * the skinned character lands, which is the single most useful debugging
 * affordance in a physics tool.
 */
export class PrimitiveView {
  readonly group = new THREE.Group()
  private readonly bound: Bound[] = []
  private readonly geometries: THREE.BufferGeometry[] = []

  constructor(ragdoll: Ragdoll, material: THREE.Material) {
    for (const part of ragdoll.parts.values()) {
      const radius = part.segment.radius * ragdoll.scale
      const cylinder = capsuleHalfHeight(part.segment) * ragdoll.scale * 2
      const geometry = new THREE.CapsuleGeometry(radius, cylinder, 6, 14)

      // Bake the limb direction in, so the mesh transform is a straight copy of
      // the body transform — bodies deliberately sit at identity rotation.
      geometry.applyQuaternion(segmentQuaternion(part.segment))

      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = true
      mesh.receiveShadow = true

      this.group.add(mesh)
      this.geometries.push(geometry)
      this.bound.push({ mesh, body: part.body })
    }
  }

  sync(): void {
    for (const { mesh, body } of this.bound) {
      const t = body.translation()
      const r = body.rotation()
      mesh.position.set(t.x, t.y, t.z)
      mesh.quaternion.set(r.x, r.y, r.z, r.w)
    }
  }

  setTint(hex: number): void {
    for (const { mesh } of this.bound) {
      const material = mesh.material as THREE.MeshStandardMaterial
      if (material?.color) {
        material.color.setHex(hex)
      }
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) {
      geometry.dispose()
    }
    // Dispose per-buddy materials (not the shared template).
    const seen = new Set<THREE.Material>()
    for (const { mesh } of this.bound) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (material && !seen.has(material)) {
          seen.add(material)
          material.dispose()
        }
      }
    }
    this.geometries.length = 0
    this.bound.length = 0
    this.group.clear()
    this.group.removeFromParent()
  }
}

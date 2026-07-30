import * as THREE from 'three'
import type { BoneSlot, JointKind, RigDefinition, RigSegment } from './types'

/** Every Mixamo skeleton uses this prefix, which is what makes autodetect work. */
const PREFIX = 'mixamorig'

/**
 * Bone names cannot be compared literally.
 *
 * Three's GLTFLoader runs every node name through `PropertyBinding
 * .sanitizeNodeName`, which strips `[ ] . : /` — so `mixamorig:Hips` arrives as
 * `mixamorigHips`. Other exporters emit `mixamorig_Hips`. Folding case and
 * dropping non-alphanumerics makes all three spellings match.
 */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Metres. Mixamo ships centimetres, so every model gets normalised to this. */
export const TARGET_HEIGHT = 1.7

type SlotSpec = {
  slot: BoneSlot
  parent: BoneSlot | null
  /** Bone this body drives, and whose head is the segment's start. */
  bone: string
  /** Bone whose head marks the segment's far end. */
  tailBone: string
  joint: JointKind
  axis?: [number, number, number]
  limitRange?: number
  /**
   * Capsule radius as a fraction of total figure height, not of segment length.
   * The torso segments are short but wide — deriving their radius from their own
   * length gives a pencil-thin chest.
   */
  radiusOfHeight: number
}

/**
 * Slot -> Mixamo bone mapping.
 *
 * Only 13 of the skeleton's 65 bones get physics bodies. Fingers, toes,
 * shoulders and the intermediate spine joints ride along with their parents,
 * which is both cheaper and steadier than simulating them.
 */
const SLOTS: SlotSpec[] = [
  {
    slot: 'hips',
    parent: null,
    bone: 'Hips',
    tailBone: 'Spine1',
    joint: 'spherical',
    radiusOfHeight: 0.065,
  },
  {
    slot: 'chest',
    parent: 'hips',
    bone: 'Spine1',
    tailBone: 'Neck',
    joint: 'spherical',
    radiusOfHeight: 0.076,
  },
  {
    slot: 'head',
    parent: 'chest',
    bone: 'Head',
    tailBone: 'HeadTop_End',
    joint: 'spherical',
    radiusOfHeight: 0.062,
  },

  {
    slot: 'upperArmL',
    parent: 'chest',
    bone: 'LeftArm',
    tailBone: 'LeftForeArm',
    joint: 'spherical',
    radiusOfHeight: 0.029,
  },
  {
    // Spherical, unlike the knee. A hinge needs an axis perpendicular to the
    // limb, and in the T-pose the arm runs along X — the same direction the
    // elbow axis would have to be expressed in, which makes it a twist hinge
    // that cannot bend at all. The shoulder above it is already spherical, so
    // a free elbow costs no realism and lets clips actually flex the arm.
    slot: 'forearmL',
    parent: 'upperArmL',
    bone: 'LeftForeArm',
    tailBone: 'LeftHand',
    joint: 'spherical',
    radiusOfHeight: 0.026,
  },
  {
    slot: 'upperArmR',
    parent: 'chest',
    bone: 'RightArm',
    tailBone: 'RightForeArm',
    joint: 'spherical',
    radiusOfHeight: 0.029,
  },
  {
    // Spherical for the same reason as the left elbow.
    slot: 'forearmR',
    parent: 'upperArmR',
    bone: 'RightForeArm',
    tailBone: 'RightHand',
    joint: 'spherical',
    radiusOfHeight: 0.026,
  },

  {
    slot: 'thighL',
    parent: 'hips',
    bone: 'LeftUpLeg',
    tailBone: 'LeftLeg',
    joint: 'spherical',
    radiusOfHeight: 0.046,
  },
  {
    slot: 'shinL',
    parent: 'thighL',
    bone: 'LeftLeg',
    tailBone: 'LeftFoot',
    joint: 'revolute',
    axis: [1, 0, 0],
    limitRange: 2.2,
    radiusOfHeight: 0.036,
  },
  {
    slot: 'footL',
    parent: 'shinL',
    bone: 'LeftFoot',
    tailBone: 'LeftToeBase',
    joint: 'revolute',
    axis: [1, 0, 0],
    limitRange: 0.6,
    radiusOfHeight: 0.026,
  },
  {
    slot: 'thighR',
    parent: 'hips',
    bone: 'RightUpLeg',
    tailBone: 'RightLeg',
    joint: 'spherical',
    radiusOfHeight: 0.046,
  },
  {
    slot: 'shinR',
    parent: 'thighR',
    bone: 'RightLeg',
    tailBone: 'RightFoot',
    joint: 'revolute',
    axis: [1, 0, 0],
    limitRange: 2.2,
    radiusOfHeight: 0.036,
  },
  {
    slot: 'footR',
    parent: 'shinR',
    bone: 'RightFoot',
    tailBone: 'RightToeBase',
    joint: 'revolute',
    axis: [1, 0, 0],
    limitRange: 0.6,
    radiusOfHeight: 0.026,
  },
]

/** Keyed by normalised name — see `normalise`. */
export function collectBones(root: THREE.Object3D): Map<string, THREE.Bone> {
  const bones = new Map<string, THREE.Bone>()
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) {
      bones.set(normalise(child.name), child as THREE.Bone)
    }
  })
  return bones
}

/** Autodetect: any skeleton carrying Mixamo's naming can use this rig. */
export function isMixamoSkeleton(bones: Map<string, THREE.Bone>): boolean {
  return bones.has(normalise(`${PREFIX}Hips`))
}

export type MixamoRigResult = {
  rig: RigDefinition
  /** Uniform scale applied to reach TARGET_HEIGHT. */
  normalisation: number
  /** Model-space offset removed so the figure stands on y = 0, centred on x/z. */
  offset: THREE.Vector3
  measuredHeight: number
}

/**
 * Reads the bind pose off a loaded skeleton and produces a concrete rig.
 *
 * Positions come from the model rather than a table, so a swapped-in character
 * brings its own proportions. Height is measured and normalised rather than
 * assumed: Mixamo exports centimetres, Blender often adds a 0.1 armature scale
 * on top, and the physics world is metres with real gravity — get this wrong and
 * the buddy falls like a skyscraper.
 */
export function buildMixamoRig(root: THREE.Object3D): MixamoRigResult | null {
  root.updateWorldMatrix(true, true)
  const bones = collectBones(root)
  if (!isMixamoSkeleton(bones)) {
    return null
  }

  const boneFor = (name: string): THREE.Bone | undefined =>
    bones.get(normalise(`${PREFIX}${name}`))

  const worldOf = (name: string): THREE.Vector3 | null => {
    const bone = boneFor(name)
    return bone ? bone.getWorldPosition(new THREE.Vector3()) : null
  }

  // Height from the ground to the crown, measured on the actual skeleton.
  const crown = worldOf('HeadTop_End') ?? worldOf('Head')
  const hips = worldOf('Hips')
  if (!crown || !hips) {
    return null
  }

  let minY = Infinity
  for (const bone of bones.values()) {
    minY = Math.min(minY, bone.getWorldPosition(new THREE.Vector3()).y)
  }

  const measuredHeight = Math.max(1e-4, crown.y - minY)
  const normalisation = TARGET_HEIGHT / measuredHeight
  // Stand the figure on the floor, centred on the hips in plan.
  const offset = new THREE.Vector3(hips.x, minY, hips.z)

  const toRig = (world: THREE.Vector3): [number, number, number] => {
    const local = world.clone().sub(offset).multiplyScalar(normalisation)
    return [local.x, local.y, local.z]
  }

  const segments: RigSegment[] = []
  for (const spec of SLOTS) {
    const bone = boneFor(spec.bone)
    const head = worldOf(spec.bone)
    const tail = worldOf(spec.tailBone)
    if (!bone || !head || !tail) {
      // A skeleton missing a bone we depend on is not usable as a ragdoll.
      return null
    }

    segments.push({
      slot: spec.slot,
      parent: spec.parent,
      head: toRig(head),
      tail: toRig(tail),
      radius: spec.radiusOfHeight * TARGET_HEIGHT,
      joint: spec.joint,
      axis: spec.axis,
      limitRange: spec.limitRange,
      // The name as the loader actually spelled it, so downstream lookups are
      // exact and do not have to repeat the normalisation.
      bone: bone.name,
    })
  }

  // Skinned geometry reaches below the toe joint that defines the floor plane.
  // Measuring it lets the foot colliders be placed against the visible sole
  // instead of the bone, which is what keeps the figure from hovering.
  const meshBounds = new THREE.Box3().setFromObject(root)
  const soleDepth = Number.isFinite(meshBounds.min.y)
    ? Math.max(0, minY - meshBounds.min.y) * normalisation
    : 0

  return {
    rig: { id: 'mixamo', label: 'Mixamo character', segments, soleDepth },
    normalisation,
    offset,
    measuredHeight,
  }
}

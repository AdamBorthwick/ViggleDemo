import type { RigDefinition, RigSegment } from './types'

type Vec3 = [number, number, number]

/** Same segment on the other side of the body. */
function mirror(segment: RigSegment, slot: RigSegment['slot'], parent: RigSegment['parent']): RigSegment {
  const flipX = ([x, y, z]: Vec3): Vec3 => [-x, y, z]
  return {
    ...segment,
    slot,
    parent,
    head: flipX(segment.head),
    tail: flipX(segment.tail),
    // Hinge axis is deliberately not mirrored. Both elbows bend forward and
    // both knees bend backward, which is the same rotation about world +X on
    // either side, so the axis carries over unchanged.
  }
}

const upperArmL: RigSegment = {
  slot: 'upperArmL',
  parent: 'chest',
  head: [0.18, 1.38, 0],
  tail: [0.3, 1.09, 0],
  radius: 0.052,
  joint: 'spherical',
}

const forearmL: RigSegment = {
  slot: 'forearmL',
  parent: 'upperArmL',
  head: [0.3, 1.09, 0],
  tail: [0.39, 0.81, 0],
  radius: 0.045,
  joint: 'revolute',
  axis: [1, 0, 0],
  // Wide: stops the forearm spinning a full turn without pretending to know
  // which way an elbow folds.
  limitRange: 2.2,
}

const thighL: RigSegment = {
  slot: 'thighL',
  parent: 'hips',
  head: [0.1, 0.9, 0],
  tail: [0.11, 0.49, 0],
  radius: 0.078,
  joint: 'spherical',
}

const shinL: RigSegment = {
  slot: 'shinL',
  parent: 'thighL',
  head: [0.11, 0.49, 0],
  tail: [0.115, 0.09, 0],
  radius: 0.062,
  joint: 'revolute',
  axis: [1, 0, 0],
  limitRange: 2.2,
}

const footL: RigSegment = {
  slot: 'footL',
  parent: 'shinL',
  head: [0.115, 0.09, 0],
  tail: [0.115, 0.025, 0.15],
  radius: 0.045,
  joint: 'revolute',
  axis: [1, 0, 0],
  // Tight. An ankle barely travels, and a free one lets the foot fold up
  // through the shin — the two are jointed, so contacts between them are
  // suppressed and nothing else would stop it.
  limitRange: 0.6,
}

/**
 * A ~1.75m standing figure in a relaxed A-pose, described entirely in rest-pose
 * model space (metres, Y up, origin on the floor between the feet).
 *
 * A-pose rather than T-pose: arms already hanging means fewer tangled limbs on
 * the first frame, and it settles into a slump more naturally.
 *
 * Hinge travel is symmetric rather than anatomical — see `limitRange` in
 * `rigs/types.ts` for why a one-way range cannot be placed reliably.
 */
export const primitiveRig: RigDefinition = {
  id: 'primitive',
  label: 'Primitive',
  segments: [
    {
      slot: 'hips',
      parent: null,
      head: [0, 0.92, 0],
      tail: [0, 1.06, 0],
      radius: 0.11,
      joint: 'spherical',
    },
    {
      slot: 'chest',
      parent: 'hips',
      head: [0, 1.06, 0],
      tail: [0, 1.42, 0],
      radius: 0.13,
      joint: 'spherical',
    },
    {
      slot: 'head',
      parent: 'chest',
      head: [0, 1.44, 0],
      tail: [0, 1.7, 0],
      radius: 0.105,
      joint: 'spherical',
    },
    upperArmL,
    forearmL,
    mirror(upperArmL, 'upperArmR', 'chest'),
    mirror(forearmL, 'forearmR', 'upperArmR'),
    thighL,
    shinL,
    footL,
    mirror(thighL, 'thighR', 'hips'),
    mirror(shinL, 'shinR', 'thighR'),
    mirror(footL, 'footR', 'shinR'),
  ],
}

/** Floor-to-crown height of the rest pose, used to normalise body scale. */
export const PRIMITIVE_RIG_HEIGHT = 1.7

import RAPIER from '@dimforge/rapier3d-compat'

let bootPromise: Promise<void> | null = null

/**
 * Boots Rapier's WASM. Memoised, so StrictMode's double mount and any later
 * remount share one initialisation instead of racing two.
 */
export function initPhysics(): Promise<void> {
  bootPromise ??= RAPIER.init()
  return bootPromise
}

export type Bounds = {
  halfWidth: number
  halfDepth: number
  ceiling: number
}

const STEP = 1 / 60
/** Beyond this we drop the backlog rather than run a catch-up storm. */
const MAX_STEPS_PER_FRAME = 5
const WALL_THICKNESS = 0.5

/** Packs two collider handles into one lookup key. Handles are small integers. */
function pairKey(a: number, b: number): number {
  return a < b ? a * 0x10000 + b : b * 0x10000 + a
}

type Wall = {
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
}

type WallFace = {
  half: [number, number, number]
  at: [number, number, number]
}

/** Below this a bounds change is not worth touching the solver for. */
const BOUNDS_EPSILON = 1e-4

export class PhysicsWorld {
  readonly world: RAPIER.World
  private readonly eventQueue = new RAPIER.EventQueue(true)
  private walls: Wall[] = []
  private accumulator = 0

  /**
   * Collider pairs whose contacts are suppressed.
   *
   * Self-collision inside a ragdoll has to be *selective*. Neighbouring
   * capsules overlap by construction and can never be separated, so their
   * contacts fight the joints and pump energy in until the body flails — those
   * must be ignored. But a forearm swinging into the torso should still be
   * blocked, so switching self-collision off wholesale makes limbs pass through
   * each other. Only the genuinely-overlapping pairs belong in here.
   */
  private readonly excludedPairs = new Set<number>()

  private readonly hooks: RAPIER.PhysicsHooks = {
    filterContactPair: (collider1, collider2) =>
      this.excludedPairs.has(pairKey(collider1, collider2))
        ? null
        : RAPIER.SolverFlags.COMPUTE_IMPULSE,
    filterIntersectionPair: () => true,
  }

  constructor(gravity = -9.81) {
    this.world = new RAPIER.World({ x: 0, y: gravity, z: 0 })
    this.world.timestep = STEP

    // A 13-body chain with contacts is a stiff system; Rapier's default 4
    // iterations leave enough constraint error per step for the ragdoll to gain
    // energy and flail. Cheap fix at this body count.
    this.world.numSolverIterations = 8
  }

  setGravity(y: number): void {
    this.world.gravity = { x: 0, y, z: 0 }
  }

  excludeContactPair(a: number, b: number): void {
    this.excludedPairs.add(pairKey(a, b))
  }

  /**
   * Handles are recycled after a collider is freed, so a disposed ragdoll must
   * withdraw its exclusions or it will silently disable contacts for whatever
   * reuses them.
   */
  removeContactPair(a: number, b: number): void {
    this.excludedPairs.delete(pairKey(a, b))
  }

  /** The six cage faces for a given bounds, in a stable order. */
  private static wallFaces({ halfWidth, halfDepth, ceiling }: Bounds): WallFace[] {
    const t = WALL_THICKNESS
    return [
      // Floor. Sunk by its own thickness so the walking surface is exactly
      // y = 0 at every size — only the extent changes as the frustum does.
      { half: [halfWidth + t, t, halfDepth + t], at: [0, -t, 0] },
      // ceiling, generous so a hard throw does not clip it
      { half: [halfWidth + t, t, halfDepth + t], at: [0, ceiling + t, 0] },
      // left / right
      { half: [t, ceiling + t, halfDepth + t], at: [-halfWidth - t, ceiling * 0.5, 0] },
      { half: [t, ceiling + t, halfDepth + t], at: [halfWidth + t, ceiling * 0.5, 0] },
      // back / front — close together, keeping play near the picture plane
      { half: [halfWidth + t, ceiling + t, t], at: [0, ceiling * 0.5, -halfDepth - t] },
      { half: [halfWidth + t, ceiling + t, t], at: [0, ceiling * 0.5, halfDepth + t] },
    ]
  }

  /**
   * Rebuilds the invisible cage. Derived from the camera frustum, so this has
   * to be re-run on resize — including when the control panel opens and changes
   * the viewport width.
   *
   * Walls are mutated in place rather than recreated. Dragging a window edge
   * fires a resize every frame, and destroying the bodies each time destroyed
   * the floor with them: standing buddies lost the contact holding them up and
   * sank through the stage. Resizing a collider leaves the body — and its
   * contacts — intact, and the floor's top face never moves at all.
   */
  setBounds(bounds: Bounds): void {
    const faces = PhysicsWorld.wallFaces(bounds)

    if (this.walls.length !== faces.length) {
      for (const wall of this.walls) {
        this.world.removeRigidBody(wall.body)
      }
      this.walls = faces.map((face) => {
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(...face.at),
        )
        const collider = this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(...face.half).setFriction(0.7).setRestitution(0.1),
          body,
        )
        return { body, collider }
      })
      return
    }

    for (let i = 0; i < faces.length; i += 1) {
      const face = faces[i]!
      const wall = this.walls[i]!

      const at = wall.body.translation()
      if (
        Math.abs(at.x - face.at[0]) > BOUNDS_EPSILON ||
        Math.abs(at.y - face.at[1]) > BOUNDS_EPSILON ||
        Math.abs(at.z - face.at[2]) > BOUNDS_EPSILON
      ) {
        wall.body.setTranslation(
          { x: face.at[0], y: face.at[1], z: face.at[2] },
          false,
        )
      }

      const half = (wall.collider.shape as RAPIER.Cuboid).halfExtents
      if (
        Math.abs(half.x - face.half[0]) > BOUNDS_EPSILON ||
        Math.abs(half.y - face.half[1]) > BOUNDS_EPSILON ||
        Math.abs(half.z - face.half[2]) > BOUNDS_EPSILON
      ) {
        wall.collider.setHalfExtents({
          x: face.half[0],
          y: face.half[1],
          z: face.half[2],
        })
      }
    }
  }

  /**
   * Fixed-step accumulator. Feeding Rapier raw frame time makes ragdoll joints
   * explode on any hitch — including the first frame after a tab regains focus.
   * `beforeStep` runs once per physics step, which is where muscle-tone torques
   * belong; applying them per rendered frame instead makes stiffness
   * framerate-dependent.
   */
  step(
    dt: number,
    beforeStep?: (stepDt: number) => void,
    onContactForce?: (collider1: number, collider2: number, force: number) => void,
  ): void {
    this.accumulator += Math.min(dt, 0.1)
    let steps = 0

    while (this.accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
      beforeStep?.(STEP)
      this.world.step(this.eventQueue, this.hooks)
      if (onContactForce) {
        this.eventQueue.drainContactForceEvents((event) => {
          onContactForce(
            event.collider1(),
            event.collider2(),
            event.totalForceMagnitude(),
          )
        })
      }
      this.accumulator -= STEP
      steps += 1
    }

    if (steps === MAX_STEPS_PER_FRAME) {
      this.accumulator = 0
    }
  }

  dispose(): void {
    this.walls = []
    this.excludedPairs.clear()
    this.eventQueue.free()
    this.world.free()
  }
}

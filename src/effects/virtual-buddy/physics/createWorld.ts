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

export class PhysicsWorld {
  readonly world: RAPIER.World
  private readonly eventQueue = new RAPIER.EventQueue(true)
  private walls: RAPIER.RigidBody[] = []
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

  /**
   * Rebuilds the invisible cage. Derived from the camera frustum, so this has
   * to be re-run on resize — including when the control panel opens and changes
   * the viewport width.
   */
  setBounds({ halfWidth, halfDepth, ceiling }: Bounds): void {
    for (const wall of this.walls) {
      this.world.removeRigidBody(wall)
    }
    this.walls = []

    const t = WALL_THICKNESS
    const faces: Array<{
      half: [number, number, number]
      at: [number, number, number]
    }> = [
      // floor
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

    for (const face of faces) {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(...face.at),
      )
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(...face.half).setFriction(0.7).setRestitution(0.1),
        body,
      )
      this.walls.push(body)
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

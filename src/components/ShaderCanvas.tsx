import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  VirtualBuddyScene,
  type BuddySnapshot,
} from '../effects/virtual-buddy/VirtualBuddyScene'
import type { VirtualBuddyParams } from '../effects/virtual-buddy/types'
import type { BuddyCommands } from './ModelsSection'

type ShaderCanvasProps = {
  params: VirtualBuddyParams
  resetToken: number
  /** Bumped to drop another buddy on stage (button-driven, not a canvas click). */
  spawnToken: number
  /** Registry index for the next spawn (random character from the stage button). */
  spawnModel: number
  /** Stage + button: apply a random costume hue on spawn. */
  spawnRandomizeHue?: boolean
  viewRef: RefObject<HTMLDivElement | null>
  /** Fires when a hard pull tears the buddy out of its performance, and back. */
  onLimpChange?: (limp: boolean) => void
  /** Current buddy count for badges / stage chrome. */
  onBuddyCountChange?: (count: number) => void
  onBuddiesChange?: (buddies: BuddySnapshot[]) => void
  onBuddyCommands?: (commands: BuddyCommands | null) => void
}

export function ShaderCanvas({
  params,
  resetToken,
  spawnToken,
  spawnModel,
  spawnRandomizeHue = false,
  viewRef,
  onLimpChange,
  onBuddyCountChange,
  onBuddiesChange,
  onBuddyCommands,
}: ShaderCanvasProps) {
  const limpHandler = useRef(onLimpChange)
  limpHandler.current = onLimpChange
  const countHandler = useRef(onBuddyCountChange)
  countHandler.current = onBuddyCountChange
  const buddiesHandler = useRef(onBuddiesChange)
  buddiesHandler.current = onBuddiesChange
  const commandsHandler = useRef(onBuddyCommands)
  commandsHandler.current = onBuddyCommands
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<VirtualBuddyScene | null>(null)
  const paramsRef = useRef(params)
  paramsRef.current = params
  const lastCountRef = useRef(-1)

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [grabbing, setGrabbing] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const view = viewRef.current
    if (!canvas || !view) {
      return
    }

    let cancelled = false
    let frame = 0

    const scene = new VirtualBuddyScene(canvas)
    scene.onLimpChange = (limp) => limpHandler.current?.(limp)
    scene.onBuddiesChange = (buddies) => {
      buddiesHandler.current?.(buddies)
      countHandler.current?.(buddies.length)
    }
    sceneRef.current = scene
    commandsHandler.current?.({
      setMotion: (id, motionIndex) => scene.setBuddyMotion(id, motionIndex),
      setPartColor: (id, partId, color) => scene.setBuddyPartColor(id, partId, color),
      remove: (id) => scene.removeBuddyById(id),
    })

    const resize = () => scene.resize(view.clientWidth, view.clientHeight)
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(view)

    const tick = () => {
      scene.render(paramsRef.current)
      const count = scene.buddyCount
      if (count !== lastCountRef.current) {
        lastCountRef.current = count
        countHandler.current?.(count)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    scene
      .init()
      .then(() => {
        if (!cancelled) {
          setStatus('ready')
          // Initial list after first buddy may already exist mid-frame.
          buddiesHandler.current?.(scene.listBuddies())
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        console.error('Virtual Buddy failed to start', error)
        setStatus('error')
      })

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      commandsHandler.current?.(null)
      scene.dispose()
      sceneRef.current = null
    }
  }, [viewRef])

  useEffect(() => {
    sceneRef.current?.reset()
  }, [resetToken])

  useEffect(() => {
    if (spawnToken === 0) {
      return
    }
    sceneRef.current?.spawnBuddy(spawnModel, {
      randomizeHue: spawnRandomizeHue,
    })
  }, [spawnToken, spawnModel, spawnRandomizeHue])

  const toNdc = (event: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect()
    return [
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ]
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current
    if (!scene) {
      return
    }
    const [x, y] = toNdc(event)
    if (scene.pointerDown(x, y)) {
      event.currentTarget.setPointerCapture(event.pointerId)
      setGrabbing(true)
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!grabbing) {
      return
    }
    const [x, y] = toNdc(event)
    sceneRef.current?.pointerMove(x, y)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!grabbing) {
      return
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    sceneRef.current?.pointerUp()
    setGrabbing(false)
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={`absolute inset-0 block h-full w-full touch-none ${
          grabbing ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        aria-label="Virtual Buddy preview"
      />
      {status !== 'ready' ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">
            {status === 'error'
              ? 'Physics engine failed to load — see console.'
              : 'Starting physics…'}
          </p>
        </div>
      ) : null}
    </>
  )
}

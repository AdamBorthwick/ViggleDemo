import { useEffect, useMemo, useRef, useState } from 'react'
import { ControlPanel } from './components/ControlPanel'
import { HeroTextOverlay } from './components/HeroTextOverlay'
import type { BuddyCommands } from './components/ModelsSection'
import { ShaderCanvas } from './components/ShaderCanvas'
import {
  buildExportCode,
  exportFilename,
} from './effects/virtual-buddy/exportScope'
import { virtualBuddyPreset } from './effects/virtual-buddy/preset'
import { MODELS } from './effects/virtual-buddy/models/registry'
import type { BuddySnapshot } from './effects/virtual-buddy/VirtualBuddyScene'
import {
  buildDefaultParams,
  paramsFromControls,
  valuesFromParams,
} from './presets/types'
import type { VirtualBuddyParams } from './effects/virtual-buddy/types'

const SPAWNABLE_MODELS = MODELS.map((model, index) => ({ model, index })).filter(
  (entry) => Boolean(entry.model.url),
)

/** Stage add-button modes (`showAddButton` select indices). */
const ADD_BUTTON_NONE = 0
const ADD_BUTTON_FOCUSED = 2

/** Intro pop delay + duration — after this, Focused mode docks off-frame. */
const ADD_BUTTON_INTRO_MS = 1650

/** Focused slide-out / slide-in durations (keep in sync with transition classes). */
const ADD_BUTTON_DOCK_OUT_MS = 1100
const ADD_BUTTON_DOCK_IN_MS = 700

/** Pause after a dock motion before another in/out can start. */
const ADD_BUTTON_DOCK_COOLDOWN_MS = 450

/** Stage add control size (`h-14 w-14`) and inset (`left-5` / `bottom-5`). */
const ADD_BUTTON_SIZE_PX = 56
const ADD_BUTTON_INSET_PX = 20

/** Full-height left strip: inset + button width so the resting control sits inside. */
const ADD_BUTTON_HOTSPOT_WIDTH_PX = ADD_BUTTON_INSET_PX + ADD_BUTTON_SIZE_PX

/**
 * Strong anti-repeat pick for the stage + button.
 * 1) Prefer types not on stage at all (uniform among missing).
 * 2) Only once every type is present, allow duplicates — still heavily
 *    weighted against whatever is already most common (1/(count+1)^5).
 */
function pickRandomModelIndex(presentModelIndices: number[]): number {
  if (SPAWNABLE_MODELS.length === 0) {
    return 1
  }

  const counts = new Map<number, number>()
  for (const index of presentModelIndices) {
    counts.set(index, (counts.get(index) ?? 0) + 1)
  }

  const missing = SPAWNABLE_MODELS.filter(({ index }) => (counts.get(index) ?? 0) === 0)
  const pool = missing.length > 0 ? missing : SPAWNABLE_MODELS

  if (missing.length > 0) {
    const pick = pool[Math.floor(Math.random() * pool.length)]!
    return pick.index
  }

  const weights = pool.map(({ index }) => {
    const count = counts.get(index) ?? 0
    return 1 / (count + 1) ** 5
  })
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let roll = Math.random() * total
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i]!
    if (roll <= 0) {
      return pool[i]!.index
    }
  }
  return pool[pool.length - 1]!.index
}

export default function App() {
  const viewRef = useRef<HTMLDivElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const defaults = useMemo(() => buildDefaultParams(virtualBuddyPreset), [])
  const [values, setValues] = useState(() => valuesFromParams(defaults))
  const [resetToken, setResetToken] = useState(0)
  const [spawnToken, setSpawnToken] = useState(0)
  const [spawnModel, setSpawnModel] = useState(0)
  const [spawnRandomizeHue, setSpawnRandomizeHue] = useState(false)
  const [buddies, setBuddies] = useState<BuddySnapshot[]>([])
  const [buddyCommands, setBuddyCommands] = useState<BuddyCommands | null>(null)
  const [controlsOpen, setControlsOpen] = useState(true)
  const [exportScope, setExportScope] = useState(0)
  const [heroTextVisible, setHeroTextVisible] = useState(false)
  const [addLabelVisible, setAddLabelVisible] = useState(false)
  /** Focused mode: true once the button has slid off-frame after its intro. */
  const [addButtonDocked, setAddButtonDocked] = useState(false)
  /** After the slide-out finishes, drop from layout so it cannot intercept. */
  const [addButtonOffscreen, setAddButtonOffscreen] = useState(false)
  /** Panel state to restore when the hero preview is dismissed. */
  const panelBeforeHero = useRef(true)
  const addPointerNearRef = useRef(false)
  const addButtonOffscreenRef = useRef(false)
  const addButtonDockedRef = useRef(false)
  const addDockLockUntilRef = useRef(0)

  const params: VirtualBuddyParams = useMemo(
    () => paramsFromControls(virtualBuddyPreset, values),
    [values],
  )

  /**
   * Previews the marketing composition: hero copy over the live stage with all
   * editor chrome out of the way, so the frame reads as it would when shipped.
   *
   * Authoring-only. The headless export builds render the stage without this
   * overlay or its toggle — see effects/virtual-buddy/exportScope.ts.
   */
  const toggleHeroText = () => {
    setHeroTextVisible((visible) => {
      if (!visible) {
        panelBeforeHero.current = controlsOpen
        setControlsOpen(false)
      } else {
        setControlsOpen(panelBeforeHero.current)
      }
      return !visible
    })
  }

  // Escape is the expected way out of anything that takes over the viewport.
  useEffect(() => {
    if (!heroTextVisible) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHeroTextVisible(false)
        setControlsOpen(panelBeforeHero.current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [heroTextVisible])

  // Reveal the curved hint before the cursor reaches the control itself. Using
  // distance to the button's rectangle keeps the trigger circular enough to
  // feel intentional while still working near the viewport edges.
  // Focused mode (fine pointer + hover only): after the intro pop, slide off to
  // the left until the pointer enters the full-height left strip. Touch / coarse
  // pointers keep the button fixed so Focused always shows on mobile.
  useEffect(() => {
    const mode = Math.round(params.showAddButton)
    if (mode === ADD_BUTTON_NONE) {
      setAddLabelVisible(false)
      setAddButtonDocked(false)
      setAddButtonOffscreen(false)
      addButtonOffscreenRef.current = false
      addButtonDockedRef.current = false
      addDockLockUntilRef.current = 0
      addPointerNearRef.current = false
      return
    }

    setAddButtonDocked(false)
    setAddButtonOffscreen(false)
    addButtonOffscreenRef.current = false
    addButtonDockedRef.current = false
    addDockLockUntilRef.current = 0
    addPointerNearRef.current = false

    const canDock =
      mode === ADD_BUTTON_FOCUSED &&
      typeof window !== 'undefined' &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches

    let introDone = !canDock
    let introTimer = 0
    if (canDock) {
      introTimer = window.setTimeout(() => {
        introDone = true
        if (!addPointerNearRef.current) {
          addButtonDockedRef.current = true
          setAddButtonDocked(true)
          addDockLockUntilRef.current =
            Date.now() + ADD_BUTTON_DOCK_OUT_MS + ADD_BUTTON_DOCK_COOLDOWN_MS
          setAddLabelVisible(false)
        }
      }, ADD_BUTTON_INTRO_MS)
    }

    const isNearHotspot = (event: PointerEvent) => {
      const view = viewRef.current
      if (!view) {
        return false
      }
      const viewRect = view.getBoundingClientRect()
      return (
        event.clientX >= viewRect.left &&
        event.clientX < viewRect.left + ADD_BUTTON_HOTSPOT_WIDTH_PX &&
        event.clientY >= viewRect.top &&
        event.clientY <= viewRect.bottom
      )
    }

    const isNearButton = (event: PointerEvent) => {
      const button = addButtonRef.current
      if (!button) {
        return false
      }
      const rect = button.getBoundingClientRect()
      const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right)
      const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom)
      return Math.hypot(dx, dy) <= 90
    }

    const lockDockMotion = (durationMs: number) => {
      addDockLockUntilRef.current = Date.now() + durationMs + ADD_BUTTON_DOCK_COOLDOWN_MS
    }

    const revealFromOffscreen = () => {
      addButtonOffscreenRef.current = false
      setAddButtonOffscreen(false)
      lockDockMotion(ADD_BUTTON_DOCK_IN_MS)
      // Unhide while still translated left, then slide in on the next frame.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          addButtonDockedRef.current = false
          setAddButtonDocked(false)
        })
      })
    }

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        return
      }
      const near = canDock ? isNearHotspot(event) : isNearButton(event)
      addPointerNearRef.current = near
      if (canDock && introDone && Date.now() >= addDockLockUntilRef.current) {
        if (near && addButtonDockedRef.current) {
          if (addButtonOffscreenRef.current) {
            revealFromOffscreen()
          } else {
            addButtonDockedRef.current = false
            setAddButtonDocked(false)
            lockDockMotion(ADD_BUTTON_DOCK_IN_MS)
          }
        } else if (!near && !addButtonDockedRef.current) {
          addButtonDockedRef.current = true
          setAddButtonDocked(true)
          lockDockMotion(ADD_BUTTON_DOCK_OUT_MS)
        }
      }
      setAddLabelVisible((visible) => (visible === near ? visible : near))
    }
    const hide = () => {
      addPointerNearRef.current = false
      setAddLabelVisible(false)
      if (
        canDock &&
        introDone &&
        Date.now() >= addDockLockUntilRef.current &&
        !addButtonDockedRef.current
      ) {
        addButtonDockedRef.current = true
        setAddButtonDocked(true)
        lockDockMotion(ADD_BUTTON_DOCK_OUT_MS)
      }
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('blur', hide)
    return () => {
      window.clearTimeout(introTimer)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('blur', hide)
    }
  }, [params.showAddButton])

  const handleChange = (key: string, value: number) => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  /** Clear all models; keep slider / effect settings. */
  const handleResetScene = () => {
    setResetToken((token) => token + 1)
  }

  /**
   * Spawn a character. Stage + button passes nothing → random model + hue.
   * Models panel passes a chosen registry index (authored colours). At max
   * capacity the oldest buddy is replaced.
   */
  const handleAddBuddy = (modelIndex?: number) => {
    const fromStageButton = modelIndex === undefined
    setSpawnModel(
      fromStageButton
        ? pickRandomModelIndex(buddies.map((buddy) => buddy.modelIndex))
        : modelIndex,
    )
    setSpawnRandomizeHue(fromStageButton)
    setSpawnToken((token) => token + 1)
  }

  const handleResetSliders = () => {
    setValues(valuesFromParams(defaults))
  }

  const handleExport = () => {
    // Settings module for the matching headless repo (not the full codebase).
    const code = buildExportCode({
      scopeIndex: exportScope,
      presetId: virtualBuddyPreset.id,
      params,
      buddies,
    })
    const blob = new Blob([code], { type: 'text/typescript;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = exportFilename(exportScope, virtualBuddyPreset.id)
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-black">
      {controlsOpen ? (
        <ControlPanel
          preset={virtualBuddyPreset}
          values={values}
          onChange={handleChange}
          onExport={handleExport}
          onResetScene={handleResetScene}
          onResetSliders={handleResetSliders}
          onClose={() => setControlsOpen(false)}
          buddies={buddies}
          buddyCommands={buddyCommands}
          onAddModel={handleAddBuddy}
          exportScope={exportScope}
          onExportScopeChange={setExportScope}
        />
      ) : null}

      <div ref={viewRef} className="relative min-w-0 flex-1 transition-[flex-basis] duration-200 ease-in-out">
        <ShaderCanvas
          params={params}
          resetToken={resetToken}
          spawnToken={spawnToken}
          spawnModel={spawnModel}
          spawnRandomizeHue={spawnRandomizeHue}
          viewRef={viewRef}
          onBuddiesChange={setBuddies}
          onBuddyCommands={setBuddyCommands}
        />

        <HeroTextOverlay visible={heroTextVisible} />

        {!controlsOpen && !heroTextVisible ? (
          <div className="absolute left-4 top-4 z-20">
            <button
              type="button"
              onClick={() => setControlsOpen(true)}
              className="rounded-md border border-white/20 bg-black/50 px-3 py-2 text-sm text-foreground backdrop-blur-md transition-colors hover:bg-black/70"
            >
              Controls
            </button>
          </div>
        ) : null}

        {/*
          Authoring-only hero preview. Stays reachable while the overlay is up
          (Escape also exits) but drops to a ghost treatment so it does not sit
          on top of the composition it exists to show.
        */}
        <div className="absolute right-4 top-4 z-30">
          <button
            type="button"
            onClick={toggleHeroText}
            className={`rounded-md border px-3 py-2 text-sm backdrop-blur-md transition-colors ${
              heroTextVisible
                ? 'border-white/15 bg-black/25 text-white/60 hover:bg-black/50 hover:text-white'
                : 'border-white/20 bg-black/50 text-foreground hover:bg-black/70'
            }`}
          >
            {heroTextVisible ? 'Hide hero text' : 'Show hero text'}
          </button>
        </div>

        {/*
          Full-scene handoff UI surface: add button only.

          It stays put through the hero preview and with the panel closed,
          because it is part of the shipped composition rather than editor
          chrome — the hero frame should show the affordance a visitor gets.
          Interaction → Add button: Fixed / None / Focused.
        */}
        {Math.round(params.showAddButton) !== ADD_BUTTON_NONE ? (
          <div
            onTransitionEnd={(event) => {
              if (event.propertyName !== 'transform') {
                return
              }
              if (addButtonDocked) {
                addButtonOffscreenRef.current = true
                setAddButtonOffscreen(true)
              }
            }}
            className={`absolute bottom-5 left-5 z-[5] transition-transform ${
              addButtonDocked
                ? 'pointer-events-none -translate-x-[calc(100%+5.5rem)] duration-[1100ms] ease'
                : 'translate-x-0 duration-700 ease-out'
            } ${addButtonOffscreen ? 'hidden' : ''}`}
          >
            <div
              key={Math.round(params.showAddButton)}
              className="relative h-14 w-14 animate-add-buddy-in"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 100 100"
                className={`pointer-events-none absolute -left-[22px] -top-8 h-[100px] w-[100px] overflow-visible transition-opacity duration-200 ${
                  addLabelVisible ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <defs>
                  <path
                    id="add-model-label-arc"
                    d="M 10 60 A 40 40 0 0 1 90 60"
                  />
                </defs>
                <text className="fill-white/75 text-[8px] font-medium uppercase tracking-[0.22em]">
                  <textPath
                    href="#add-model-label-arc"
                    startOffset="50%"
                    textAnchor="middle"
                  >
                    Add model
                  </textPath>
                </text>
              </svg>
              <button
                ref={addButtonRef}
                type="button"
                onClick={() => handleAddBuddy()}
                onFocus={() => {
                  setAddLabelVisible(true)
                  if (Math.round(params.showAddButton) === ADD_BUTTON_FOCUSED) {
                    addButtonOffscreenRef.current = false
                    addButtonDockedRef.current = false
                    addDockLockUntilRef.current =
                      Date.now() + ADD_BUTTON_DOCK_IN_MS + ADD_BUTTON_DOCK_COOLDOWN_MS
                    setAddButtonOffscreen(false)
                    setAddButtonDocked(false)
                  }
                }}
                onBlur={() => setAddLabelVisible(false)}
                aria-label="Add model"
                tabIndex={addButtonDocked ? -1 : 0}
                className="group relative flex h-14 w-14 origin-center items-center justify-center rounded-full border border-white/25 bg-primary text-primary-foreground shadow-[0_8px_28px_rgba(0,224,90,0.35)] outline-none transition-transform duration-200 ease-out hover:scale-105 active:scale-95 focus-visible:ring-2 focus-visible:ring-primary/80"
              >
                <span
                  aria-hidden
                  className="flex h-8 w-8 items-center justify-center text-[2rem] font-light leading-none"
                >
                  +
                </span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

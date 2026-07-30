import { useMemo, useRef, useState } from 'react'
import { ControlPanel } from './components/ControlPanel'
import { HeroTextOverlay } from './components/HeroTextOverlay'
import type { BuddyCommands } from './components/ModelsSection'
import { ShaderCanvas } from './components/ShaderCanvas'
import { virtualBuddyPreset } from './effects/virtual-buddy/preset'
import { MODELS } from './effects/virtual-buddy/models/registry'
import type { BuddySnapshot } from './effects/virtual-buddy/VirtualBuddyScene'
import {
  buildDefaultParams,
  paramsFromControls,
  valuesFromParams,
} from './presets/types'
import type { VirtualBuddyParams } from './effects/virtual-buddy/types'

/** Character models only (skip Capsules debug option). */
const SPAWNABLE_MODELS = MODELS.map((model, index) => ({ model, index })).filter(
  (entry) => Boolean(entry.model.url),
)

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
  const defaults = useMemo(() => buildDefaultParams(virtualBuddyPreset), [])
  const [values, setValues] = useState(() => valuesFromParams(defaults))
  const [resetToken, setResetToken] = useState(0)
  const [spawnToken, setSpawnToken] = useState(0)
  const [spawnModel, setSpawnModel] = useState(1)
  const [spawnRandomizeHue, setSpawnRandomizeHue] = useState(false)
  const [buddyCount, setBuddyCount] = useState(0)
  const [buddies, setBuddies] = useState<BuddySnapshot[]>([])
  const [buddyCommands, setBuddyCommands] = useState<BuddyCommands | null>(null)
  const [controlsOpen, setControlsOpen] = useState(true)
  const [heroTextVisible, setHeroTextVisible] = useState(false)
  const params: VirtualBuddyParams = useMemo(
    () => paramsFromControls(virtualBuddyPreset, values),
    [values],
  )

  const maxBuddies = Math.max(1, Math.round(params.maxBuddies))

  const handleChange = (key: string, value: number) => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  const handleRespawn = () => {
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
    const payload = {
      version: 1,
      preset: virtualBuddyPreset.id,
      settings: params,
      buddies,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${virtualBuddyPreset.id}-settings.json`
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
          onRespawn={handleRespawn}
          onResetSliders={handleResetSliders}
          onClose={() => setControlsOpen(false)}
          buddies={buddies}
          buddyCommands={buddyCommands}
          onAddModel={handleAddBuddy}
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
          onBuddyCountChange={setBuddyCount}
          onBuddiesChange={setBuddies}
          onBuddyCommands={setBuddyCommands}
        />

        <HeroTextOverlay visible={heroTextVisible} />

        {!controlsOpen ? (
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

        <div className="absolute right-4 top-4 z-20 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setHeroTextVisible((visible) => !visible)}
            className="inline-flex items-center gap-2 rounded-md border border-white/20 bg-black/50 px-3 py-2 text-sm text-foreground backdrop-blur-md transition-colors hover:bg-black/70"
          >
            {heroTextVisible ? (
              <>
                Hide hero text
                <span aria-hidden="true" className="text-base leading-none">
                  ×
                </span>
              </>
            ) : (
              'Show hero text'
            )}
          </button>
        </div>

        <div className="absolute bottom-5 left-5 z-20">
          <button
            type="button"
            onClick={() => handleAddBuddy()}
            aria-label="Add buddy"
            title={
              buddyCount >= maxBuddies
                ? 'Stage full — oldest buddy will be replaced'
                : 'Add a random buddy'
            }
            className="group flex h-14 w-14 origin-center items-center justify-center rounded-full border border-white/25 bg-primary text-primary-foreground shadow-[0_8px_28px_rgba(0,224,90,0.35)] outline-none transition-transform duration-200 ease-out animate-add-buddy-in hover:scale-105 active:scale-95 focus-visible:ring-2 focus-visible:ring-primary/80"
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
    </div>
  )
}

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

export default function App() {
  const viewRef = useRef<HTMLDivElement>(null)
  const defaults = useMemo(() => buildDefaultParams(virtualBuddyPreset), [])
  const [values, setValues] = useState(() => valuesFromParams(defaults))
  const [resetToken, setResetToken] = useState(0)
  const [spawnToken, setSpawnToken] = useState(0)
  const [spawnModel, setSpawnModel] = useState(1)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
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
  const canAddBuddy = buddyCount < maxBuddies

  const handleChange = (key: string, value: number) => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  const handleRespawn = () => {
    setResetToken((token) => token + 1)
  }

  const handleAddBuddy = (modelIndex: number) => {
    if (!canAddBuddy) {
      return
    }
    setSpawnModel(modelIndex)
    setSpawnToken((token) => token + 1)
    setAddMenuOpen(false)
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
        />
      ) : null}

      <div ref={viewRef} className="relative min-w-0 flex-1 transition-[flex-basis] duration-200 ease-in-out">
        <ShaderCanvas
          params={params}
          resetToken={resetToken}
          spawnToken={spawnToken}
          spawnModel={spawnModel}
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
            className="rounded-md border border-white/20 bg-black/50 px-3 py-2 text-sm text-foreground backdrop-blur-md transition-colors hover:bg-black/70"
          >
            {heroTextVisible ? 'Hide hero text' : 'Show hero text'}
          </button>
        </div>

        <div className="absolute bottom-4 left-4 z-20">
          {addMenuOpen && canAddBuddy ? (
            <div className="mb-2 min-w-44 overflow-hidden rounded-md border border-white/20 bg-black/75 p-1 text-sm text-foreground shadow-xl backdrop-blur-md">
              {MODELS.map((model, index) =>
                model.url ? (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => handleAddBuddy(index)}
                    className="block w-full rounded px-3 py-2 text-left transition-colors hover:bg-white/15"
                  >
                    {model.label}
                  </button>
                ) : null,
              )}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setAddMenuOpen((open) => !open)}
            disabled={!canAddBuddy}
            aria-expanded={addMenuOpen}
            aria-haspopup="menu"
            className="rounded-md border border-white/20 bg-black/55 px-4 py-2 text-sm text-foreground backdrop-blur-md transition-colors hover:bg-black/75 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add buddy
            <span className="ml-2 text-muted-foreground">
              {buddyCount}/{maxBuddies}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

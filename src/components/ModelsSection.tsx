import { useState } from 'react'
import type { BuddySnapshot } from '../effects/virtual-buddy/VirtualBuddyScene'
import { MODELS, MOTIONS } from '../effects/virtual-buddy/models/registry'
import { ColorControl } from './ColorControl'
import { SelectControl } from './SelectControl'
import { SliderControl } from './SliderControl'
import { hexToCss } from '../presets/types'
import type {
  ColorControlDef,
  SelectControlDef,
  SliderControlDef,
} from '../presets/types'

export type BuddyCommands = {
  setMotion: (id: number, motionIndex: number) => void
  setPartColor: (id: number, partId: string, color: number) => void
  remove: (id: number) => void
}

/** Character models only (skip Capsules debug mesh). */
const SPAWNABLE = MODELS.map((model, index) => ({ model, index })).filter(
  (entry) => Boolean(entry.model.url),
)

type ModelsSectionProps = {
  buddies: BuddySnapshot[]
  commands: BuddyCommands | null
  onAddModel?: (modelIndex: number) => void
  maxBuddies: number
  onMaxBuddiesChange: (value: number) => void
}

/**
 * Per-instance buddy editor: open a row to retint costume parts, pick an
 * animation, or delete the character. Cap + add (with model picker) at the bottom.
 */
export function ModelsSection({
  buddies,
  commands,
  onAddModel,
  maxBuddies,
  onMaxBuddiesChange,
}: ModelsSectionProps) {
  const [openId, setOpenId] = useState<number | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)

  return (
    <div className="space-y-4">
      <SliderControl
        control={maxBuddiesControlDef}
        value={maxBuddies}
        onChange={onMaxBuddiesChange}
      />

      {buddies.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">
          No models on stage. Add one to get started.
        </p>
      ) : (
        <div className="space-y-1">
          {buddies.map((buddy, order) => {
            const open = openId === buddy.id

            return (
              <div
                key={buddy.id}
                className="overflow-hidden rounded-md border border-border bg-secondary/40"
              >
                <div className="flex w-full items-stretch">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : buddy.id)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-accent/60"
                  >
                    <span
                      aria-hidden
                      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center text-[9px] text-muted-foreground transition-transform ${
                        open ? 'rotate-0' : '-rotate-90'
                      }`}
                    >
                      ▼
                    </span>
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border"
                      style={{ backgroundColor: hexToCss(buddy.color) }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {buddy.label}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        #{order + 1}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      commands?.remove(buddy.id)
                      if (openId === buddy.id) {
                        setOpenId(null)
                      }
                    }}
                    className="shrink-0 border-l border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    Delete
                  </button>
                </div>

                {open ? (
                  <div className="space-y-4 border-t border-border px-2.5 py-3">
                    <SelectControl
                      control={motionSelectDef}
                      value={buddy.motionIndex}
                      onChange={(value) => commands?.setMotion(buddy.id, value)}
                    />

                    {buddy.parts.length > 0 ? (
                      <div className="space-y-3">
                        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                          Color
                        </p>
                        {buddy.parts.map((part) => (
                          <ColorControl
                            key={part.id}
                            control={{
                              kind: 'color',
                              key: `buddy-${buddy.id}-${part.id}`,
                              label: part.label,
                              defaultValue: part.defaultColor,
                            }}
                            value={part.color}
                            onChange={(value) =>
                              commands?.setPartColor(buddy.id, part.id, value)
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <ColorControl
                        control={{
                          ...colorControlDef,
                          defaultValue: buddy.defaultColor,
                        }}
                        value={buddy.color}
                        onChange={(value) =>
                          commands?.setPartColor(buddy.id, 'color', value)
                        }
                      />
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <div className="space-y-1">
        {addMenuOpen ? (
          <div
            role="menu"
            aria-label="Choose model"
            className="overflow-hidden rounded-md border border-border bg-secondary p-1"
          >
            {SPAWNABLE.map(({ model, index }) => (
              <button
                key={model.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onAddModel?.(index)
                  setAddMenuOpen(false)
                }}
                className="block w-full rounded-[max(0px,calc(var(--radius-md)-0.25rem))] px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                {model.label}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setAddMenuOpen((open) => !open)}
          aria-expanded={addMenuOpen}
          aria-haspopup="menu"
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
        >
          <span
            aria-hidden
            className="inline-flex h-4 w-4 items-center justify-center text-base font-light leading-none"
          >
            {addMenuOpen ? '×' : '+'}
          </span>
          {addMenuOpen ? 'Cancel' : 'Add model'}
        </button>
      </div>
    </div>
  )
}

const autoMotionIndex = Math.max(
  0,
  MOTIONS.findIndex((entry) => entry.auto),
)

const motionSelectDef: SelectControlDef = {
  kind: 'select',
  key: 'buddy-motion',
  label: 'Animation',
  options: MOTIONS.map((entry) => entry.label),
  defaultValue: autoMotionIndex || 1,
}

const colorControlDef: ColorControlDef = {
  kind: 'color',
  key: 'buddy-color',
  label: 'Color',
  defaultValue: 0xffffff,
}

const maxBuddiesControlDef: SliderControlDef = {
  kind: 'slider',
  key: 'maxBuddies',
  label: 'Max models',
  min: 1,
  max: 8,
  step: 1,
  defaultValue: 3,
}

import { useState } from 'react'
import type { BuddySnapshot } from '../effects/virtual-buddy/VirtualBuddyScene'
import { MOTIONS } from '../effects/virtual-buddy/models/registry'
import { ColorControl } from './ColorControl'
import { SelectControl } from './SelectControl'
import { hexToCss } from '../presets/types'
import type { ColorControlDef, SelectControlDef } from '../presets/types'

export type BuddyCommands = {
  setMotion: (id: number, motionIndex: number) => void
  setColor: (id: number, color: number) => void
  remove: (id: number) => void
}

type ModelsSectionProps = {
  buddies: BuddySnapshot[]
  commands: BuddyCommands | null
}

/**
 * Per-instance buddy editor: open a row to retint, pick an animation, or remove.
 */
export function ModelsSection({ buddies, commands }: ModelsSectionProps) {
  const [openId, setOpenId] = useState<number | null>(null)

  if (buddies.length === 0) {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        No buddies on stage. Use Add buddy to drop one in.
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {buddies.map((buddy, order) => {
        const open = openId === buddy.id
        const motionLabel =
          MOTIONS[buddy.motionIndex]?.label ?? MOTIONS[0]?.label ?? 'Ragdoll'

        return (
          <div
            key={buddy.id}
            className="rounded-md border border-border bg-secondary/40"
          >
            <button
              type="button"
              onClick={() => setOpenId(open ? null : buddy.id)}
              aria-expanded={open}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-accent/60"
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
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {motionLabel}
              </span>
            </button>

            {open ? (
              <div className="space-y-4 border-t border-border px-2.5 py-3">
                <SelectControl
                  control={motionSelectDef}
                  value={buddy.motionIndex}
                  onChange={(value) => commands?.setMotion(buddy.id, value)}
                />
                <ColorControl
                  control={{
                    ...colorControlDef,
                    defaultValue: buddy.defaultColor,
                  }}
                  value={buddy.color}
                  onChange={(value) => commands?.setColor(buddy.id, value)}
                />
                <button
                  type="button"
                  onClick={() => {
                    commands?.remove(buddy.id)
                    setOpenId(null)
                  }}
                  className="w-full rounded-md border border-border bg-secondary px-3 py-2 text-xs text-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                >
                  Delete model
                </button>
              </div>
            ) : null}
          </div>
        )
      })}
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

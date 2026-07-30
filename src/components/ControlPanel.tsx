import { ControlSection } from './ControlSection'
import { CheckboxControl } from './CheckboxControl'
import { ColorControl } from './ColorControl'
import { ModelsSection, type BuddyCommands } from './ModelsSection'
import { SelectControl } from './SelectControl'
import { SliderControl } from './SliderControl'
import type { BuddySnapshot } from '../effects/virtual-buddy/VirtualBuddyScene'
import {
  isControlVisible,
  type ControlDef,
  type PresetDefinition,
} from '../presets/types'

type ControlPanelProps<TParams extends Record<string, number>> = {
  preset: PresetDefinition<TParams>
  values: Record<string, number>
  onChange: (key: string, value: number) => void
  onExport: () => void
  onRespawn: () => void
  onResetSliders: () => void
  onClose: () => void
  buddies: BuddySnapshot[]
  buddyCommands: BuddyCommands | null
}

function renderControl(
  control: ControlDef,
  values: Record<string, number>,
  onChange: (key: string, value: number) => void,
) {
  if (control.kind === 'slider') {
    return (
      <SliderControl
        key={control.key}
        control={control}
        value={values[control.key] ?? control.defaultValue}
        onChange={(value) => onChange(control.key, value)}
      />
    )
  }
  if (control.kind === 'checkbox') {
    return (
      <CheckboxControl
        key={control.key}
        control={control}
        value={values[control.key] ?? control.defaultValue}
        onChange={(value) => onChange(control.key, value)}
      />
    )
  }
  if (control.kind === 'select') {
    return (
      <SelectControl
        key={control.key}
        control={control}
        value={values[control.key] ?? control.defaultValue}
        onChange={(value) => onChange(control.key, value)}
      />
    )
  }
  if (control.kind === 'color') {
    return (
      <ColorControl
        key={control.key}
        control={control}
        value={values[control.key] ?? control.defaultValue}
        onChange={(value) => onChange(control.key, value)}
      />
    )
  }
  if (control.kind === 'heading') {
    return (
      <div
        key={control.key}
        className="border-t border-border pt-4 first:border-t-0 first:pt-0"
      >
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {control.label}
        </p>
        {control.description ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
            {control.description}
          </p>
        ) : null}
      </div>
    )
  }
  return null
}

export function ControlPanel<TParams extends Record<string, number>>({
  preset,
  values,
  onChange,
  onExport,
  onRespawn,
  onResetSliders,
  onClose,
  buddies,
  buddyCommands,
}: ControlPanelProps<TParams>) {
  return (
    <aside className="z-20 flex h-full w-[min(100%,340px)] shrink-0 flex-col overflow-hidden border-r border-border bg-card/95 backdrop-blur-md">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Preset</p>
            <h2 className="mt-1 text-lg font-medium tracking-tight text-foreground">
              {preset.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide controls"
            className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Hide
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{preset.tagline}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-2">
        <ControlSection
          title="Models"
          defaultOpen={false}
          badge={String(buddies.length)}
        >
          <ModelsSection buddies={buddies} commands={buddyCommands} />
        </ControlSection>

        {preset.sections.map((section) => {
          if (!isControlVisible(section.visibleWhen, values)) {
            return null
          }

          const controls = section.controls.filter((control) =>
            isControlVisible(control.visibleWhen, values),
          )
          if (controls.length === 0) {
            return null
          }

          return (
            <ControlSection
              key={section.id}
              title={section.title}
              description={section.description}
              defaultOpen={section.defaultOpen ?? false}
              badge={section.badge}
            >
              {controls.map((control) => renderControl(control, values, onChange))}
            </ControlSection>
          )
        })}
      </div>

      <div className="space-y-2 border-t border-border px-5 py-4">
        <button
          type="button"
          onClick={onRespawn}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
        >
          Respawn buddy
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onResetSliders}
            className="rounded-md border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
          >
            Reset sliders
          </button>
          <button
            type="button"
            onClick={onExport}
            className="rounded-md border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
          >
            Export
          </button>
        </div>
      </div>
    </aside>
  )
}

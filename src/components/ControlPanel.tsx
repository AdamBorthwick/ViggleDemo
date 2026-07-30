import { ControlSection } from './ControlSection'
import { CheckboxControl } from './CheckboxControl'
import { ColorControl } from './ColorControl'
import { ModelsSection, type BuddyCommands } from './ModelsSection'
import { SelectControl } from './SelectControl'
import { SliderControl } from './SliderControl'
import { FILTER_OPTIONS } from '../effects/virtual-buddy/filters/FilterStack'
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
  onAddModel?: () => void
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
  onAddModel,
}: ControlPanelProps<TParams>) {
  return (
    <aside className="z-20 flex h-full w-[min(100%,340px)] shrink-0 flex-col overflow-hidden border-r border-border bg-card/95 backdrop-blur-md">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="text-lg font-medium tracking-tight text-foreground">
          {preset.name}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Hide controls"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
        >
          Hide controls
          <span aria-hidden="true" className="text-base leading-none">
            ×
          </span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <ControlSection
          title="Models"
          defaultOpen={false}
          badge={String(buddies.length)}
        >
          <ModelsSection
            buddies={buddies}
            commands={buddyCommands}
            onAddModel={onAddModel}
            maxBuddies={Math.max(1, Math.round(values.maxBuddies ?? 3))}
            onMaxBuddiesChange={(value) => onChange('maxBuddies', value)}
          />
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

          const isEffects = section.id === 'effects'
          const filterIndex = Math.round(values.filter ?? 0)
          const filterLabel =
            FILTER_OPTIONS[filterIndex] ?? FILTER_OPTIONS[0] ?? 'Off'

          return (
            <ControlSection
              key={section.id}
              title={section.title}
              description={section.description}
              defaultOpen={section.defaultOpen ?? false}
              badge={isEffects ? filterLabel : section.badge}
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

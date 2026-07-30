import { useEffect, useRef, useState } from 'react'
import { ControlSection } from './ControlSection'
import { CheckboxControl } from './CheckboxControl'
import { ColorControl } from './ColorControl'
import { ModelsSection, type BuddyCommands } from './ModelsSection'
import { SelectControl } from './SelectControl'
import { SliderControl } from './SliderControl'
import {
  EXPORT_SCOPE_OPTIONS,
  EXPORT_SETTINGS_TARGET_PATH,
  repoBlurbForScope,
  repoUrlForScope,
} from '../effects/virtual-buddy/exportScope'
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
  onResetScene: () => void
  onResetSliders: () => void
  onClose: () => void
  buddies: BuddySnapshot[]
  buddyCommands: BuddyCommands | null
  onAddModel?: (modelIndex: number) => void
  exportScope: number
  onExportScopeChange: (scope: number) => void
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

function ExportMenu({
  exportScope,
  onExportScopeChange,
  onExport,
}: {
  exportScope: number
  onExportScopeChange: (scope: number) => void
  onExport: () => void
}) {
  const selected = Math.round(exportScope)
  const scopeLabel = EXPORT_SCOPE_OPTIONS[selected] ?? EXPORT_SCOPE_OPTIONS[0]
  const repoLabel =
    selected === 1 ? 'Download Effects repo' : 'Download Full scene repo'

  return (
    <div className="space-y-2.5 rounded-md border border-border bg-secondary p-3">
      <p className="text-sm font-medium leading-none text-foreground">Export</p>

      <div className="space-y-1.5">
        <p className="text-xs leading-snug text-muted-foreground">
          <span className="font-medium text-foreground">1.</span> Choose a build
          and download the repo
        </p>
        <div
          role="radiogroup"
          aria-label="Export scope"
          className="flex gap-1 rounded-md border border-border bg-card p-1"
        >
          {EXPORT_SCOPE_OPTIONS.map((option, index) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={index === selected}
              onClick={() => onExportScopeChange(index)}
              className={`flex-1 rounded-[max(0px,calc(var(--radius-md)-0.25rem))] px-2 py-1.5 text-xs transition-colors ${
                index === selected
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {repoBlurbForScope(selected)}
        </p>
        <a
          href={repoUrlForScope(selected)}
          target="_blank"
          rel="noreferrer"
          className="flex w-full items-center justify-center rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
        >
          {repoLabel}
        </a>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs leading-snug text-muted-foreground">
          <span className="font-medium text-foreground">2.</span> Download your{' '}
          {scopeLabel.toLowerCase()} settings
        </p>
        <button
          type="button"
          onClick={onExport}
          className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
        >
          Download settings
        </button>
      </div>

      <div className="space-y-1">
        <p className="text-xs leading-snug text-muted-foreground">
          <span className="font-medium text-foreground">3.</span> In the cloned
          repo, replace{' '}
          <code className="rounded bg-card px-1 py-0.5 text-[11px] text-foreground">
            {EXPORT_SETTINGS_TARGET_PATH}
          </code>{' '}
          with the file you downloaded.
        </p>
      </div>
    </div>
  )
}

export function ControlPanel<TParams extends Record<string, number>>({
  preset,
  values,
  onChange,
  onExport,
  onResetScene,
  onResetSliders,
  onClose,
  buddies,
  buddyCommands,
  onAddModel,
  exportScope,
  onExportScopeChange,
}: ControlPanelProps<TParams>) {
  const [exportOpen, setExportOpen] = useState(false)
  const exportSectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!exportOpen) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (exportSectionRef.current?.contains(target)) {
        return
      }
      setExportOpen(false)
    }
    // Capture so we close even if something stops bubbling.
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [exportOpen])

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

      <div className="space-y-3 border-t border-border px-5 py-4">
        <button
          type="button"
          onClick={onResetScene}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
        >
          Reset scene
        </button>

        <div ref={exportSectionRef} className="space-y-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onResetSliders}
              className="min-w-0 flex-1 rounded-md border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
            >
              Reset sliders
            </button>
            <button
              type="button"
              onClick={() => setExportOpen((open) => !open)}
              aria-expanded={exportOpen}
              aria-label={exportOpen ? 'Close export' : 'Export'}
              className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-2 text-sm leading-none text-foreground transition-colors hover:bg-accent"
            >
              <span className="leading-none">Export</span>
              {exportOpen ? (
                <span
                  aria-hidden
                  className="inline-flex size-[1em] items-center justify-center text-[1.1em] leading-none text-muted-foreground"
                >
                  ×
                </span>
              ) : null}
            </button>
          </div>

          {exportOpen ? (
            <ExportMenu
              exportScope={exportScope}
              onExportScopeChange={onExportScopeChange}
              onExport={onExport}
            />
          ) : null}
        </div>
      </div>
    </aside>
  )
}

import { useEffect, useState } from 'react'
import type { SliderControlDef } from '../presets/types'

type SliderControlProps = {
  control: SliderControlDef
  value: number
  onChange: (value: number) => void
}

/**
 * Range slider with a typed numeric field and a per-control reset beside the
 * title when the value differs from the designer default.
 */
export function SliderControl({ control, value, onChange }: SliderControlProps) {
  const [draft, setDraft] = useState(() => formatValue(value, control.step))
  const isDefault = nearlyEqual(value, control.defaultValue, control.step)

  useEffect(() => {
    setDraft(formatValue(value, control.step))
  }, [value, control.step])

  const commitDraft = () => {
    const parsed = Number.parseFloat(draft.trim())
    if (!Number.isFinite(parsed)) {
      setDraft(formatValue(value, control.step))
      return
    }
    onChange(clampToStep(parsed, control.min, control.max, control.step))
  }

  return (
    <div className="group block space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-sm leading-none text-foreground">{control.label}</span>
          {!isDefault ? (
            <button
              type="button"
              onClick={() => onChange(control.defaultValue)}
              title={`Reset to ${formatValue(control.defaultValue, control.step)}`}
              aria-label={`Reset ${control.label} to default`}
              className="rounded px-1 text-[10px] uppercase leading-none tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Reset
            </button>
          ) : null}
        </div>
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${control.label} value`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitDraft()
              ;(event.target as HTMLInputElement).blur()
            }
            if (event.key === 'Escape') {
              setDraft(formatValue(value, control.step))
              ;(event.target as HTMLInputElement).blur()
            }
          }}
          className="box-border w-11 shrink-0 rounded border border-transparent bg-transparent py-0.5 pl-1 pr-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums outline-none transition-[width,padding,margin,color,background-color,border-color,box-shadow] hover:-mr-0.5 hover:w-[calc(2.75rem+2px)] hover:border-border hover:bg-secondary/60 hover:pr-0.5 focus:-mr-0.5 focus:w-[calc(2.75rem+2px)] focus:border-border focus:bg-secondary focus:pr-0.5 focus:text-foreground focus:ring-1 focus:ring-ring/30"
        />
      </div>
      {control.description ? (
        <p className="text-[11px] leading-snug text-muted-foreground">{control.description}</p>
      ) : null}
      <div
        className="flex flex-col"
        style={{ gap: control.lowLabel || control.highLabel ? 2 : 0 }}
      >
        {control.lowLabel || control.highLabel ? (
          <div className="flex justify-between gap-2 text-[9px] leading-none tracking-normal text-muted-foreground/55">
            <span>{control.lowLabel ?? ''}</span>
            <span className="text-right">{control.highLabel ?? ''}</span>
          </div>
        ) : null}
        <input
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="control-slider h-3 w-full cursor-pointer appearance-none bg-transparent"
        />
      </div>
    </div>
  )
}

function formatValue(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3
  return value.toFixed(decimals)
}

function nearlyEqual(a: number, b: number, step: number): boolean {
  const eps = Math.max(step * 0.5, 1e-6)
  return Math.abs(a - b) <= eps
}

function clampToStep(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value))
  if (step <= 0) {
    return clamped
  }
  const steps = Math.round((clamped - min) / step)
  const snapped = min + steps * step
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals))
}

import type { CheckboxControlDef } from '../presets/types'

type CheckboxControlProps = {
  control: CheckboxControlDef
  value: number
  onChange: (value: number) => void
}

/**
 * Circular toggle styled like the rest of the panel (secondary surface +
 * primary fill) — no native white checkbox chrome.
 */
export function CheckboxControl({ control, value, onChange }: CheckboxControlProps) {
  const checked = value >= 0.5

  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm text-foreground">{control.label}</span>
        {control.description ? (
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {control.description}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={control.label}
        onClick={() => onChange(checked ? 0 : 1)}
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
          checked
            ? 'border-primary bg-primary'
            : 'border-border bg-secondary hover:border-primary/50'
        }`}
      >
        {checked ? (
          <span aria-hidden className="size-1.5 rounded-full bg-primary-foreground" />
        ) : null}
      </button>
    </label>
  )
}

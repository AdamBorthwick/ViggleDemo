import type { SelectControlDef } from '../presets/types'

type SelectControlProps = {
  control: SelectControlDef
  value: number
  onChange: (value: number) => void
}

/**
 * Segmented buttons rather than a dropdown. With two or three options the
 * choices stay visible without a tour.
 */
export function SelectControl({ control, value, onChange }: SelectControlProps) {
  const selected = Math.round(value)
  const isDefault = selected === Math.round(control.defaultValue)

  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-sm text-foreground">{control.label}</span>
        {!isDefault ? (
          <button
            type="button"
            onClick={() => onChange(control.defaultValue)}
            title="Reset to default"
            aria-label={`Reset ${control.label} to default`}
            className="rounded px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Reset
          </button>
        ) : null}
      </div>
      {control.description ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{control.description}</p>
      ) : null}
      <div
        role="radiogroup"
        aria-label={control.label}
        className={`gap-1 rounded-md border border-border bg-secondary p-1 ${
          control.options.length > 3 ? 'grid grid-cols-2' : 'flex'
        }`}
      >
        {control.options.map((option, index) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={index === selected}
            onClick={() => onChange(index)}
            className={`rounded px-2 py-1.5 text-xs transition-colors ${
              control.options.length <= 3 ? 'flex-1' : ''
            } ${
              index === selected
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  )
}

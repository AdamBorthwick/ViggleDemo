import type { CheckboxControlDef } from '../presets/types'

type CheckboxControlProps = {
  control: CheckboxControlDef
  value: number
  onChange: (value: number) => void
}

export function CheckboxControl({ control, value, onChange }: CheckboxControlProps) {
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
      <input
        type="checkbox"
        checked={value >= 0.5}
        onChange={(event) => onChange(event.target.checked ? 1 : 0)}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
      />
    </label>
  )
}

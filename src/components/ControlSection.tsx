import { useId, useState, type ReactNode } from 'react'

type ControlSectionProps = {
  title: string
  description?: string
  /** Starts expanded. Defaults to true. */
  defaultOpen?: boolean
  /** Optional badge on the header (e.g. active look name). */
  badge?: string
  children: ReactNode
}

/**
 * Collapsible major category. Header is the only always-visible chrome so the
 * panel can carry many knobs without forcing a long scroll. Starts closed.
 */
export function ControlSection({
  title,
  description,
  defaultOpen = false,
  badge,
  children,
}: ControlSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  return (
    <section className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 py-3 text-left transition-colors hover:text-foreground"
      >
        <span
          aria-hidden
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-secondary text-[10px] text-muted-foreground transition-transform ${
            open ? 'rotate-0' : '-rotate-90'
          }`}
        >
          ▼
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium tracking-tight text-foreground">
          {title}
        </span>
        {badge ? (
          <span className="ml-auto shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums tracking-wide text-primary">
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div id={panelId} className="space-y-5 pb-5">
          {description ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
          {children}
        </div>
      ) : null}
    </section>
  )
}

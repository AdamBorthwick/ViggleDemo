import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  hexToCss,
  hexToRgb255,
  hsvToRgb,
  parseCssColor,
  rgb255ToHex,
  rgbToHsv,
  type ColorControlDef,
} from '../presets/types'

type ColorControlProps = {
  control: ColorControlDef
  value: number
  onChange: (value: number) => void
}

type PanelPlacement = {
  top: number
  left: number
  width: number
}

/**
 * Compact themed colour control. The popover is portaled to document.body so
 * overflow:hidden ancestors (model cards, scroll areas) cannot clip it.
 */
export function ColorControl({ control, value, onChange }: ColorControlProps) {
  const css = hexToCss(value)
  const rgb = hexToRgb255(value)
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)

  const [open, setOpen] = useState(false)
  const [hexDraft, setHexDraft] = useState(css)
  const [placement, setPlacement] = useState<PanelPlacement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    setHexDraft(hexToCss(value))
  }, [value])

  const updatePlacement = useCallback(() => {
    const anchor = rootRef.current
    if (!anchor) {
      return
    }
    const rect = anchor.getBoundingClientRect()
    const width = Math.min(280, Math.max(rect.width, 200))
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - width - 8,
    )
    // Prefer opening below; flip above if there is not enough room.
    const panelHeight = panelRef.current?.offsetHeight ?? 200
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const openAbove = spaceBelow < panelHeight && rect.top > spaceBelow
    const top = openAbove
      ? Math.max(8, rect.top - panelHeight - 6)
      : Math.min(window.innerHeight - panelHeight - 8, rect.bottom + 6)
    setPlacement({ top, left, width })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    updatePlacement()
    // Second pass after paint so measured panel height is accurate for flip.
    const frame = window.requestAnimationFrame(updatePlacement)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open, updatePlacement])

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return
      }
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const commitHex = useCallback(
    (raw: string) => {
      const parsed = parseCssColor(raw)
      if (parsed === null) {
        setHexDraft(hexToCss(value))
        return
      }
      onChange(parsed)
      setHexDraft(hexToCss(parsed))
    },
    [onChange, value],
  )

  const setFromHsv = useCallback(
    (h: number, s: number, v: number) => {
      const next = hsvToRgb(h, s, v)
      onChange(rgb255ToHex(next.r, next.g, next.b))
    },
    [onChange],
  )

  const isDefault = value === (control.defaultValue >>> 0)

  const panel =
    open && placement
      ? createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={`${control.label} colour picker`}
            className="fixed z-[200] space-y-2 rounded-md border border-border bg-card p-2.5 shadow-xl"
            style={{
              top: placement.top,
              left: placement.left,
              width: placement.width,
            }}
          >
            <HueSlider hue={hsv.h} onChange={(h) => setFromHsv(h, hsv.s, hsv.v)} />

            <SaturationValuePad
              hue={hsv.h}
              saturation={hsv.s}
              value={hsv.v}
              onChange={(s, v) => setFromHsv(hsv.h, s, v)}
            />

            <div className="flex items-center gap-2 pt-0.5">
              <span
                className="h-6 w-6 shrink-0 overflow-hidden rounded border border-border"
                style={{ backgroundColor: css }}
                aria-hidden
              />
              <input
                type="text"
                value={hexDraft}
                spellCheck={false}
                autoComplete="off"
                aria-label={`${control.label} hex in picker`}
                onChange={(event) => setHexDraft(event.target.value)}
                onBlur={() => commitHex(hexDraft)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitHex(hexDraft)
                  }
                }}
                className="min-w-0 flex-1 rounded border border-border bg-secondary px-1.5 py-1 font-mono text-[11px] uppercase text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-ring/30"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="shrink-0 rounded border border-border bg-secondary px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <div ref={rootRef} className="group space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-sm text-foreground">{control.label}</span>
          {!isDefault ? (
            <button
              type="button"
              onClick={() => onChange(control.defaultValue >>> 0)}
              title={`Reset to ${hexToCss(control.defaultValue)}`}
              aria-label={`Reset ${control.label} to default`}
              className="rounded px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Reset
            </button>
          ) : null}
        </div>
        <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground tabular-nums">
          {css}
        </span>
      </div>
      {control.description ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{control.description}</p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${control.label}, open colour picker`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
          className="h-7 w-10 shrink-0 overflow-hidden rounded-md border border-border outline-none transition-[box-shadow,border-color] hover:border-primary/50 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/40"
          style={{ backgroundColor: css }}
        />
        <input
          type="text"
          value={hexDraft}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${control.label} hex`}
          onChange={(event) => setHexDraft(event.target.value)}
          onBlur={() => commitHex(hexDraft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitHex(hexDraft)
              ;(event.target as HTMLInputElement).blur()
            }
          }}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 font-mono text-[11px] uppercase text-muted-foreground outline-none transition-colors placeholder:text-muted-foreground/60 hover:border-border hover:bg-secondary/60 focus:border-border focus:bg-secondary focus:text-foreground focus:ring-1 focus:ring-ring/30"
          placeholder="#00E05A"
        />
      </div>

      {panel}
    </div>
  )
}

type SaturationValuePadProps = {
  hue: number
  saturation: number
  value: number
  onChange: (saturation: number, value: number) => void
}

function SaturationValuePad({ hue, saturation, value, onChange }: SaturationValuePadProps) {
  const padRef = useRef<HTMLDivElement>(null)

  const pick = useCallback(
    (clientX: number, clientY: number) => {
      const el = padRef.current
      if (!el) {
        return
      }
      const rect = el.getBoundingClientRect()
      const s = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const v = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height))
      onChange(s, v)
    },
    [onChange],
  )

  const pureHue = hsvToRgb(hue, 1, 1)
  const hueCss = `rgb(${pureHue.r}, ${pureHue.g}, ${pureHue.b})`
  const thumb = hsvToRgb(hue, saturation, value)

  return (
    <div
      ref={padRef}
      role="slider"
      aria-label="Saturation and brightness"
      aria-valuetext={`saturation ${Math.round(saturation * 100)}%, brightness ${Math.round(value * 100)}%`}
      tabIndex={0}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        pick(event.clientX, event.clientY)
      }}
      onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
          return
        }
        pick(event.clientX, event.clientY)
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      className="relative h-20 w-full cursor-crosshair touch-none overflow-hidden rounded-md border border-border"
      style={{
        backgroundImage: `
          linear-gradient(to top, #000, transparent),
          linear-gradient(to right, #fff, ${hueCss})
        `,
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
        style={{
          left: `${saturation * 100}%`,
          top: `${(1 - value) * 100}%`,
          backgroundColor: `rgb(${thumb.r}, ${thumb.g}, ${thumb.b})`,
        }}
      />
    </div>
  )
}

type HueSliderProps = {
  hue: number
  onChange: (hue: number) => void
}

function HueSlider({ hue, onChange }: HueSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)

  const pick = useCallback(
    (clientX: number) => {
      const el = trackRef.current
      if (!el) {
        return
      }
      const rect = el.getBoundingClientRect()
      const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      onChange(t * 360)
    },
    [onChange],
  )

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label="Hue"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(hue)}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        pick(event.clientX)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
          return
        }
        pick(event.clientX)
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      className="relative h-3.5 w-full cursor-ew-resize touch-none overflow-hidden rounded-full border border-border"
      style={{
        background:
          'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
        style={{ left: `${(hue / 360) * 100}%` }}
      />
    </div>
  )
}

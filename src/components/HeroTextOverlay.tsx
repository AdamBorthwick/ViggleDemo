type HeroTextOverlayProps = {
  visible: boolean
}

export function HeroTextOverlay({ visible }: HeroTextOverlayProps) {
  if (!visible) {
    return null
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
      <div className="w-full [filter:drop-shadow(0_10px_28px_rgba(0,0,0,0.28))] md:w-[70%]">
        <h1 className="text-[clamp(2rem,4vw,2.75rem)] leading-[1.05] tracking-tight text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.5),0_8px_24px_rgba(0,0,0,0.3)]">
          A Spatial GenAI platform powered by JST model.
        </h1>

        <p className="mt-6 text-base leading-relaxed text-white/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.5),0_6px_18px_rgba(0,0,0,0.26)]">
          Viggle&apos;s proprietary Joint-Space-Time (JST) model is a physics-aware model
          designed to create and control motion across characters, scenes, and environments.
          Our mission is to make spatial content creation accessible and scalable.
        </p>

        <div className="mt-8 flex justify-start">
          <button
            type="button"
            className="pointer-events-auto rounded-md border border-white/30 bg-white/10 px-4 py-2 text-sm text-white backdrop-blur-sm transition-colors hover:bg-white/20"
          >
            Learn more →
          </button>
        </div>
      </div>
    </div>
  )
}

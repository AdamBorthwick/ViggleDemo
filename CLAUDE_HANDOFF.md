# Claude Handoff — Virtual Buddy (current project)

> **Status:** Authoring demo is live on GitHub. Headless consumer repos exist as **docs + settings stubs only** — real app shells are the next major task (full code review first, then import).  
> **Date context:** 2026-07-30  
> **Git:** branch `publish-clean` tracks `origin/main` @ `1bfec79`

---

## What this project is

**Viggle Virtual Buddy** is an interactive 3D character playground for a design challenge:

- Mixamo-style GLB characters on a Rapier physics stage
- Grab / throw / ragdoll, muscle tone, multi-buddy stage
- Per-part costume tinting (shader `onBeforeCompile`)
- Post filters: Off / Game Boy / Cartoon / PS1
- Left **authoring control panel** (designer knobs)
- Stage **+** button to spawn random buddies (anti-repeat model pick + random costume hue)
- **Export** handoff to two headless GitHub repos (settings only today)

Primary product brand color: **`#00E05A`**. Design tokens live in `src/styles/globals.css`.

---

## Repositories

| Repo | URL | Role |
|------|-----|------|
| **Authoring demo** | https://github.com/AdamBorthwick/ViggleDemo | Full editor + stage (this workspace) |
| **Headless full scene** | https://github.com/AdamBorthwick/ViggleBuddy-Scene | Consumer: stage + models + physics + filters; UI = **add button only** |
| **Headless effects** | https://github.com/AdamBorthwick/ViggleBuddy-Effects | Consumer: **filters only** — no models, no Rapier, no stage chrome |

Local clones of the headless repos (when present):

```text
Desktop/ViggleBuddy-Scene/
Desktop/ViggleBuddy-Effects/
```

Each headless repo currently contains **only**:

```text
.gitignore
HANDOFF.md          ← consumer + implementer steps
README.md
src/virtualBuddyExport.ts   ← replace target for downloads
```

Do **not** assume headless apps are runnable yet. A partial shell copy was started and **cleaned out** of Scene; both remotes match the stub state above.

### Headless HANDOFF docs

- Scene: https://github.com/AdamBorthwick/ViggleBuddy-Scene/blob/master/HANDOFF.md  
- Effects: https://github.com/AdamBorthwick/ViggleBuddy-Effects/blob/master/HANDOFF.md  

Those files describe the consumer flow and the implementer checklist (what to copy from ViggleDemo). Prefer following them when building shells.

---

## Local workspace (authoring)

```text
C:\Users\adadb\OneDrive\Desktop\Viggle Design Challenge\
```

Stack: **Vite 7 + React 19 + TypeScript + Three.js + Rapier + Tailwind 4**.

```bash
npm install
npm run dev
npm run build   # tsc -b && vite build
```

`vite.config.ts` uses `base: './'` for GitHub Pages–friendly relative assets.

### Large assets

```text
public/models/
  buddy.glb / xbot.glb / xbotf.glb   (~3–4 MB)
  paladin.glb                        (~10 MB)
  dancer.glb                         (~53 MB)
  ninja.glb                          (~59 MB)
```

GitHub file limit is 100 MB; still large — consider **Git LFS** when importing into Scene. Effects repo must **not** ship these GLBs.

---

## Architecture (authoring)

### Entry & shell

| File | Role |
|------|------|
| `src/main.tsx` | React root |
| `src/App.tsx` | Layout: optional `ControlPanel` + `ShaderCanvas` + **+** add button; export download |
| `src/components/ShaderCanvas.tsx` | Owns `VirtualBuddyScene`, rAF loop, pointer grab |
| `src/components/ControlPanel.tsx` | Sidebar: sections, Models, Reset scene / sliders, **Export menu** |
| `src/components/ModelsSection.tsx` | Per-buddy list, motion, part colors, remove, add by type |
| `src/styles/globals.css` | Design tokens, dark default, add-buddy animation |

### Effect core

```text
src/effects/virtual-buddy/
  VirtualBuddyScene.ts    # Stage, physics step, spawn, filters composer
  types.ts                # VirtualBuddyParams (all numbers)
  preset.ts               # Control definitions + defaults
  exportScope.ts          # Full vs Effects export, repo URLs, TS module builder
  costumeHue.ts           # Random hue on stage spawn
  models/registry.ts      # MODELS, MOTIONS, GLB load, clip meta
  physics/                # Rapier world, ragdoll, grab
  pose/                   # Animation / bind / raised-hands pose sources
  render/                 # SkinnedView, PrimitiveView, costumeTintShader
  rigs/                   # Mixamo + primitive rigs
  filters/                # FilterStack + fullscreen post shaders
```

### Preset infrastructure

`src/presets/types.ts` — sliders, checkboxes, selects, colors (packed `0xRRGGBB`), visibility rules, `paramsFromControls` / `valuesFromParams` / `hexToRgb01`.

Legacy Spacetime Bloom files may still exist under `src/three/`, `src/presets/spacetime-bloom.ts`, and `effect-archive/spacetime-bloom/`. **They are not the active product.** Active app wires **Virtual Buddy only**.

---

## Runtime behavior (important details)

### Stage UI (full-scene handoff surface)

- **Only** the green circular **+** button (bottom-left) is the public stage chrome for full-scene handoff.
- **No** hero text overlay requirement for handoff (hero component may still exist in tree; do not restore marketing overlay as a handoff requirement unless asked).
- Control panel is **authoring-only** — not shipped in headless Scene.

### Spawn

- Stage **+**: random **spawnable** model (must have `url`), strong anti-repeat, **random costume hue**.
- Models panel: chosen registry index, **authored** colours (no random hue).
- At `maxBuddies` (slider, default 3, max typically 8): **FIFO** — oldest removed.

### Models

Registry indices map to `MODELS` in `models/registry.ts` (Buddy / Ninja / Paladin / Dancer / etc.). Capsules are debug overlay via `showPhysicsBodies`, not a selectable model. Dancer uses preferred dance clip / pin-root behavior where configured.

### Costume tint

`render/costumeTintShader.ts` — channels: skin / armor / trim / albedo / yellow-shirt style masks depending on asset. Hue randomization via `costumeHue.ts`.

### Filters

`FilterStack` + `filters/shaders.ts` — modes: 0 Off, 1 Game Boy, 2 Cartoon, 3 PS1. Driven every frame from `VirtualBuddyParams`.

### Reset

- **Reset scene** — clear all buddies (`clearStage`); keep sliders.
- **Reset sliders** — restore preset defaults; stage models stay unless user clears.

---

## Export system (current)

Contract lives in `src/effects/virtual-buddy/exportScope.ts`.

### UI (`ControlPanel` → `ExportMenu`)

1. Toggle **Export** (open = single button labeled Export + ×; closes on click or outside).
2. Step **1** — scope toggle **Full scene** | **Effects**, blurb, link **Download … repo**.
3. Step **2** — **Download settings** (TypeScript module).
4. Step **3** — replace `src/virtualBuddyExport.ts` in the cloned headless repo.

Blurbs:

- Full scene: `"Export 3D scene, physics and effects"`
- Effects: `"Filter library only — no 3D models, no stage UI."`

### Download format

Not JSON. Generated TS:

```ts
export const virtualBuddyExport = { ... } as const
export type VirtualBuddyExport = typeof virtualBuddyExport
```

Filename: `{presetId}-{full|effects}-settings.ts` (e.g. `virtual-buddy-full-settings.ts`).

Payload:

```ts
{
  version: 1,
  preset: 'virtual-buddy',
  scope: 'full' | 'effects',
  repo: string,           // GitHub URL for that scope
  settings: { ... },      // full params OR effects-only keys
  buddies?: BuddySnapshot[]  // full scope only
}
```

- **Full** → all `VirtualBuddyParams` + optional `buddies` snapshots.  
- **Effects** → `EFFECTS_KEYS` only (filter knobs; no models list).

Replace path constant: `EXPORT_SETTINGS_TARGET_PATH = 'src/virtualBuddyExport.ts'`.

Repo URLs:

```ts
full:    https://github.com/AdamBorthwick/ViggleBuddy-Scene
effects: https://github.com/AdamBorthwick/ViggleBuddy-Effects
```

---

## Intended headless products (not built yet)

### ViggleBuddy-Scene

| Include | Exclude |
|---------|---------|
| `VirtualBuddyScene` + physics + models + filters | `ControlPanel` / Models section |
| `public/models/*.glb` | Export drawer |
| Full-viewport canvas + grab | Hero overlay |
| **+** add-buddy button only | |

Wire params from `virtualBuddyExport.settings`. Optionally seed from `buddies`.

### ViggleBuddy-Effects

| Include | Exclude |
|---------|---------|
| `filters/FilterStack` + shaders | GLBs, Rapier, spawn, grab |
| Minimal beauty pass → composer | Stage chrome |
| Settings-driven filter look | Full scene knobs UI |

Merge partial effects settings onto defaults.

### Suggested import approach (after review)

1. Review authoring code with Claude (this handoff + headless HANDOFFs).
2. Scaffold each consumer (Vite/React/Three; Scene also needs Rapier + models).
3. Copy modules listed in each headless `HANDOFF.md` implementer checklist.
4. Thin `App.tsx` shells; single settings file as the replace target.
5. Verify: export from demo → overwrite `src/virtualBuddyExport.ts` → look updates without code edits.
6. Prefer Git LFS for large GLBs in Scene.

---

## Key types

`VirtualBuddyParams` (`types.ts`) — all numbers: buddies, physics, interaction, scene, filter knobs (Game Boy / Cartoon `bl*` / PS1).

`BuddySnapshot` (`VirtualBuddyScene.ts`) — id, label, modelIndex, motionIndex, color, parts[] for Models UI and full export.

---

## Controls layout (authoring sidebar)

Sections from `preset.ts` (typically start **closed**):

- **Models** — list, add, remove, motion, part colors, max buddies  
- **Effects** — style + filter-specific knobs  
- **Physics / Interaction / Scene** — gravity, grab, camera, ground, rim light, etc.

Footer:

- **Reset scene** (primary)  
- **Reset sliders** | **Export** (toggle panel)

---

## What not to do (unless asked)

- Do not reintroduce Spacetime Bloom as the active effect.
- Do not rebuild the abandoned folder-tab export chrome (simplified Export menu is intentional).
- Do not put the control panel into headless Scene.
- Do not put 3D models into headless Effects.
- Do not commit `node_modules` or treat untracked shell experiments as shipped.

---

## Related docs in this repo

| File | Notes |
|------|--------|
| `CLAUDE_HANDOFF.md` | **This file** — current source of truth for agents |
| `HANDOFF.md` | Older design-challenge brief (historical) |
| `PHASE_6_HANDOFF.md` / `PHASE_7_FILTERS_ENTRY.md` | Earlier phase notes; may be stale |
| `effect-archive/spacetime-bloom/` | Frozen previous effect |
| Headless `HANDOFF.md` files | Consumer + implementer steps for Scene / Effects |

If older docs conflict with this file, **prefer this file**.

---

## Recent history (git)

```text
1bfec79 Simplify export menu and polish handoff UI.
0dfa243 Polish Virtual Buddy stage, models, and costume controls.
7a66d07 Prepare Virtual Buddy for GitHub Pages
12530c8 Add per-part model color controls
4c997aa Build interactive Virtual Buddy experience
```

---

## Immediate next work (expected)

1. **Full code review** of ViggleDemo (Virtual Buddy + export contract).  
2. **Import / implement** real shells into:
   - `AdamBorthwick/ViggleBuddy-Scene`
   - `AdamBorthwick/ViggleBuddy-Effects`  
   following each repo’s `HANDOFF.md` and this document.  
3. Keep `src/virtualBuddyExport.ts` as the **only** consumer config surface.

When implementing, match existing stage behavior (spawn rules, max buddies FIFO, filter sync, brand green UI) rather than inventing a new product surface.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What BoundBox is

A tool for describing layouts to an AI *visually*: drag out labeled boxes instead of writing prose, export the layout as JSON, and hand it to a model. It ships as a **just-in-time skill** — an AI launches it on demand, uses it through a project-local exchange folder, and nothing keeps running in the background afterward.

Two modes:
- **Sketch** — boxes on a blank canvas → `boxes.json` (0–1000 normalized grid).
- **Iterate** — an AI-authored [Wireloom](https://github.com/StardockCorp/Wireloom) wireframe renders as the canvas background; every bindable element becomes a selectable overlay box; user edits export as `packet.json` edits keyed to source lines.

## Commands

```bash
npm test                      # run all tests (vitest)
npx vitest run test/editor.test.js          # single file
npx vitest run -t "draw-commit"             # single test by name
npx vitest                    # watch mode

npm run vendor                # rebuild vendor/wireloom.mjs from ../Wireloom source (do this first on a fresh clone)
npm run build                 # bundle src/app.mjs into app/boundbox.html (the single-file app)
npm run skill:build           # build the self-contained skill bundle into skill/
npm run skill:sync            # build + install the skill to ~/.claude/skills and ~/.codex/skills

python launch.py --dir ./boundbox --on-demand     # Python/Streamlit app; stops after browser inactivity
python launch.py --dir ./boundbox                  # stable Tower service on 0.0.0.0:8620
python history.py list --dir ./boundbox             # inspect / show / restore exchange-file history
```

There is no lint step. Tests are the gate.

## Critical build dependency

`vendor/wireloom.mjs` is **generated** by `npm run vendor`, which bundles Wireloom's TypeScript source directly from a sibling checkout at `../Wireloom` (i.e. `C:\Users\miket\Repo\Wireloom`). This is deliberate: it exposes Wireloom's internal `layout()` function (per-element rects + AST source positions), which is **not** in Wireloom's public npm API and is what makes element binding possible. `src/wireframe.mjs` imports from `vendor/wireloom.mjs`. If Wireloom is missing or `vendor/` is stale, wireframe loading and the iterate tests break — re-run `npm run vendor`.

Both `app/boundbox.html` and `skill/boundbox.html` are **generated** single-file canvas bundles. Never hand-edit them; edit `src/` + `app/template.html` and rebuild. Their size makes diffs look huge. The executable shell, exchange service, journal, and launcher are Python; Node is retained only for maintaining the browser canvas bundle.

## Architecture

### The editor is DOM-free; the app is a thin DOM shell

The entire interaction contract — pointer state machine, box store, undo, labeling, mode switching, packet building — lives in `src/editor.mjs` and its pure helpers, with **no DOM access**. This is why the interaction spec is exhaustively unit-testable (`test/editor.test.js`, `test/iterate.test.js`). `src/app.mjs` is the only file that touches the DOM: it feeds pointer events (in canvas coordinates) into the editor and re-renders the SVG overlay + sidebar from editor state on every event.

When changing interaction behavior, change `src/editor.mjs` and add an editor-level unit test. Only reach into `src/app.mjs` for DOM wiring, rendering, and browser-event ordering concerns.

Module map:
- `geometry.mjs` — pure rect math (clamping, handles, resize, hit-testing). `clampPoint` (for draw/resize, pins the anchored edge) vs `clampRect` (for drag, translates the whole rect) is a load-bearing distinction — mixing them reintroduces an anchor-translation bug.
- `editor.mjs` — `createEditor()` returns the headless controller. Owns `state`, the pointer state machine, and overlay-only undo (bounded 100-snapshot stack; snapshots deliberately exclude wireframe state — source loads clear the stacks instead).
- `export.mjs` — `toNormalized` / `buildSketchPayload` (sketch profile, 0–1000 grid).
- `packet.mjs` — `buildIteratePayload` / `editsForBox` (iterate profile).
- `wireframe.mjs` — `loadWireframe`: parse → `layout()` → render SVG + build the bindable-element list.
- `project.mjs` — `serializeProject` / `restoreProject` / `validateProject` (persistence, strict validation, edit reconciliation).
- `runtime.py` — token-protected exchange API, atomic writes, append-only history, and recovery.
- `launch.py` / `app.py` — Python lifecycle manager and Streamlit operator shell.
- `app.mjs` — DOM layer, bundled to `app/boundbox.html`.

### Edits are derived by state-diff, not an event log

`packet.mjs` computes the iterate packet by **diffing current overlay state against the layout bindings**, not by replaying recorded actions. Consequences to preserve when touching this:
- Merge semantics are free: repeated moves collapse to final geometry; `delete` supersedes prior move/resize/note (a deleted bound box is a marked-deleted toggle, not a removal); an added box absorbs its own edits.
- "Edits belong to exactly one source version" is **structural**: bound boxes are rebuilt fresh from bindings on every accepted source load, so a stale diff cannot exist. Loading a new source flushes pending edits by construction.
- Bound-box `label`/`type`/`text` are read-only derivations of the wireframe element; edit intent for a bound box goes through its `note` (→ `annotate` op) and its rect (→ `move`/`resize` ops).

### The background is never mutated

Wireloom computes positions from structure, so there is no coordinate a free drag could write back to. The wireframe SVG is a read-only background; dragging a bound element moves a **clone** of it (a sprite in `app.mjs`, clipped from the background SVG by viewBox) while a ghost marks the origin. The source only changes when the AI regenerates it and the user reloads. Do not add code that edits the background SVG in place.

### The Python exchange service owns the exchange folder

`launch.py` starts the Streamlit shell on stable port 8620 and a Python exchange API on 8621. The API is protected by a random session token in the URL path, writes outputs atomically to whitelisted filenames only, and journals every distinct version of the exchange files. It is the single chokepoint for the journal: reconciliation runs on launch, on `GET /source`, and after each save. `--on-demand` enables the heartbeat-driven idle shutdown; the default is a continuous Tower-managed service. Keep new endpoints and output files inside this token + whitelist + atomic-write + journal discipline.

Exchange folder contract (default `./boundbox/`):

| File | Direction | Meaning |
|---|---|---|
| `source.wireloom` | AI → app | Complete wireframe to render as background |
| `boxes.json` | app → AI | Sketch-mode layout |
| `packet.json` | app → AI | Iterate-mode source + ordered edits |
| `project.json` | app ↔ app | Session persistence (app-owned; not an AI response target) |
| `history/journal.jsonl` | exchange service | Append-only exchange history |

## Conventions

- The server and operator shell are Python/Streamlit. Browser interaction stays ESM and bundles into one self-contained HTML canvas; Node/esbuild is build tooling only.
- Windows is the primary platform. `runtime.py` uses `replace_with_retry` for antivirus/open-handle interference; reuse it for any atomic write.
- `node_modules/` is currently tracked from an early commit despite the `.gitignore` rule; untrack with `git rm -r --cached node_modules` before relying on the ignore.

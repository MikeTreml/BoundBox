# Fixture Conventions (boundbox.test-plan)

- `*.wireloom` — wireframe sources. `boundbox-mockup.wireloom` is the canonical layout fixture (the 2026-07-16 demo of BoundBox's own UI).
- `*.rects.json` — golden per-element layout output from `npm run extract -- <fixture>`. A failing golden must be inspected, never blindly regenerated.
- `*.svg` — rendered output paired with its source (visual reference, not asserted byte-for-byte).
- `*.transcript.md` — captured AI replies for ai-handoff's degraded paste mode (block / prose+block / none / broken).
- `*.boundbox.json` — saved project files for persistence round-trip tests.

Regenerate layout goldens after a Wireloom re-vendor: `npm run vendor && npm run extract -- fixtures/boundbox-mockup.wireloom`.

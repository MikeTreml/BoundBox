---
name: boundbox
description: Launch BoundBox — a JIT visual layout tool — when the user wants to sketch an app/site/image layout as labeled boxes, or mark up an AI-generated Wireloom wireframe with precise edits. Use when the user says "let me sketch it", "open boundbox", "let me draw the layout", or when a design conversation needs the user's visual input instead of prose. Not for rendering wireframes (use wireloom) or for building real UIs.
---

# BoundBox Skill (draft — contract slice)

BoundBox is launched just-in-time: a local single-file app + a zero-dependency Node server that exits when idle. You (the AI) drive it through files in an exchange folder.

## Launch

```bash
node C:\Users\miket\Repo\BoundBox\launch.mjs --dir ./boundbox
```

- Prints `URL: http://127.0.0.1:{port}/{token}/` — give this to the user (or open it in your browser pane).
- Creates `./boundbox/` (self-gitignored). Re-launching while a session is alive warns and reuses it.
- The server exits after 30 minutes idle; Ctrl+C stops it sooner. Nothing runs in the background afterward.

## Exchange contract

| File | Direction | Meaning |
|---|---|---|
| `./boundbox/source.wireloom` | AI → app | Wireframe to load as background (write BEFORE launching for iterate mode; omit for sketch mode) |
| `./boundbox/boxes.json` | app → AI | Sketch layout: labeled boxes with 0–1000-grid bboxes + project description |
| `./boundbox/packet.json` | app → AI | Iterate packet: full wireloom source + ordered edit deltas keyed to source lines |
| `./boundbox/project.json` | app → AI | Saved project (persistence) |

Read outputs after the user says they've saved (or watch mtime). Check freshness before trusting a file from an earlier session.

## History and recovery

Every distinct version of every exchange file is snapshotted automatically into `./boundbox/history/` with an append-only `journal.jsonl` ledger (seq, timestamp, direction ai-to-user / user-to-ai, hash, reason). Nothing is ever lost by an overwrite — if something changed and shouldn't have:

```bash
node C:\Users\miket\Repo\BoundBox\scripts\history.mjs list --dir ./boundbox
node C:\Users\miket\Repo\BoundBox\scripts\history.mjs show 3 --dir ./boundbox
node C:\Users\miket\Repo\BoundBox\scripts\history.mjs restore 3 --dir ./boundbox
```

Restores are themselves journaled. The journal is also served at `GET {url}history`, and you can read `journal.jsonl` directly.

## Responding to a packet

Rewrite the COMPLETE wireloom source applying the edits (never a diff), write it to `./boundbox/source.wireloom`, and tell the user to click Reload. If the app reports a parse error, the user will paste it back — fix and rewrite.

## Status

Contract slice only: the page at the URL is a stub proving launch → save → read. The canvas app replaces it in the next slices.

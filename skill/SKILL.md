---
name: boundbox
description: Launch BoundBox when a user wants to sketch a page, app, image, or level layout as labeled boxes, or visually mark precise changes over a Wireloom wireframe. Use for requests such as "open BoundBox," "let me sketch it," "let me draw the layout," or when visual placement would communicate intent better than prose. Do not use it to render a finished UI.
---

# BoundBox

BoundBox is a just-in-time visual workspace. It runs in the conversation's browser pane and exchanges files through a project-local `boundbox/` folder.

## Start or resume

1. Choose an exchange directory, normally `<project>/boundbox`.
2. For wireframe iteration, write the complete starting Wireloom document to `source.wireloom` before launch. For a blank sketch, omit it.
3. Resolve the directory containing this `SKILL.md`, then run:

   ```text
   node <skill-directory>/launch.mjs --dir <project>/boundbox
   ```

4. Open the printed tokenized URL in the in-app browser pane. Keep the launcher process attached while the pane is in use.

If that exchange folder already has a live launcher, a second launch prints the existing URL and exits. Reuse that pane and session.

## Integrated lifecycle

- Treat the browser pane as part of the working app. Do not routinely stop and restart Playwright or the launcher between edits.
- The page sends a heartbeat while it is open, so the launcher's idle cleanup does not interrupt an active workspace.
- Browser Refresh is the normal UI restart. It reloads the app and automatically opens a valid saved `project.json`.
- **Reset workspace** returns the UI to a blank canvas. It intentionally does not delete `project.json`, exports, or history; **Open project** can restore the saved workspace.
- Closing the pane stops heartbeats. The launcher then exits after its idle timeout, leaving no standing service.
- Relaunch only when the URL is no longer reachable. Refresh cannot revive a process that was explicitly killed.

## Work with the user

- Blank sketch: let the user draw, label, describe, and order boxes, then use **Save for AI**.
- Wireframe iteration: have the user click **Load wireframe**, move/resize/annotate/delete elements, then use **Save edits for AI**.
- Session continuity: have the user use **Save project** before leaving. Opening the URL later—or refreshing it in the current pane—rehydrates that project.
- If the user has unsaved changes, do not open or reload another file without their confirmation.

Read [PROMPTS.md](PROMPTS.md) before interpreting an export or writing an AI response. Read [SCHEMA.md](SCHEMA.md) when validating or producing payloads.

## Exchange files

| File | Direction | Purpose |
|---|---|---|
| `source.wireloom` | AI -> app | Complete Wireloom background/revision |
| `boxes.json` | app -> AI | Blank-sketch layout on the 0-1000 coordinate grid |
| `packet.json` | app -> AI | Complete source plus ordered edit intents |
| `project.json` | app -> app/AI | Versioned workspace state used by Save/Open/Refresh |
| `history/journal.jsonl` | launcher | Append-only exchange-file history |

Read only the output matching the current mode. Check that it was saved during the current exchange; stale files may coexist intentionally.

When responding to `packet.json`, rewrite the complete Wireloom source, not a diff. Write the revision to `source.wireloom`, then tell the user to click **Reload**. Never discard an unmatched edit silently; explain the conflict and preserve the rest.

## History and recovery

The launcher snapshots every distinct observed version of `source.wireloom`, `boxes.json`, `packet.json`, and `project.json`. Use the bundled history command from the skill directory:

```text
node <skill-directory>/history.mjs list --dir <project>/boundbox
node <skill-directory>/history.mjs show <seq> --dir <project>/boundbox
node <skill-directory>/history.mjs restore <seq> --dir <project>/boundbox
```

Inspect before restoring. Avoid restores while the app is actively saving. A restore is itself journaled.

If project loading reports invalid/newer JSON, leave the live canvas intact and recover from history. If saved Wireloom no longer parses, BoundBox opens a recovery canvas that preserves pending intent; repair `source.wireloom`, then use **Load wireframe** to rebind it before exporting.

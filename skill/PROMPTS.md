# BoundBox AI Handoff

Use this reference after the user saves `boxes.json` or `packet.json`. The exchange folder is normally `./boundbox/` in the user's current project.

## Dispatch by file

| File | Meaning | AI action |
|---|---|---|
| `boxes.json` | A greenfield layout request | Read the geometry and semantics, then write a complete `source.wireloom`. |
| `packet.json` | Requested changes to an existing wireframe | Apply every edit to the included source, then write a complete replacement `source.wireloom`. |
| `project.json` | App-owned session persistence | Do not treat it as a generation request or edit it unless the user explicitly asks for recovery. |
| `source.wireloom` | Current AI-authored wireframe | Replace atomically; never write a diff or Markdown fence into this file. |

Check freshness before acting. Prefer the newest journal entry or modification time and do not silently answer a stale packet when `source.wireloom` already differs from `packet.wireframe_source`.

## Respond to `boxes.json`

1. Read `description`, `style`, and `background` as whole-canvas intent when present.
2. Read boxes in array order. Each `bbox` is `[x, y, width, height]` on a 0–1000 grid.
3. Preserve each box's label and description as semantic intent. For `type: "text"`, preserve `text` as literal copy when present.
4. Infer rows, columns, sections, spacing, and hierarchy from the relative rectangles. Coordinates express intended composition, not absolute Wireloom positioning commands.
5. Write one complete, parseable `source.wireloom` to the exchange folder.
6. Tell the user the source is ready and to click **Load wireframe** (or **Reload** if already iterating).

Small example:

```json
{
  "description": "Simple product landing page",
  "boxes": [
    { "label": "nav", "desc": "Logo and navigation", "type": "obj", "bbox": [50, 40, 900, 100] },
    { "label": "hero", "desc": "Product value proposition", "type": "text", "text": "Move faster", "bbox": [80, 220, 500, 300] },
    { "label": "art", "desc": "Product screenshot", "type": "obj", "bbox": [620, 190, 300, 380] }
  ]
}
```

One reasonable response shape:

```wireloom
window "Product landing page":
  header:
    row:
      text "Logo" bold
      spacer
      button "Features"
      button "Pricing"
  row:
    col:
      section "hero":
        text "Move faster" bold size=large
        text "Product value proposition" muted
        button "Get started" primary
    col:
      image label="Product screenshot" height=260 id="art"
```

## Respond to `packet.json`

Start from `wireframe_source` in the packet. Apply edits in array order:

- `delete`: remove the targeted node/subtree.
- `annotate`: implement the requested semantic change in `note`. BoundBox may
  generate this note from the Type/Literal text controls as well as from the
  free-form requested-change field.
- `move`: restructure rows/columns/order/spacing so the target approaches the normalized `to.x`/`to.y`; when `w`/`h` are also present, resize it too.
- `resize`: adjust width, height, container allocation, or element options to approach `to.w`/`to.h`.
- `add`: insert a suitable Wireloom element near `bbox`, using `label`, `desc`, `type` (`obj` or `text`), and optional literal `text`.

Targets use source `line`, element `kind`, and `label`. Match against the packet's included source, not a different local revision. Preserve unaffected content and intent, but rewrite the entire source file rather than patching line numbers in place.

After writing `source.wireloom`, tell the user to click **Reload**. Reload accepts a new source version and flushes edits tied to the prior version.

## Error recovery

If BoundBox reports a parse error:

1. Read the exact line/column/message copied by the user.
2. Fix the complete source while retaining the requested layout and packet edits.
3. Rewrite `source.wireloom` and ask the user to reload again.

If an old saved project enters **Recovery** mode, repair `source.wireloom` and have the user click **Load wireframe**. BoundBox retains bound notes/delete intent and attempts to reconcile it onto the repaired source. It reports targets that no longer match instead of guessing.

## Safety and history

- Write only the fixed exchange filenames; never invent a path from payload content.
- Do not edit `history/` or `journal.jsonl` manually.
- Use the bundled `history.py` commands from SKILL.md before restoring an earlier exchange file.
- Never overwrite `project.json` as an AI response; the app owns it.

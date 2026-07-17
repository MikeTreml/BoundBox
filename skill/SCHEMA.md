# BoundBox Exchange Schema

This is the AI-facing contract for BoundBox exchange files. JSON examples below use the schemas emitted by the current app: exchange version `"1"` and project schema version `1`.

## Shared coordinate rules

- `canvas` is the actual editor canvas size in pixels: `{ "w": width, "h": height }`.
- Exported `bbox` arrays use `[x, y, width, height]`, never corner coordinates.
- `bbox` and edit `to` values are integers on an independent 0–1000 grid for each axis. They are rounded from canvas pixels.
- Export guarantees `0 <= x,y,w,h <= 1000`, `x + w <= 1000`, and `y + h <= 1000`.
- Array order is meaningful. Read boxes and edits from first to last.

## `boxes.json`

`boxes.json` is the sketch-profile request written by **Copy JSON** or **Save** while no Wireloom background is active.

```json
{
  "boundbox": "1",
  "canvas": { "w": 1024, "h": 768 },
  "grid": "0-1000",
  "description": "Product landing page",
  "style": "Quiet and technical",
  "background": "Off-white",
  "boxes": [
    {
      "label": "hero",
      "desc": "Product value proposition",
      "type": "text",
      "bbox": [80, 180, 500, 300],
      "text": "Move faster"
    }
  ]
}
```

Top-level fields:

| Field | Type | Required | Contract |
|---|---|---:|---|
| `boundbox` | `"1"` | yes | Exchange format version. |
| `canvas` | `{w: integer, h: integer}` | yes | Source canvas pixels; the app keeps both dimensions at least 64. |
| `grid` | `"0-1000"` | yes | Coordinate profile. |
| `description` | string | no | Whole-layout purpose; omitted when empty. |
| `style` | string | no | Whole-layout visual direction; omitted when empty. |
| `background` | string | no | Whole-layout background direction; omitted when empty. |
| `image` | string | no | Reserved sketch-export context; the current UI does not populate or persist it. |
| `boxes` | `SketchBox[]` | yes | Sorted by the user's export order; may be empty. |

`SketchBox` fields:

| Field | Type | Required | Contract |
|---|---|---:|---|
| `label` | string | yes | Short semantic identifier. |
| `desc` | string | yes | Intended content or role; may be empty. |
| `type` | `"obj" \| "text"` | yes | Object region or literal-text region. |
| `bbox` | `[integer, integer, integer, integer]` | yes | `[x, y, width, height]` on the normalized grid. |
| `text` | string | no | Literal copy. Emitted only for `type: "text"` when non-empty. |

## `packet.json`

`packet.json` is the iterate-profile request written while a Wireloom background is active. It is self-contained: apply its edits to its own `wireframe_source`, not to a different local revision.

```json
{
  "boundbox": "1",
  "profile": "iterate",
  "canvas": { "w": 960, "h": 640 },
  "grid": "0-1000",
  "source_version": 3,
  "wireframe_source": "window \"Dashboard\":\n  row:\n    text \"Status\"\n",
  "description": "Operations dashboard",
  "style": "Dense desktop tool",
  "background": "Neutral",
  "edits": [
    {
      "op": "move",
      "target": { "line": 3, "kind": "text", "label": "Status" },
      "to": { "x": 120, "y": 80 }
    },
    {
      "op": "annotate",
      "target": { "line": 3, "kind": "text", "label": "Status" },
      "note": "Make this the primary heading"
    }
  ]
}
```

Top-level fields:

| Field | Type | Required | Contract |
|---|---|---:|---|
| `boundbox` | `"1"` | yes | Exchange format version. |
| `profile` | `"iterate"` | yes | Distinguishes this payload from `boxes.json`. |
| `canvas` | `{w: integer, h: integer}` | yes | Pixel size used to normalize edits. |
| `grid` | `"0-1000"` | yes | Coordinate profile. |
| `source_version` | non-negative integer | yes | App-local accepted-source revision. Match edits to this revision. |
| `wireframe_source` | string | yes | Complete source on which targets and baselines were computed. |
| `description` | string | no | Whole-layout purpose; omitted when empty. |
| `style` | string | no | Whole-layout visual direction; omitted when empty. |
| `background` | string | no | Whole-layout background direction; omitted when empty. |
| `edits` | `Edit[]` | yes | Ordered edit intents; may be empty. |

The edit union is:

```text
Target = { line: integer, kind: string, label: string }

Delete   = { op: "delete",   target: Target }
Annotate = { op: "annotate", target: Target, note: string }
Move     = { op: "move",     target: Target, to: { x, y } }
MoveSize = { op: "move",     target: Target, to: { x, y, w, h } }
Resize   = { op: "resize",   target: Target, to: { w, h } }
Add      = { op: "add", label: string, desc: string, bbox: [x, y, w, h], text?: string }
```

All `to` and `bbox` members are normalized integers. A `move` has either exactly `x,y` or exactly `x,y,w,h`; a `resize` has exactly `w,h`.

Target identity is the tuple `(line, kind, label)` in `wireframe_source`. `line` is one-based for parser-produced targets. BoundBox deliberately omits source column from the packet. A target label is the parsed element's first non-empty `title`, `text`, `label`, `content`, `value`, `placeholder`, or `name`; when none exists, it falls back to `kind`.

Edit derivation rules:

- Moving and resizing the same target produces one `move` with all four `to` fields.
- A geometry edit precedes an `annotate` for the same target.
- `delete` supersedes that target's geometry and annotation edits.
- A newly drawn box produces one `add` containing its final state.
- `add` currently has no `type` member. Non-empty literal text is carried by optional `text`.
- Geometry is compared at rounded canvas-pixel precision, so sub-pixel differences that round to the same pixel do not emit edits.

## `source.wireloom`

`source.wireloom` is UTF-8 Wireloom source, not JSON. Write one complete document as plain text—never a diff and never a Markdown fence.

```wireloom
window "Product landing page":
  header:
    row:
      text "Acme" bold
      spacer
      button "Sign in"
  row:
    col:
      section "hero":
        text "Move faster" bold size=large
        button "Get started" primary
    col:
      image label="Product screenshot" height=260 id="art"
```

Parser-level requirements used by BoundBox:

- A non-empty document has exactly one root `window`. Only top-level `annotation` declarations may follow it.
- Use either two or four spaces per indentation level, consistently. Tabs in indentation are invalid.
- Empty lines and `#` comments are ignored.
- Quoted strings support `\"`, `\\`, and `\n` escapes.
- Supported primitives are `window`, `header`, `footer`, `navbar`, `leading`, `center`, `trailing`, `tabbar`, `tabitem`, `sheet`, `panel`, `section`, `tabs`, `tab`, `row`, `col`, `list`, `item`, `slot`, `segmented`, `segment`, `grid`, `cell`, `resourcebar`, `resource`, `stats`, `stat`, `text`, `button`, `backbutton`, `input`, `combo`, `slider`, `kv`, `image`, `icon`, `divider`, `spacer`, `progress`, `chart`, `tree`, `node`, `checkbox`, `radio`, `toggle`, `menubar`, `menu`, `menuitem`, `separator`, `chip`, `avatar`, `breadcrumb`, `crumb`, `spinner`, and `status`. `annotation` is the special post-window declaration described above.

BoundBox renders the source, then derives editable bindings from positive-size nodes in these exact sets:

- Leaves: `text`, `button`, `input`, `combo`, `slider`, `kv`, `image`, `icon`, `divider`, `cell`, `resource`, `stat`, `progress`, `chart`, `tab`, `item`, `tabitem`, `backbutton`, `segment`, `checkbox`, `radio`, `toggle`, `menuitem`, `crumb`, `chip`, `avatar`, `spinner`, `status`, `node`, and `spacer`.
- Containers: `section`, `slot`, `header`, `footer`, `navbar`, `tabbar`, `sheet`, `segmented`, `tabs`, `menubar`, `menu`, `breadcrumb`, `tree`, `grid`, `resourcebar`, and `stats`.

`row`, `col`, `panel`, `list`, `window`, annotations, and other anonymous layout structure are not packet targets. Loading an accepted replacement source creates a new source version and flushes edits tied to the prior layout.

## `project.json`

`project.json` is app-owned session persistence. It stores editable source state and binding baselines, not rendered SVG, selection, pointer interaction, or undo/redo history. An AI should not modify it as a normal layout response.

Canonical shape:

```text
Project = {
  kind: "boundbox-project",
  schemaVersion: 1,
  mode: "sketch" | "iterate",
  canvas: Canvas,
  counter: SafeInteger,
  context: {
    description: string,
    style: string,
    background: string
  },
  boxes: ProjectBox[],
  wireframe: null | SavedWireframe,
  options: { zoom?: number }
}

Canvas = { w: SafeInteger, h: SafeInteger }
Rect = { x: number, y: number, w: number, h: number }

ProjectBox = {
  id: string,
  order: SafeInteger,
  label: string,
  description: string,
  type: "obj" | "text",
  text: string,
  rect: Rect,
  origin?: "wireframe-bound",
  binding?: Binding,
  note?: string,
  deleted?: boolean
}

Binding = {
  line: SafeInteger,
  column: SafeInteger,
  kind: string,
  label: string,
  rect: Rect,
  depth: SafeInteger
}

SavedWireframe = {
  version: SafeInteger,
  sourceText: string,
  size: Canvas,
  recovery: boolean
}
```

Validation and mode invariants:

- A `SafeInteger` is a JavaScript safe integer. Counters, orders, source positions, depth, and versions are non-negative. Canvas dimensions are safe integers at least 64.
- At most 10,000 boxes are accepted. Every `id` is non-empty and unique.
- `counter` must be at least the largest numeric suffix among IDs matching `b<number>`.
- Rect members are finite numbers; `w` and `h` are greater than zero. A box rect must stay inside `canvas`, and a binding rect must stay inside `wireframe.size`.
- `origin`, when present, must be `"wireframe-bound"` and requires `binding`; canonical bound boxes also carry `note` and `deleted`. Boxes without `origin` are user-drawn.
- `iterate` mode requires a wireframe with `recovery: false`.
- Normal `sketch` mode has `wireframe: null` and cannot contain bound boxes.
- Parse-recovery mode is represented as `mode: "sketch"` with a wireframe whose `recovery` is `true`; it may retain bound boxes, notes, deletion intent, and binding baselines until repaired source can be loaded.
- `options.zoom`, when present, is finite and between `0.1` and `4` inclusive.
- Canonical app writes include `wireframe` and `options`. The reader also accepts an omitted `wireframe` as `null`, omitted `options` as `{}`, and omitted binding `column`, `label`, or `depth` as zero, empty string, or zero respectively. Unknown fields are discarded during validation.

When reopening an iterate project, BoundBox reparses `wireframe.sourceText` and derives fresh geometry. It transfers a saved pending edit only when `(line, kind, label)` matches exactly and uniquely. Missing or ambiguous edited targets are reported rather than guessed. Only axes that differed from the saved binding baseline at rounded-pixel precision override fresh layout axes.

## History

The launcher tracks exactly these live files:

| File | Journal direction |
|---|---|
| `source.wireloom` | `ai-to-user` |
| `boxes.json` | `user-to-ai` |
| `packet.json` | `user-to-ai` |
| `project.json` | `user-to-ai` |

Every content change observed at a launcher chokepoint is copied byte-for-byte into `history/`. `history/journal.jsonl` contains one JSON object per snapshot:

```text
JournalEntry = {
  seq: positive integer,
  ts: ISO-8601 timestamp string,
  file: "source.wireloom" | "boxes.json" | "packet.json" | "project.json",
  direction: "ai-to-user" | "user-to-ai",
  bytes: non-negative integer,
  sha256: 64-character lowercase hexadecimal string,
  snapshot: string,
  reason: string
}
```

`snapshot` is `${seq padded to at least five digits}_${file}`, for example `00007_packet.json`. Sequence numbers are never reused, and snapshot files are created without overwriting an existing file. Content identical to the most recently journaled version of the same live file creates no new entry.

`GET {session-url}history` returns:

```json
{ "entries": [] }
```

with `JournalEntry` objects in `entries`. Treat `history/` and `journal.jsonl` as read-only. The bundled history command validates snapshot paths, preserves any unjournaled live content before a restore, and journals the restored version afterward.

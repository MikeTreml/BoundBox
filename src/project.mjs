/**
 * BoundBox project persistence (boundbox.persistence).
 *
 * A project stores the editable document, never rendered SVG. Wireframe-bound
 * boxes carry their previous binding baseline so pending edits can be
 * reconciled onto freshly parsed/layouted bindings when the project reopens.
 */
import { clampRect, MIN_SIZE } from './geometry.mjs';

export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_KIND = 'boundbox-project';

export class ProjectFormatError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'ProjectFormatError';
    this.path = path;
  }
}

const fail = (path, message) => { throw new ProjectFormatError(path, message); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
  return value;
};
const integer = (value, path, { min = 0 } = {}) => {
  if (!Number.isSafeInteger(value) || value < min) fail(path, `must be a safe integer >= ${min}`);
  return value;
};
const string = (value, path) => {
  if (typeof value !== 'string') fail(path, 'must be a string');
  return value;
};
const boolean = (value, path) => {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
};

const validateRect = (value, path) => {
  if (!record(value)) fail(path, 'must be an object');
  const rect = {
    x: finite(value.x, `${path}.x`),
    y: finite(value.y, `${path}.y`),
    w: finite(value.w, `${path}.w`),
    h: finite(value.h, `${path}.h`),
  };
  if (rect.w <= 0) fail(`${path}.w`, 'must be > 0');
  if (rect.h <= 0) fail(`${path}.h`, 'must be > 0');
  return rect;
};

const validateCanvas = (value, path = 'canvas') => {
  if (!record(value)) fail(path, 'must be an object');
  const canvas = {
    w: integer(value.w, `${path}.w`, { min: 64 }),
    h: integer(value.h, `${path}.h`, { min: 64 }),
  };
  return canvas;
};

const validateBinding = (value, path) => {
  if (!record(value)) fail(path, 'must be an object');
  return {
    line: integer(value.line, `${path}.line`),
    column: integer(value.column ?? 0, `${path}.column`),
    kind: string(value.kind, `${path}.kind`),
    label: string(value.label ?? '', `${path}.label`),
    rect: validateRect(value.rect, `${path}.rect`),
    depth: integer(value.depth ?? 0, `${path}.depth`),
  };
};

const validateBox = (value, path) => {
  if (!record(value)) fail(path, 'must be an object');
  const type = string(value.type, `${path}.type`);
  if (type !== 'obj' && type !== 'text') fail(`${path}.type`, 'must be "obj" or "text"');
  const box = {
    id: string(value.id, `${path}.id`),
    order: integer(value.order, `${path}.order`),
    label: string(value.label, `${path}.label`),
    description: string(value.description, `${path}.description`),
    type,
    text: string(value.text, `${path}.text`),
    rect: validateRect(value.rect, `${path}.rect`),
  };
  if (!box.id) fail(`${path}.id`, 'must not be empty');
  if (value.origin !== undefined) {
    if (value.origin !== 'wireframe-bound') fail(`${path}.origin`, 'must be "wireframe-bound" when present');
    box.origin = 'wireframe-bound';
    box.binding = validateBinding(value.binding, `${path}.binding`);
    box.note = string(value.note ?? '', `${path}.note`);
    box.deleted = boolean(value.deleted ?? false, `${path}.deleted`);
  }
  return box;
};

const validateContext = (value) => {
  if (!record(value)) fail('context', 'must be an object');
  return {
    description: string(value.description, 'context.description'),
    style: string(value.style, 'context.style'),
    background: string(value.background, 'context.background'),
  };
};

/** Validate and normalize untrusted JSON without mutating editor state. */
export function validateProject(input) {
  if (!record(input)) fail('project', 'must be an object');
  if (input.kind !== PROJECT_KIND) fail('kind', `must be "${PROJECT_KIND}"`);
  if (!Number.isInteger(input.schemaVersion)) fail('schemaVersion', 'must be an integer');
  if (input.schemaVersion > PROJECT_SCHEMA_VERSION) {
    fail('schemaVersion', `version ${input.schemaVersion} is newer than this app supports (${PROJECT_SCHEMA_VERSION})`);
  }
  if (input.schemaVersion < PROJECT_SCHEMA_VERSION) {
    fail('schemaVersion', `version ${input.schemaVersion} is not supported (expected ${PROJECT_SCHEMA_VERSION})`);
  }
  if (input.mode !== 'sketch' && input.mode !== 'iterate') fail('mode', 'must be "sketch" or "iterate"');
  if (!Array.isArray(input.boxes)) fail('boxes', 'must be an array');
  if (input.boxes.length > 10_000) fail('boxes', 'must contain at most 10000 boxes');

  const project = {
    kind: PROJECT_KIND,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    mode: input.mode,
    canvas: validateCanvas(input.canvas),
    counter: integer(input.counter, 'counter'),
    context: validateContext(input.context),
    boxes: input.boxes.map((box, i) => validateBox(box, `boxes[${i}]`)),
    wireframe: null,
    options: {},
  };

  if (input.wireframe !== null && input.wireframe !== undefined) {
    if (!record(input.wireframe)) fail('wireframe', 'must be an object or null');
    project.wireframe = {
      version: integer(input.wireframe.version, 'wireframe.version'),
      sourceText: string(input.wireframe.sourceText, 'wireframe.sourceText'),
      size: validateCanvas(input.wireframe.size, 'wireframe.size'),
      recovery: boolean(input.wireframe.recovery ?? false, 'wireframe.recovery'),
    };
  }
  if (project.mode === 'iterate' && !project.wireframe) fail('wireframe', 'is required in iterate mode');
  if (project.mode === 'iterate' && project.wireframe.recovery) fail('wireframe.recovery', 'must be false in iterate mode');
  if (project.mode === 'sketch' && project.wireframe && !project.wireframe.recovery) {
    fail('wireframe.recovery', 'must be true when a sketch project retains recovery source');
  }

  const ids = new Set();
  let maxGeneratedId = 0;
  for (let i = 0; i < project.boxes.length; i += 1) {
    const box = project.boxes[i];
    if (ids.has(box.id)) fail(`boxes[${i}].id`, `duplicate id "${box.id}"`);
    ids.add(box.id);
    const match = /^b(\d+)$/.exec(box.id);
    if (match) maxGeneratedId = Math.max(maxGeneratedId, Number(match[1]));
    const { x, y, w, h } = box.rect;
    if (x < 0 || y < 0 || x + w > project.canvas.w + 1e-6 || y + h > project.canvas.h + 1e-6) {
      fail(`boxes[${i}].rect`, 'must stay within the saved canvas');
    }
    if (project.mode === 'sketch' && box.origin === 'wireframe-bound' && !project.wireframe?.recovery) {
      fail(`boxes[${i}].origin`, 'wireframe-bound boxes require sketch recovery mode');
    }
    if (box.origin === 'wireframe-bound' && project.wireframe) {
      const rect = box.binding.rect;
      if (rect.x < 0 || rect.y < 0
        || rect.x + rect.w > project.wireframe.size.w + 1e-6
        || rect.y + rect.h > project.wireframe.size.h + 1e-6) {
        fail(`boxes[${i}].binding.rect`, 'must stay within wireframe.size');
      }
    }
  }
  if (project.counter < maxGeneratedId) fail('counter', `must be >= highest generated box id (${maxGeneratedId})`);

  if (input.options !== undefined) {
    if (!record(input.options)) fail('options', 'must be an object');
    if (input.options.zoom !== undefined) {
      const zoom = finite(input.options.zoom, 'options.zoom');
      if (zoom < 0.1 || zoom > 4) fail('options.zoom', 'must be between 0.1 and 4');
      project.options.zoom = zoom;
    }
    if (input.options.gridLock !== undefined) {
      project.options.gridLock = boolean(input.options.gridLock, 'options.gridLock');
    }
    if (input.options.gridStep !== undefined) {
      const step = finite(input.options.gridStep, 'options.gridStep');
      if (step <= 0) fail('options.gridStep', 'must be > 0');
      project.options.gridStep = step;
    }
  }
  return project;
}

const cloneBox = (box) => {
  const copy = {
    id: box.id,
    order: box.order,
    label: box.label,
    description: box.description ?? '',
    type: box.type ?? 'obj',
    text: box.text ?? '',
    rect: { ...box.rect },
  };
  if (box.origin === 'wireframe-bound') {
    copy.origin = 'wireframe-bound';
    copy.binding = JSON.parse(JSON.stringify(box.binding));
    copy.note = box.note ?? '';
    copy.deleted = !!box.deleted;
  }
  return copy;
};

/** Deterministic, JSON-ready snapshot of the editor's durable state. */
export function serializeProject(state, options = {}) {
  return validateProject({
    kind: PROJECT_KIND,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    mode: state.mode,
    canvas: { ...state.canvas },
    counter: state.counter,
    context: { ...state.context },
    boxes: state.boxes.map(cloneBox),
    wireframe: state.wireframe ? {
      version: state.wireframe.version,
      sourceText: state.wireframe.sourceText,
      size: { ...state.wireframe.size },
      recovery: state.wireframe.recovery === true,
    } : null,
    options,
  });
}

const targetKey = (binding) => JSON.stringify([
  binding.line,
  binding.kind,
  binding.label || binding.kind,
]);
const rectChanged = (rect, baseline) => ['x', 'y', 'w', 'h']
  .some((key) => Math.round(rect[key]) !== Math.round(baseline[key]));
const carriesPendingEdit = (box) => !!box.deleted || !!box.note?.trim()
  || rectChanged(box.rect, box.binding.rect);

const asUserBox = (box, canvas) => ({
  id: box.id,
  order: box.order,
  label: box.label,
  description: box.description,
  type: box.type,
  text: box.text,
  rect: clampRect(box.rect, canvas, {
    w: Math.min(MIN_SIZE, box.rect.w),
    h: Math.min(MIN_SIZE, box.rect.h),
  }),
});

/**
 * Prepare an atomic editor-state replacement.
 *
 * When `bindings` are present, pending changes from saved bound boxes are
 * overlaid on those fresh baselines. Missing targets are dropped and listed.
 * When an iterate source cannot be parsed, omit bindings: all visible boxes
 * are recovered as sketch boxes and the original source remains in
 * `wireframe` for a later repair/save.
 */
export function restoreProject(input, { bindings, size } = {}) {
  const project = validateProject(input);
  const warnings = [];

  if (project.mode !== 'iterate') {
    const recovering = project.wireframe?.recovery === true;
    return {
      state: {
        mode: 'sketch',
        canvas: project.canvas,
        counter: project.counter,
        context: project.context,
        boxes: project.boxes.map((box) => (recovering ? cloneBox(box) : asUserBox(box, project.canvas))),
        wireframe: project.wireframe,
      },
      options: project.options,
      warnings,
      fallback: false,
      project,
    };
  }

  if (!Array.isArray(bindings) || !size) {
    return {
      state: {
        mode: 'sketch',
        canvas: project.canvas,
        counter: project.counter,
        context: project.context,
        boxes: project.boxes.map(cloneBox),
        wireframe: { ...project.wireframe, recovery: true },
      },
      options: project.options,
      warnings,
      fallback: true,
      project,
    };
  }

  const freshCanvas = validateCanvas(size, 'freshWireframe.size');
  const savedBound = project.boxes.filter((box) => box.origin === 'wireframe-bound');
  const savedPositions = new Map(project.boxes.map((box, index) => [box, index]));
  const savedByTarget = new Map();
  for (const box of savedBound) {
    const key = targetKey(box.binding);
    const queue = savedByTarget.get(key) ?? [];
    queue.push(box);
    savedByTarget.set(key, queue);
  }

  const freshTargetCounts = new Map();
  for (const rawBinding of bindings) {
    const key = targetKey(rawBinding);
    freshTargetCounts.set(key, (freshTargetCounts.get(key) ?? 0) + 1);
  }

  const boundEntries = bindings.map((rawBinding, i) => {
    const binding = validateBinding(rawBinding, `freshWireframe.bindings[${i}]`);
    const key = targetKey(binding);
    const queue = savedByTarget.get(key);
    const unambiguous = freshTargetCounts.get(key) === 1 && queue?.length === 1;
    const saved = unambiguous ? queue.shift() : undefined;
    const rect = { ...binding.rect };
    if (saved) {
      for (const key of ['x', 'y', 'w', 'h']) {
        if (Math.round(saved.rect[key]) !== Math.round(saved.binding.rect[key])) rect[key] = saved.rect[key];
      }
    }
    const min = {
      w: Math.min(MIN_SIZE, binding.rect.w),
      h: Math.min(MIN_SIZE, binding.rect.h),
    };
    return {
      savedPosition: saved ? savedPositions.get(saved) : Number.MAX_SAFE_INTEGER,
      freshPosition: i,
      box: {
        id: `wf-${binding.line}-${binding.column}-${i}`,
        order: i,
        label: binding.label || binding.kind,
        description: '',
        type: saved?.type ?? 'obj',
        text: saved?.text ?? '',
        note: saved?.note ?? '',
        deleted: saved?.deleted ?? false,
        origin: 'wireframe-bound',
        binding,
        rect: clampRect(rect, freshCanvas, min),
      },
    };
  });

  for (const queue of savedByTarget.values()) {
    for (const box of queue) {
      if (carriesPendingEdit(box)) {
        const key = targetKey(box.binding);
        warnings.push({
          code: (freshTargetCounts.get(key) ?? 0) > 1 || queue.length > 1
            ? 'ambiguous-edit'
            : 'dropped-edit',
          target: {
            line: box.binding.line,
            kind: box.binding.kind,
            label: box.binding.label || box.binding.kind,
          },
        });
      }
    }
  }

  const userEntries = project.boxes
    .map((box, index) => ({ box, index }))
    .filter(({ box }) => box.origin !== 'wireframe-bound')
    .map(({ box, index }) => ({
      savedPosition: index,
      freshPosition: -1,
      box: asUserBox(box, freshCanvas),
    }));
  const boxes = [...userEntries, ...boundEntries]
    .sort((a, b) => a.savedPosition - b.savedPosition || a.freshPosition - b.freshPosition)
    .map((entry) => entry.box);
  return {
    state: {
      mode: 'iterate',
      canvas: freshCanvas,
      counter: project.counter,
      context: project.context,
      boxes,
      wireframe: {
        version: project.wireframe.version,
        sourceText: project.wireframe.sourceText,
        size: freshCanvas,
      },
    },
    options: project.options,
    warnings,
    fallback: false,
    project,
  };
}

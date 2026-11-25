# Interactive workbench contract

Date: 2026-11-21T19:36:00Z

## Rack edits

Extend `createRackView(root, callbacks)` with:

- `onEditParameter({nodeIndex, name, value})`: commit a final drag/keyboard value;
  returns `Promise<boolean>` (or boolean). `nodeIndex: null` means output gain.
  Drag preview stays local until release; rejected edits restore the project value.
- `onRevealParameter({nodeIndex, name, value})`: materialise a missing default and
  reveal the exact `/nodes/N/params/name` or `/output/gain` field.
- `onReconnect({connectionIndex, end, ref})`: reconnect one cable end; `end` is
  `from` or `to`, `ref` a `node.port`. For output cables use
  `{outputChannel: 'left'|'right', end:'from', ref}`; their destination is fixed.
  Returns `Promise<boolean>`. Invalid/cancelled drops leave the original cable.
- `onError(message)` for gesture/target errors.

Existing callbacks remain. Coordinator commits through one project model and
rebuilds views after successful edits. The component must finish/release its
pointer capture before invoking a callback that may rebuild it. During a drag,
updates are local; callbacks happen on release or keyboard action. Click without
drag invokes precise reveal. Shift enables fine adjustment; Escape cancels.

## Pure edit/model module

New `rack-model.js` exports:

- `MODULES`: existing rack spec objects (inputs, params, outputs, family, title).
- `parameterSpec(type, name, sampleRate)`: `{min,max,default,integer,step,log}` or
  null. Includes inputs/static controls and synthetic `output.gain`.
- `materializeDefaults(project)`: mutates known node params and output gain to
  include every omitted constructor default; preserves explicit values. Returns
  whether anything changed. Does not modify unknown nodes.
- `editParameter(project, {nodeIndex,name,value})`: returns a cloned candidate;
  validates parameter, number/range and node selection, creates params as needed.
- `reconnectProject(project, change)`: returns a cloned candidate; validates
  endpoints/directions, one source/input and DAG (output routes included as refs,
  not dependency nodes). Reject occupied targets and cycles rather than swapping
  other wires. Handles source fan-out by connection index. Existing non-selected
  connections are unchanged.

Sample rate is 8000..96000; model specs mirror DSP. Numeric bounds/steps are for
control editing; waveform/gain/time interaction should be musically useful rather
than full-range numeric jumps. `log` is a hint for frequency/time controls.

## Pop-out panes

`pane-windows.js` exports `createPaneWindows({panes,onLayout,onError,onChange})`.
`panes` is an array of existing top-level details elements. Return
`{popOut(name), dock(name), dockAll(), refresh(), destroy()}`. Name is data-pane.
`onLayout(name)` refreshes a relocated/resized component; `onChange(name,detached)`
announces transitions if useful. Add header buttons and parent placeholders plus
child-window Pop in controls. Move the actual pane content DOM between same-origin
windows, preserving event handlers, inputs, audio and one authoritative project
state. Do not instantiate a second app or second localStorage writer.

Coordinator caches DOM IDs so app updates reach adopted elements, and docks panes
on project changes and parent unload. Pop-up blocking gets a readable message.
Closing a child restores its content. Load stylesheets in child, support keyboard
buttons, multiple independent panes, and cleanup. Owned CSS `pane-windows.css`.

Components must use `root.ownerDocument.defaultView` for pointer gestures and
animation frames after adoption; popup resize triggers onLayout. App callbacks
continue to run in the parent. Score view window/observer lifecycle is adjusted
by the pane-window implementer; rack implementer handles its own relocation.

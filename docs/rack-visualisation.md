# Patch rack visualisation

`internal/workbench/static/rack-view.js` exports the native ES-module component
specified in `workbench-components.md`; load `rack-view.css` alongside it.
There are no runtime dependencies or external assets.

```js
const rack = createRackView(root, {
  onStateChange, onReveal, onEditParameter, onRevealParameter, onReconnect, onError,
  onPreviewParameter, onCancelParameter,
});
rack.setProject(project, savedRackState);
rack.refreshLayout(); // after expanding a hidden pane or adopting it into a popup
rack.destroy();
```

## Reading the rack

- Every project node has a hardware-style faceplate, identifying index, function
  icon, documented input/output jacks, and configured/default values. Icons have
  accessible labels. Native buttons support keyboard selection and JSON reveal.
- Ports/defaults and editable ranges come from `rack-model.js` exports `MODULES`
  and `parameterSpec`. Explicit zero stays zero. Unknown types/ports in
  incomplete drafts remain visible and unresolved routes are listed below.
- Dials edit project parameters; they are not live audio telemetry.
  `SET` is a supplied parameter; `DEFAULT`/`DEF` is an omitted constructor value;
  `PATCHED · base`/`PATCH` means a cable replaces the shown base value at render
  time. Signal/gate/reset inputs show their base values at the jacks. Hover/focus
  titles explain exact values and connection endpoints. Static parameters also
  appear, including envelope times, wavetable bits and noise register mode.
  Materialized `in/a/b/c/d/gate/trigger/reset` values remain compact jack displays,
  rather than adding redundant DC knobs. Clicking an input jack reveals that
  exact base parameter; stereo destination jacks reveal `/output/left|right`.
- Mixers have dedicated A/B/C/D gain knobs, four named input jacks and an explicit
  summed output formula. There are no animated or simulated signal meters.
- The output faceplate represents the project's actual `output.left`,
  `output.right` and `output.gain`. Its two physical cables are additional to the
  `connections` array. Omitted output gain displays zero, matching Go decoding.
- Cable colors identify audio, pitch, gate/trigger, control, left and right.
  SVG cables join measured jack centers, with hanging curves and subtle shadows.
  Each valid connection is drawn, including fan-out and cross-row connections.
  Missing endpoints remain in the unresolved-route list rather than acquiring
  fabricated destinations.

## Navigation and persistence

Track sections derive from actual downstream reachability from sequence nodes.
Unsequenced sources inherit the tracks they feed (for example shared drum noise
and a filter LFO); multi-track buses and disconnected modules use the shared
section. Node names are not used to infer ownership.

Track focus and module/type search dim unrelated modules and routes; neither
removes patch topology. Track focus jumps to the first associated module.
Selection emphasizes directly connected neighbors and cables. The inspector
  lists every incoming/outgoing route as a keyboard-accessible cable selection button.
Escape or **Clear selection** clears selection. **Reset view** clears focus,
query and selection and restores the initial zoom/scroll position.

State is emitted as partial updates through `onStateChange`:

| Key | Meaning / default |
| --- | --- |
| `zoom` | One of `0.5, 0.65, 0.8, 1, 1.2, 1.5`; default `0.8` |
| `track` | Track ID to focus; default empty |
| `query` | Module ID/type text search; default empty |
| `selected` | `node:INDEX` or `$rack-output`; default empty |
| `scrollLeft`, `scrollTop` | Internal horizontal scroll position in CSS pixels; legacy `scrollTop` is ignored |

The caller persists these under the project UUID. The component never mutates
the supplied project or state. Faceplates reveal `/nodes/INDEX`; the output
faceplate reveals `/output`. Selecting a cable exposes its exact JSON reveal
button (`/connections/INDEX` or `/output/left|right`).

Each group uses `repeat(auto-fit, minmax(210px, 1fr))`: fractional modules fill
the pane width, with no eight-column cap or empty reserved columns. All module
rows contribute to the rack's full height; the page/window scrolls vertically.
Only a pane narrower than a single zoomed module plus rails scrolls horizontally.
SVG layout is recalculated on resize, zoom and `refreshLayout()`. Hidden initial
renders are supported. Adoption refresh rebinds the resize observer, resize
listener and animation frames to `root.ownerDocument.defaultView`. Gestures and
drop hit-testing resolve the current window/document. `destroy()` cancels active
gestures, disconnects observers, removes listeners and cancels pending frames.

## Editing parameters and cables

- Drag a dial vertically to preview locally. Up increases; down decreases. Shift
  makes movement ten times finer. Arrow keys commit useful increments (Shift fine
  for non-integer values). Frequency/time use proportional steps; integer knobs
  and noise mode are quantized and every edit is clamped to the model bounds.
- Release commits once through `onEditParameter({nodeIndex,name,value})`; output
  gain uses `nodeIndex: null`. The callback returns a boolean or promise. Rejected
  edits restore the previous displayed value; successful coordinator edits may
  immediately call `setProject`. No project objects are changed during preview.
- `onPreviewParameter({nodeIndex,name,value})` receives the latest pointer-drag
  value at most once per animation frame in the current owner window. This is
  an audio-only preview hook: do not persist source or rebuild the rack from it.
  Release drops any queued preview before the single final commit. Clicks and
  keyboard edits do not emit preview callbacks.
- `onCancelParameter({nodeIndex,name,value})` receives the original value after
  cancellation or a rejected/throwing commit, so the coordinator can restore
  previewed audio. A drag returning to its original value also restores without
  committing. All queued preview callbacks are invalidated before cancel/commit,
  and capture is released before cancellation callbacks. Promise rejections from
  preview/cancel hooks are reported through `onError`.
- A click without dragging (or Enter/Space) calls only
  `onRevealParameter({nodeIndex,name,value})`. The coordinator materializes an
  omitted default and reveals its exact parameter JSON field, never a generic
  node selection. Patched inputs still edit the base value, explicitly labelled.
- Click a cable curve, select a connected jack, or use the inspector's **Select
  cable** list. The selected cable has draggable plugs and is raised above other
  wires. Select the particular cable first to disambiguate source fan-out; a jack
  with only one cable can be dragged directly. Source plugs drop on output jacks;
  destinations drop on unoccupied input jacks. Compatible targets have a dashed
  green outline; the hovered target has a bright solid outline.
- Release invokes `onReconnect({connectionIndex,end,ref})`, where `end` is `from`
  or `to`. Stereo routes expose only their source plug and instead use
  `{outputChannel:'left'|'right',end:'from',ref}`. The coordinator validates cycles
  and commits; highlighting checks port direction and occupancy, not graph cycles.
  The original wire is restored before the callback; accepted edits redraw from
  the coordinator's project. Invalid/rejected drops never alter another cable.
- Escape, pointer cancellation, lost capture, window blur, project replacement
  and destruction cancel a gesture. Capture and gesture listeners are released
  before callbacks that can rebuild the DOM. Invalid drops and thrown callback
  errors are reported through `onError`. Rewiring requires a pointer; cable
  selection/reveal and dial edits also support the keyboard. There is no automatic
  edge-scroll while dragging across a long rack.

Useful integration selectors: `.rack-view`, `.rack-toolbar`, `.rack-viewport`,
`.rack-module[data-node-key="node:0"]`, `[data-module-type="mixer"]`,
`.rack-jack[data-direction="input"][data-port="gain"]`, `.rack-cable`, and
`.rack-family-output`. Controls have labels **Focus track**, **Find rack module**,
and **Rack zoom**. Project text uses DOM text APIs, never HTML interpolation.

## Verification

Run the focused browser checks using an existing Playwright installation:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chrome \
node --test internal/workbench/static/rack-view.browser.mjs
```

The `.browser.mjs` name intentionally excludes these optional checks from the
dependency-free `*.test.mjs` suite. `PLAYWRIGHT_MODULE` is dynamically imported
and can point at an installation outside this repository. Both variables are
optional when Playwright and its default browser are already
available. On Linux, use a short `TMPDIR` path (or a short symlink to a longer
temporary directory) if Chromium hits its Unix socket path-length limit.
`RACK_SCREENSHOT_DIR` optionally writes fixture screenshots.

Checks cover the real 49-/75-node examples, every cable and stereo output route,
jack/cable geometry, mixer defaults, immutable input, keyboard reveal, track
focus including shared noise, zoom persistence, hidden-pane expansion, mobile
overflow, cleanup, explicit zero, malformed drafts and HTML-like node names.
Interaction checks cover throttled previews, cancelled-preview restoration and
pending-frame invalidation, exact field reveal, rejected edits,
Shift sensitivity, integer/output controls, capture release before synchronous
rebuild, fan-out endpoint selection, occupied/escaped drops, stereo rewiring,
fractional width/full height and actual DOM adoption with popup dial/cable gestures.
They load an isolated browser document and do not restart or modify the preview.

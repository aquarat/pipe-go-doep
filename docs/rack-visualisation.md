# Patch rack visualisation

`internal/workbench/static/rack-view.js` exports the native ES-module component
specified in `workbench-components.md`; load `rack-view.css` alongside it.
There are no runtime dependencies or external assets.

```js
const rack = createRackView(root, {
  onStateChange, onReveal, onEditParameter, onRevealParameter, onReconnect, onError,
  onPreviewParameter, onCancelParameter,
  scopeScreen, onProbe, // optional oscilloscope faceplate (see below)
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
  `PATCHED`/`PATCH` means a cable replaces the shown base value at render
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
  A cable's click target stops about 26 px short of each plug, so the jack under
  a cable end stays clickable and draggable.
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
| `selected` | `node:INDEX`, `$rack-output` or (with a scope) `$rack-scope`; default empty |
| `scrollLeft`, `scrollTop` | Internal horizontal scroll position in CSS pixels; legacy `scrollTop` is ignored |

The caller persists these under the project UUID. The component never mutates
the supplied project or state. Faceplates reveal `/nodes/INDEX`; the output
faceplate reveals `/output`. Selecting a cable exposes its exact JSON reveal
button (`/connections/INDEX` or `/output/left|right`).

## Compact faceplates

Faceplates have Eurorack-style widths: 1 HP is 15 CSS px and `arrangeModule()`
(exported for tests) picks the narrowest grid of 44 px cells that fits a
module's dials and jacks in about three rows (sequencer display counts as one).
A VCA or lowpass is 7 HP (105 px), an oscillator with duty or an ADSR 10 HP,
a mixer 13 HP. Each card carries `data-hp` and `width = hp × 15px`; cards never
stretch. Dials are balanced over rows (four dials in three columns become 2 + 2).
Jacks sit in a grid with the port name and base value above the ring, so
hanging cables do not cover their own label. Outputs share a dark inset plate,
bottom-aligned with the last input row. Faceplates in a line share its height.

Module rows and track sections are flex-wrapped: a section takes the width of
its modules, and sections sit side by side when the pane is wide enough
(otherwise each takes a line and its modules wrap). The real examples are about
2.1-2.3 times shorter than the old fixed 210 × 350 px cells at the same width.
All module rows contribute to the rack's full height; the page/window scrolls
vertically. Only a pane narrower than the widest zoomed faceplate plus rails
scrolls horizontally.

SVG layout (cables join the measured centres of jack rings, whatever the
faceplate layout) is recalculated on resize, zoom and `refreshLayout()`. Hidden initial
renders are supported. Adoption refresh rebinds the resize observer, resize
listener and animation frames to `root.ownerDocument.defaultView`. Gestures and
drop hit-testing resolve the current window/document. `destroy()` cancels active
gestures, disconnects observers, removes listeners and cancels pending frames.

## Cable labels

Every drawn cable (patch, stereo output and probe) carries a label on an SVG
`textPath` following its curve, for example
`out lead [Pulse oscillator] → in lead_filter [Low-pass]`,
`out mix [Four-channel mixer] → L [Stereo output]` or
`out lead [Pulse oscillator] → Y1 [Oscilloscope]`: port, node id and the module
title from `MODULES` (text before ` · `) at each end. Right-to-left cables use a
reversed label path, so text is never upside down. Labels are measured and fit
to the cable length minus 13 px at each end: the full caption, else the short
form (`out lead → in lead_filter`), else hidden (`data-fit` is `full`, `short`
or `hidden`). The along-path offset is staggered between cables to reduce
overlaps. Labels have a dark halo (`paint-order: stroke`), never take pointer
events, dim with their cable and reach full opacity on a selected or hovered
cable.

## Oscilloscope faceplate and probe cables

Passing `scopeScreen` (an element, normally the scope view's host) adds a 24 HP
**Oscilloscope** faceplate (`data-node-key="$rack-scope"`,
`.rack-family-scope`) first in the first rack section. The same element is
moved into `.rack-scope-screen` on every render, so its canvas and history
survive rebuilds and pane adoption. The slot is unstyled apart from full width
(about 344 px) and `--scope-screen-max-height: 190px` for the scope view's
screen. The faceplate's height sets the height of the first line of faceplates. Without `scopeScreen` there is no faceplate and no probe
cables, even when the project has `_ui.scope`.

Inputs X and Y1-Y4 (`.rack-scope-jack[data-channel="x|y1|…"]`) use the channel
colours X white, Y1 yellow, Y2 cyan, Y3 magenta, Y4 green. X is annotated
`XY mode` while `_ui.scope.mode` is `yt`. Each jack shows what it probes.

Probe cables come from `project._ui.scope.inputs` (see `docs/scope-contract.md`):
dashed, in the channel colour, from the probed module jack (input or output
side) or the stereo output faceplate's L/R jack to the scope jack. Probed module
jacks get a ring in the channel colour. References to missing nodes or ports
are not drawn: the scope jack reads `unresolved`, and the inspector lists them
under **Incomplete routing** with an **Unplug** button. The summary counts
probes and unresolved probes. Selecting the scope faceplate lists all five
channels.

Gestures (pointer):

- Drag from a scope jack onto any highlighted module or output jack (yellow
  dashed outlines; a ghost cable follows the pointer). An already patched jack
  moves its existing cable.
- Click a patched scope jack (or a probe cable) to select the probe; drag its
  module plug to another jack.
- Drop on empty space, press **Unplug Y1** in the inspector, or press
  Delete/Backspace with the probe cable selected (not while typing) to unplug.
- Escape cancels. Dropping back on the same jack does nothing.

Commits go through `onProbe({channel, ref})` where `ref` is
`{node, port, direction: 'input'|'output'}`, `{bus: 'left'|'right'}` or `null`
to unplug. The callback returns a boolean or promise (rejections reach
`onError`). The component never mutates `project`; the coordinator updates
`_ui.scope` and calls `setProject`. Probe cables are never `onReconnect` changes.

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
`.rack-jack[data-direction="input"][data-port="gain"]`, `.rack-cable`,
`.rack-cable.is-probe[data-channel="y1"]`, `.rack-cable-label`, `.rack-scope-screen`,
`.rack-scope-jack[data-channel="x"]` and `.rack-family-output`. Controls have labels **Focus track**, **Find rack module**,
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
HP widths/full height and actual DOM adoption with popup dial/cable gestures.
Further checks cover compact widths and heights against the old fixed cells,
cable endpoints inside jack rings at 50/80/150% zoom, cable labels (present on
every cable, upright, fitted, staggered, pointer-transparent, selection and dim
opacity), the scope faceplate (first, wider, the same screen element after
rebuilds, XY annotation, dashed probe cables and exact endpoints, unresolved
probes) and real pointer drags for probe patch, bus probe, repatch, unplug by
empty drop/button/Delete and Escape.
They load an isolated browser document and do not restart or modify the preview.

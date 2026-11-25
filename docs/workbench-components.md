# Visual workbench component contract

Date: 2026-11-21T19:00:00Z

The browser UI is split into dependency-free native ES modules under
`internal/workbench/static/`, served at `/static/` and embedded in the Go binary.
The app coordinator owns the document, render/playback, JSON tree and pane state.
Components never mutate the supplied project and use DOM text APIs for project data.

## Identity and state

Project JSON gains optional top-level `id` (UUID) and `_ui` metadata with
`tree_expanded: string[]` containing JSON Pointer paths. The empty string denotes
the root. Missing paths are collapsed by default. The UI gives legacy projects a
UUID on opening; the Go parser still accepts old documents without identity.
Project metadata does not affect sound. Per-project browser state holds pane
visibility and component-specific views, stored under the document UUID.

## Score module

`score-view.js` exports:

```js
export function createScoreView(root, { onStateChange, onReveal, onSeek }) {
  return { setProject(project, state = {}), setTime(seconds), refreshLayout(), destroy() };
}
```

`onStateChange(partialState)` persists only this component's view state.
`onReveal(jsonPointer)` selects corresponding data in the JSON tree.
`onSeek(seconds)` requests audio seek. Time is seconds from the start of the score.
`setProject` must work when the pane is hidden; `refreshLayout` runs on expansion.
Own scoped stylesheet `score-view.css`. Present a tracker view plus piano-roll
visualisations per track, matching pattern orders, transpose, note gates, rests and
score musical end. All DOM and listeners belong beneath `root` (global resize
observers/listeners must be cleaned in destroy). No third-party assets/dependencies.

## Rack module

`rack-view.js` exports:

```js
export function createRackView(root, { onStateChange, onReveal }) {
  return { setProject(project, state = {}), refreshLayout(), destroy() };
}
```

Same state/reveal semantics as score. Own `rack-view.css`. A Reason/Eurorack-inspired
hardware rack: clear faceplates, parameter values/knobs, named input/output jacks,
actual cables from project connections, useful focus/selection/zoom. Parameter and
endpoint editing callbacks are specified in the subsequent
[interactive workbench contract](interactive-workbench-contract.md). Module/port
selection can reveal source in JSON. Include stereo output stage. CSS/SVG/Canvas is sufficient;
maintain crisp text, accessible controls, and no external runtime libraries.

## Shared styling

The app defines dark theme variables `--bg`, `--panel`, `--line`, `--ink`,
`--muted`, `--accent` (lime), `--blue` and `--orange`. Components should scope all
CSS under `.score-view` or `.rack-view` and add that class to their root. The app
supplies pane headings, collapse controls and a full-width content root. Component
state defaults must be safe for malformed/incomplete documents while editing.

Pane content can move into a same-origin window. Resolve the root's current
ownerDocument/defaultView for pointer handling, geometry and animation frames;
`refreshLayout` is called after relocation and popup resize. The main app keeps
stable element references and remains the only project/draft authority.

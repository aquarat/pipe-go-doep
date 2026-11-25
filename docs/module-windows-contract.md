# Rack module windows and workspace layout: integration contract

Date: 2026-11-25 (UTC)

A rack module (including the oscilloscope) can be popped out into its own
same-origin window. A stub stays in the rack so cables still connect, and both
the window and the stub can pop the module back in. Pane and module pop-outs and
their window geometry persist per project and are restored on reload.

## Components

- Windows: new `static/detached-window.js`, new `static/module-windows.js`,
  `static/pane-windows.js` (refactor onto `detached-window.js`), `pane-windows.css`,
  `docs/pane-windows.md`, tests.
- Rack: `static/rack-view.js`/`.css`, and only the layout rules needed for a
  window-filling scope in `static/scope-view.css`/`.js`, `docs/rack-visualisation.md`, tests.
- App coordinator: `app.js`, `index.html`, `workbench.css`, persistence, restore
  UI, integration tests, overall docs.

## Window geometry

`{ left, top, width, height }`: `left`/`top` are `screenX`/`screenY`;
`width`/`height` are `innerWidth`/`innerHeight` (CSS px). Open windows with
`popup=yes,resizable=yes,scrollbars=yes,left=…,top=…,width=…,height=…` when a
geometry is given, otherwise with a sensible default size per kind. Report
changes after `resize` (debounced) and from a ~1 s position poll (there is no
move event), and once more just before the child closes.

## `detached-window.js`

`openDetachedWindow({ opener, title, bodyClass, geometry, defaultSize, onClose, onGeometry, onLayout, onError })`
must be called synchronously inside a user gesture (or on load, where it succeeds
only if the site may open pop-ups). It returns `null` when blocked, otherwise
`{ window, document, header, content, close(), focus() }`: copies the opener's
stylesheets (never scripts), builds a header (title + slot for buttons) and a
content element that fills the remaining window height. `onClose(reason)` fires
once: `reason` is `'user'` when the child window was closed by the user, `'api'`
for `close()`, `'opener'` when the opener is unloading (reload or navigation;
**do not** treat this as a layout change). `onLayout()` after resize and once
stylesheets load.

## `pane-windows.js`

Existing API is unchanged, plus:

- `popOut(name, geometry?)`.
- `onChange(name, detached, geometry, reason)`: called on pop out/in and with
  updated geometry while detached. `reason` passes through from `onClose`.
- `isDetached(name)`.

## `module-windows.js`

`createModuleWindows({ opener, onChange, onLayout, onError })` returns:

- `popOut(id, { title, geometry }) → HTMLElement | null`: opens (or focuses) the
  window for module `id` (node id, or `$scope` for the oscilloscope) and returns
  its host element (content area, class `module-window-host`, filling the window).
  The header has a **Pop in** button that calls `dock(id)`.
- `dock(id)`, `dockAll()`, `host(id)`, `ids()`, `isOpen(id)`, `destroy()`.
- `onChange(id, open, geometry, reason)` as for panes; `onLayout(id)` after
  resize/style load. A closed child (user closes it) docks the module.

Module windows are always opened by the main window, even while the rack pane is
itself popped out.

## Rack

`createRackView(root, {..., onPopOutModule(id), onPopInModule(id)})` and
`rackView.setDetached(map)` where `map` is `Map<id, HTMLElement>` of open module
windows' host elements (ids: node id or `$scope`).

- Each module head (and the scope faceplate) has a small pop-out control that
  calls `onPopOutModule(id)` synchronously in the click handler.
- On render, a detached module's full faceplate is rendered into its host element
  (controls, dials, readouts and jacks work there; gestures must use the event
  target's own window), and a compact **stub** takes its place in the rack: id,
  type, a "In window" indicator, **Focus** and **Pop in** buttons, and the same
  jacks. Rack cables, probe cables, labels, selection, reconnection and probing
  attach to the stub jacks. The scope screen element moves to its window.
- A popped faceplate fills and resizes with its window: controls reflow and
  scale up to use the space; the oscilloscope screen grows to fill the window
  height and width.
- `setDetached` re-renders; ids missing from the project are ignored.

## Persistence (coordinator)

Per project browser state `windows`:

```json
{ "panes": { "rack": { "left": 40, "top": 60, "width": 1200, "height": 850 } },
  "modules": { "melody_osc": { "left": 900, "top": 80, "width": 360, "height": 520 },
               "$scope": { "left": 1300, "top": 80, "width": 800, "height": 600 } } }
```

An entry exists while that pane/module is popped out, its geometry kept current.
Pop in or user close removes it; opener unload does not. On project open, try to
reopen saved windows; any blocked by the browser are listed by a **Restore
windows** button that opens the next one per click (browsers allow one pop-up per
gesture). Entries for modules that no longer exist are dropped.

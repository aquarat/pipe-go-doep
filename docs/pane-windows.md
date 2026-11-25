# Pane windows

`internal/workbench/static/pane-windows.js` moves the existing non-summary
children of a top-level `<details data-pane="…">` into a same-origin popup.
Node identity, DOM listeners, input values and the parent's application model
remain intact. No app scripts or storage writers are started in the child.
The window itself comes from `detached-window.js` (below), which rack module
windows (`docs/module-windows.md`) share.

## Coordinator integration

Load `pane-windows.css` after the component stylesheets in the main page. It
also holds the shared detached-window and module-window rules. Cache element
references before creating the coordinator: parent `getElementById()` cannot
find nodes while they belong to a child document.

```js
import { createPaneWindows } from './pane-windows.js';

const paneWindows = createPaneWindows({
  panes: [...document.querySelectorAll('.workspace > details[data-pane]')],
  onLayout(name) {
    if (name === 'score') scoreView.refreshLayout();
    if (name === 'rack') rackView.refreshLayout();
  },
  onError(message) { showStatus(message); },
  onChange(name, detached, geometry, reason) { /* Persist window layout. */ },
});
```

The returned API is `{ popOut, dock, dockAll, refresh, isDetached, destroy }`:

- `popOut(name, geometry?)` opens synchronously from a user gesture (or on load,
  where it succeeds only if the site may open pop-ups) and returns success as a
  boolean. `geometry` is `{ left, top, width, height }` (see below); without it
  the window opens at 1200×850. An already detached pane is focused. Blocked
  popups report a readable error without changing the pane, its collapse state
  or its content.
- `dock(name)` returns whether a child was docked. Main-summary, parent-placeholder
  and child-header buttons all use this same operation.
- `dockAll()` restores all panes and closes their children. Call this before
  switching projects or replacing top-level pane content.
- `refresh()` invokes layout for each pane and reconciles closed children.
- `isDetached(name)` is true while the pane is in its own window.
- `destroy()` docks all panes and removes controls, listeners and queued frames;
  repeated calls are harmless. Destroy components after the coordinator.

`onChange(name, detached, geometry, reason)`:

| Call | `detached` | `geometry` | `reason` |
| --- | --- | --- | --- |
| Popped out | `true` | current window geometry | `undefined` |
| Moved or resized while detached | `true` | new geometry | `undefined` |
| Pop in button, `dock()`, `dockAll()`, `destroy()` | `false` | last geometry | `'api'` |
| User closed the child window | `false` | last geometry | `'user'` |
| Main page reloading or navigating | `false` | last geometry | `'opener'` |

Treat `'opener'` as "the app is going away", not as a layout change: keep the
saved window so it can be reopened on the next load. The opener check runs in
capture-phase `pagehide`/`beforeunload` listeners, so it happens before the
app's own unload handlers; a later `dockAll()` there is a no-op.

Summary buttons prevent default click behavior and stop propagation, retaining
native Enter/Space activation. Clicking the rest of the summary still toggles
the original `<details>`. Detachment does not force it open or closed.

## Detached windows (`detached-window.js`)

```js
import { openDetachedWindow } from './detached-window.js';

const handle = openDetachedWindow({
  opener: window, title: 'Rack', bodyClass: 'pane-window',
  geometry: { left: 40, top: 60, width: 1200, height: 850 }, // or null
  defaultSize: { width: 1200, height: 850 },
  onClose(reason) {},     // 'user' | 'api' | 'opener', exactly once
  onGeometry(geometry) {},
  onLayout() {},
  onError(message) {},
});
// null when blocked; otherwise
// { window, document, header, title, actions, content, closed, geometry(), close(), focus() }
```

- Geometry is `{ left, top, width, height }`: `left`/`top` are `screenX`/
  `screenY`, `width`/`height` are `innerWidth`/`innerHeight` in CSS px. The
  window opens with `popup=yes,resizable=yes,scrollbars=yes,left=…,top=…,width=…,height=…`
  (`left`/`top` omitted when the geometry has none; `defaultSize` when no usable
  geometry is given). `normalizeGeometry()` and `windowFeatures()` are exported.
- `onGeometry` fires after a resize (debounced 200 ms), from a 1 s position
  poll (there is no move event) and once more just before the child closes. It
  only fires when something changed; `handle.geometry()` reads the current
  value at any time.
- `onClose(reason)` runs while the child document is still alive, so callers
  can move their nodes back out; the window is closed afterwards. `'user'`
  covers the child's `pagehide`/`beforeunload` and a child found closed by the
  poll; `'api'` is `handle.close()`; `'opener'` is the opener's
  `pagehide`/`beforeunload`. All listeners, timers and frames are removed first.
- `onLayout` fires once the copied stylesheets have loaded and on resize (one
  call per child animation frame).
- `onError` receives stylesheet load failures and window preparation errors
  (`openDetachedWindow` then returns `null`). A plain blocked pop-up returns
  `null` without calling `onError`, so callers word that message themselves.

## Child structure and lifecycle

```text
html (parent language/classes)
  head
    title (text only), viewport meta
    copies of the parent's stylesheet links and style elements
  body.detached-window.pane-window (plus the parent's body classes)
    header.detached-window-header.pane-window-header
      h1.detached-window-title.pane-window-title
      div.detached-window-actions
        button: Pop in
    main.detached-window-content.pane-window-main   [scrollable remaining window height]
      section.pane-window-content[data-pane]  [original pane classes]
        actual adopted content nodes     [original IDs, events and values]
```

The parent keeps its original summary, small sibling-position comments, and a
`.pane-window-placeholder` with a Pop in button. Docking restores original
sibling order and includes content added to the child container. All headings
use `textContent`; no project text is passed through `document.write` or HTML
parsing. Child markup contains no duplicate app or component instance.

`onLayout(name)` runs immediately after adoption so components can rebind their
host, again on its next animation frame, after linked stylesheets settle, and
on child resize. Components must measure their current owner document. The score
view cancels old-window frames, rebinds resize/visibility listeners and its
ResizeObserver, and reads DPR/styles/rAF from its current host. Hidden documents
do not schedule score draws. Musical timeline logic is unchanged.

The child main region scrolls the natural content height. The rack's measured
spacer retains the full rack height instead of inheriting a fixed 72vh viewport;
its horizontal overflow remains accessible. Child close/navigation docks content
(`reason: 'user'`); parent unload docks and closes every child
(`reason: 'opener'`). Explicit docking removes the window's listeners before
closing it, avoiding reentrant transitions. Pending frames and
stylesheet/button/resize listeners are cleaned up. Media elements keep their
identity, position and play state; failed browser playback resumption is
reported via `onError`.

## Browser verification

Use an existing external Playwright installation; no project dependency install
or running workbench server is needed. Tests serve the current source files on
an ephemeral loopback port.

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_PATH=/path/to/chrome \
node --test internal/workbench/static/pane-windows.browser.mjs \
  internal/workbench/static/module-windows.browser.mjs \
  internal/workbench/static/score-view.test.mjs
```

The pane scenarios cover actual-node identity and retained controls,
keyboard/summary behavior, delayed CSS layout, full rack scrolling, independent
children, close/pop-in/dockAll/destroy, blocked popups, current-window score
frames/DPR/resize, active audio adoption, parent-close cleanup, `popOut`
geometry and its `window.open` features, `isDetached`, geometry updates, and the
`'user'`, `'api'` and `'opener'` reasons. `module-windows.browser.mjs` covers
`detached-window.js` (requested and default geometry, resize reports, content
filling the window, every close reason exactly once with a final geometry
report, timers stopping) and module windows.

Do not use `page.route()`/`context.route()` in pop-up tests: intercepted
requests stop pop-up windows loading their copied stylesheets. The test servers
close their open connections on teardown (media streams otherwise keep
`server.close()` waiting). Clicking a Pop in button closes its own window, which
can race Playwright's action bookkeeping; the tests tolerate that "closed"
error. On Linux, Chromium's socket path requires a short `TMPDIR`; a short
symlink to a longer temporary directory works without relocating test artifacts.

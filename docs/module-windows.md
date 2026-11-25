# Rack module windows

`internal/workbench/static/module-windows.js` opens one same-origin window per
rack module (node id) or for the oscilloscope (`$scope`, exported as
`SCOPE_MODULE_ID`). It owns only the windows: the rack renders the module's
faceplate into the returned host element and leaves a stub in the rack. Windows
come from `detached-window.js` (see `docs/pane-windows.md`), so geometry and
close reasons behave exactly as for panes. Styles live in `pane-windows.css`.

Module windows are always opened by the main window, even while the rack pane
is itself popped out.

```js
import { createModuleWindows } from './module-windows.js';

const moduleWindows = createModuleWindows({
  opener: window,
  onChange(id, open, geometry, reason) {
    rackView.setDetached(new Map(moduleWindows.ids().map(id => [id, moduleWindows.host(id)])));
    /* Persist geometry; on close drop the entry unless reason === 'opener'. */
  },
  onLayout(id) { rackView.refreshLayout(); },
  onError(message) { showStatus(message); },
});

// Inside the click handler (user gesture):
const host = moduleWindows.popOut(id, { title: `${id} · Oscillator`, geometry });
```

API:

- `popOut(id, { title, geometry }) → HTMLElement | null` opens the window (or
  focuses an open one and returns its existing host). `null` when blocked; a
  readable "Pop-up blocked" message goes to `onError`. Default sizes: 420×560
  for modules, 800×600 for `$scope`.
- `dock(id)` closes the window (`reason: 'api'`), returning whether one was
  open. The header's **Pop in** button calls it.
- `dockAll()`, `destroy()` (docks all, later `popOut` returns `null`).
- `focus(id)`, `host(id)`, `ids()` (open order), `isOpen(id)`, `geometry(id)`.

`onChange(id, open, geometry, reason)` fires with `open: true` after opening
(`reason` undefined) and whenever the geometry changes, and with `open: false`
when the window goes away: `'api'` (dock/Pop in), `'user'` (the user closed the
window: the module docks), or `'opener'` (the main page is reloading or
navigating; keep the saved entry). The close call runs before the child is
closed, while its document is still alive, so the rack can re-render and move
elements such as the scope screen back. `ids()`/`host()` already exclude the
closing module. `onLayout(id)` fires once the window's stylesheets have loaded
and after resizes.

## Window structure

```text
body.detached-window.module-window
  header.detached-window-header            [compact: 4px 8px padding, 12px title]
    h1.detached-window-title               [title, ellipsised]
    div.detached-window-actions
      button.detached-window-button.module-window-pop-in   Pop in
  main.detached-window-content.module-window-host[data-module=id]
    …faceplate rendered by the rack…
```

The host fills the window below the header (`flex: 1 1 auto; min-height: 0`)
and is itself a flex column that scrolls when its content overflows. Its
children are given `flex: 1 1 auto; min-height: 0; min-width: 0`, so a single
faceplate root fills the window and resizes with it; the rack decides how the
controls inside reflow. Gestures inside the host must use the event target's
own window (`event.target.ownerDocument.defaultView`).

Browser tests: `internal/workbench/static/module-windows.browser.mjs` (see
`docs/pane-windows.md` for how to run them).

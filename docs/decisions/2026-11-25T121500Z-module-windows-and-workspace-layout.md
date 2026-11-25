# Rack module windows and workspace layout

Date: 2026-11-25T12:15:00Z
Status: accepted

## Context

The maintainer asked for individual rack modules (like the oscilloscope) to pop
out into their own resizable windows, with a stub left in the rack so cables still
connect, pop-in from either the window or the stub, and the pop-out layout and
window positions restored when the workspace is reloaded.

## Decision

Module windows reuse the pane approach: same-origin pop-ups opened by the main
window, with the opener's stylesheets copied in and the real application state
kept in the main window. A shared `detached-window.js` now underpins both pane and
module windows (header, content area, geometry reporting, close reasons).

The rack renders a detached module's full faceplate into its window, scaled to fill
it, and a compact stub in the rack with the same jacks. All cables, probe cables,
labels, selection and repatching attach to the stub; no cables are drawn inside
module windows. Module windows are always opened by the main window, even when the
rack pane is itself popped out. The oscilloscope uses the id `$scope`; the stereo
output cannot be popped out.

Window layout is browser state per project (`windows.panes`, `windows.modules`,
geometry as `screenX`/`screenY` and `innerWidth`/`innerHeight`), not project JSON:
screen positions are specific to one machine's displays. Windows report a close
reason. A user close or pop-in removes the saved entry; closing because the main
page unloads keeps it, so a reload restores the layout.

On project open the workbench tries to reopen saved windows. Browsers normally
block pop-ups that don't follow a click and allow about one per click, so any that
fail are offered by a **Restore windows** toolbar button, one window per click.
Saved entries for modules or panes that no longer exist are pruned.

## Consequences

Restoring a multi-window workspace may take one click per window on browsers that
block pop-ups. Window positions are best effort: browsers may clamp them to the
visible screen. A popped-out module's window closes when its module is deleted or
another project is opened.

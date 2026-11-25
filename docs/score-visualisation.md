# Score visualisation

`internal/workbench/static/score-view.js` is a dependency-free ES module. Load its
scoped `score-view.css` and call the interface in `workbench-components.md`:

```js
const view = createScoreView(root, { onStateChange, onReveal, onSeek, onScrub });
view.setProject(project, savedViewState);
view.setTime(playbackSeconds);
view.refreshLayout(); // after expanding a hidden pane
view.destroy();
```

## Reading the score

- Every track has an ordered mini piano roll. Pattern headers show **occurrence
  number and name**: repeated uses of a pattern have distinct absolute positions.
- Track controls select the tracker; the arrow beside a track reveals its JSON.
  Transpose is displayed in semitones; rolls show transposed pitch, while the
  tracker shows both written and played pitch.
- Solid note length is the quantised gate duration. A faint extension shows the
  remaining step duration; brightness indicates velocity. Rest and zero-gate
  steps are dotted. Zero-velocity notes retain their scheduled gate.
- Orange `END` marks the document musical end. Later arrangement content is
  shaded but remains inspectable. A short order is never implicitly repeated.
- Ruler labels are **bar numbers using four-beat visual guides**. The format has
  no time-signature field: these guides do not change playback. Tracker positions
  use one-based bar and beat, with fractional beat values.
- Click the ruler to request a seek. Click a pattern header to select its
  occurrence and reveal `/tracks/N/order/M`. Click a note/rest step or tracker row
  to reveal its escaped `/tracks/N/patterns/name/step` JSON Pointer.
- Drag the ruler to scrub. After 3 horizontal pixels, `onScrub(seconds, {phase})`
  emits `start` at the pointer-down position, then `move` at current positions,
  and `end` at release. Times include horizontal scroll and clamp to the musical
  end. A drag does not also call `onSeek`; a plain click calls only `onSeek`.
  Escape, pointer cancellation/lost capture, window blur, host adoption, project
  replacement and destruction emit `cancel` with the pre-gesture ruler time
  (only if scrubbing started). Capture/listeners are released before end/cancel
  callbacks. The coordinator owns audio preview and resume policy.
- The ruler is a focusable ARIA slider. Arrow keys seek one beat (Shift: quarter
  beat), Home seeks zero, End seeks the musical end. Keyboard seeks call only
  `onSeek`. Playback following is suspended during a pointer gesture; gestures
  bind to the current owner window, including adopted popouts.
- Previous/next controls and the occurrence number select exact repeats without
  generating thousands of dropdown options. `Seek here` requests the selected
  occurrence's absolute start; `Source` reveals its pattern.
- Zoom controls pixels per beat; **Fit score** includes the entire ordered
  arrangement, even content after the musical end. Scroll stays inside the pane.
- **Follow** brings the playhead and selected track's current occurrence/row into
  view. Active rows include rests and gate-release portions of steps. End boundaries
  are exclusive: there is no active row in the effect tail or after the order.

## Persisted component state

`onStateChange` receives partial updates with these fields:

| Field | Meaning |
| --- | --- |
| `trackIndex` | Zero-based selected track index. |
| `occurrenceIndex` | Zero-based index in that track's order. |
| `selectedStep` | Zero-based source step selected, or −1. |
| `zoom` | Requested pixels per beat; Fit can use subpixel values. |
| `scrollBeat` | Leftmost arrangement beat, independent of pixel density. |
| `trackerScroll` | Tracker vertical scroll offset in CSS pixels. |
| `trackerLeft` | Tracker horizontal scroll offset in CSS pixels (narrow panes). |
| `arrangementScroll` | Vertical track-stack scroll offset in CSS pixels. |
| `follow` | Whether playback automatically follows the selected track. |

Restore the merged state in `setProject`; invalid indexes and numeric values are
clamped. Initial restoration does not synchronously emit state changes. Projects
are read-only and may be incomplete while editing. No synthetic project IDs or
audio graph changes are made by this component.

## Rendering and limits

The arrangement uses viewport-sized high-DPI canvases (maximum 4096 CSS pixels
wide, pixel ratio capped at 2), rather than a bitmap spanning the entire score.
The scrollable timeline is capped at approximately 180,024 CSS pixels; effective
zoom shrinks when necessary. Track stacks scroll vertically within 580 pixels.
The 300-pixel tracker recycles visible rows, retaining full source step indexes.

Expansion obeys the format's 32-track, 16,384-order and 262,144-expanded-step
bounds. Oversized incomplete input displays a limit notice. At extreme subpixel
density, each lane samples up to approximately 10,000 visible steps across the
entire viewport; zoom in or use the tracker for exact individual steps. Visible
ranges are binary-searched. All tracks remain in their original order.

Gate ends use absolute sample rounding, compensated beat accumulation and the
document musical-end cap. Rendering does not replace server validation. Invalid
pitches are shown as `—`; missing patterns remain selectable empty occurrences.
There are no runtime dependencies, project strings use text APIs, and all event
listeners, animation requests and the resize observer are cleaned by `destroy`.

Run the focused scheduling tests with:

```sh
node --test internal/workbench/static/score-view.test.mjs
```

Optional real-pointer and popout checks use the same external Playwright setup
as the rack tests: `node --test internal/workbench/static/score-view.browser.mjs`.

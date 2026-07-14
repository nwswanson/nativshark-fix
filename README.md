## Developer report: iPad keyboard stops after flashcard audio

## Problem Summary

On iPadOS, when using a physical keyboard, hardware-keyboard shortcuts frequently stop responding after flashcard audio plays. Audio playback appears to move or drop focus away from the webpage’s expected keyboard target, while the current shortcut implementation only accepts key events directed at `document.body`. As a result, review controls such as `Space`, `R`, and `1/2/3` no longer work until the user taps or clicks the page to restore focus. 

### Root cause

The flashcard keyboard shortcuts only work when the keyboard event’s target is exactly `document.body`.

The bundled `react-keyboard-event-handler` effectively does:

```js
const canHandle =
  event.target === document.body || handleFocusableElements;

if (!canHandle) return false;
```

All three review-page handlers omit `handleFocusableElements`, including:

- `Space`, `1`, `2`, `3` for card review
- `R` for replaying audio
- Archive, edit, undo, delete, and Escape shortcuts

This is visible in the current [keyboard-handler bundle](https://app.nativshark.com/_next/static/chunks/27.4703dc15e6edd3e7aeac.js).

The page tries to maintain this fragile condition by repeatedly calling:

```js
document.activeElement?.blur();
```

It does this when audio buttons are clicked and unconditionally inside the review session’s `componentDidUpdate`. It never focuses a stable review element afterward.

On desktop Chrome, I confirmed that `document.activeElement` remains `BODY` before, during, and after playback, so the problem does not reproduce there. On iPadOS 26, HTML5 audio playback evidently moves or drops the webpage’s keyboard focus. Subsequent events no longer have `document.body` as their target, so the keyboard library silently rejects every shortcut. Clicking the page puts focus back in the document, explaining why the keyboard immediately works again.

### The audio code makes the problem worse

The audio component creates Howler instances with `html5: true`, even though these are short flashcard clips:

```js
getHowlInstance(audioUrl, {
  html5: true,
  preload: "metadata"
});
```

More importantly, its replay/autoplay function calls `unload()` immediately before playing the same Howl:

```js
function cleanUp() {
  howls.forEach(howl => {
    howl.stop();
    howl.off("playerror");
    howl.off("unlock");
    howl.off("end");
    howl.unload();
  });
}

function playAudio() {
  cleanUp();       // destroys every Howl
  firstHowl.play(); // attempts to reuse a destroyed Howl
}
```

Howler documents `unload()` as destroying the Howl object. It should only be called when the component is being disposed, not before playback. Howler also documents `html5: true` mainly for streaming or large audio files; Web Audio is the normal path for short clips. [Howler documentation](https://github.com/goldfire/howler.js/).

The production console is already reporting:

```text
HTML5 Audio pool exhausted, returning potentially locked audio object.
```

When that pool is exhausted, the bundled Howler code probes a newly created `Audio` object by calling:

```js
new Audio().play()
```

That HTMLMediaElement churn is a plausible immediate trigger for the iPadOS 26 focus change.

### Recommended fix

The durable fix is to stop making shortcuts dependent on `document.body`.

Replace the three `react-keyboard-event-handler` instances with one review-level listener using modern `event.key`/`event.code`:

```ts
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="textbox"]';

useEffect(() => {
  function onKeyDown(event: KeyboardEvent) {
    if (!keyboardEnabled || event.repeat || event.isComposing) return;

    const target =
      event.target instanceof Element ? event.target : null;

    // Do not fire review shortcuts while the user is editing text.
    if (target?.closest(EDITABLE_SELECTOR)) return;

    const key =
      event.code === "Space"
        ? "space"
        : event.key.toLowerCase();

    handleReviewShortcut(key, event);
  }

  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}, [keyboardEnabled, handleReviewShortcut]);
```

Also give the review surface a stable focus target:

```tsx
const reviewRootRef = useRef<HTMLDivElement>(null);

const restoreReviewFocus = useCallback(() => {
  requestAnimationFrame(() => {
    reviewRootRef.current?.focus({ preventScroll: true });
  });
}, []);

return (
  <div ref={reviewRootRef} tabIndex={-1}>
    {/* review UI */}
  </div>
);
```

Call `restoreReviewFocus()`:

- When a new card mounts
- When audio begins
- When audio ends or stops
- After closing a modal

Remove the unconditional `document.activeElement.blur()` calls.

### Audio lifecycle correction

Playback and disposal must be separate operations:

```ts
function stopSequence() {
  clearTimeout(sequenceTimer.current);

  howls.forEach(howl => {
    howl.stop();
    // Remove only this component's named listeners.
  });
}

function disposeSequence() {
  stopSequence();
  howls.forEach(howl => howl.unload());
}

function playSequence() {
  stopSequence(); // Do not unload here.
  playHowlsInOrder(howls);
}

useEffect(() => {
  if (shouldAutoplay) playSequence();
  return disposeSequence;
}, [shouldAutoplay, howls]);
```

There should be one owner responsible for unloading each Howl. Currently both the parent audio sequence and child audio button unload the same object.

For these short clips, also test removing `html5: true` so Howler uses Web Audio. That avoids HTMLMediaElement focus/media-session behavior and should eliminate the HTML5 pool warning. If playing through the iOS silent switch is a requirement, keep HTML5 audio but still repair the lifecycle and focus handling.

### Fast hotfix

If a larger keyboard refactor cannot ship immediately:

```tsx
<KeyboardEventHandler
  handleFocusableElements
  ...
/>
```

Apply that to all three handlers, while retaining the existing modal/editing guards. This bypasses the `event.target === document.body` restriction.

I would still add the focusable review root and repair the Howler lifecycle. `handleFocusableElements` alone could cause shortcuts to fire while buttons or text controls are focused.

### Verification checklist

- iPadOS 26 with a hardware keyboard
- Autoplay on both card front and back
- Manual female/male replay buttons
- `Space`, `R`, and `1/2/3` during and after playback
- At least 50 consecutive cards
- No `HTML5 Audio pool exhausted` warnings
- Shortcuts remain disabled inside editors, text fields, and modals
- Test silent-switch behavior if moving from HTML5 Audio to Web Audio

The primary application bug is the body-only keyboard handler. The malformed Howler lifecycle is the audio-side trigger and should be corrected in the same release.

## Tampermonkey proof-of-fix

The accompanying [`nativshark-ipad-keyboard-patch.user.js`](./nativshark-ipad-keyboard-patch.user.js) is a proof-of-concept patch, not the recommended final production architecture. It is designed to demonstrate the diagnosis without rebuilding or deploying the application bundles.

The script runs at `document-start` with `@grant none`, so its media override and event listener are installed in the page's JavaScript context before the review interface starts. Tampermonkey matches the NativShark application domain, but every functional path checks that the current route begins with `/library/flashcards/review`. It does not operate in iframes.

### Safeguard 1: restore the keyboard focus around audio

The script wraps `HTMLMediaElement.prototype.play` while preserving and calling the original browser method. Every media playback request schedules focus recovery:

- Immediately after `play()` is called, in a microtask
- On the next animation frame
- After an 80 ms delay, covering a later iPadOS media-session focus transition
- When the `play()` promise resolves or rejects
- When the media element emits `playing`
- When the media element emits `ended`

This uses several timings deliberately. A single synchronous `focus()` call can run before WebKit finishes changing media or keyboard focus. Repeating the operation at the microtask, rendering, and short-timer boundaries makes the page regain focus after the browser-side transition rather than just before it.

`document.body` is given `tabindex="-1"` only when necessary. That makes it programmatically focusable without adding it to the user's normal Tab sequence. Focus is restored with:

```js
document.body.focus({ preventScroll: true });
```

The patch will not move focus if the active element is an input, textarea, select, content-editable region, or ARIA textbox. This prevents autoplay from pulling focus away while someone is editing text.

This safeguard recreates the condition expected by the existing keyboard library: subsequent hardware-key events should once again have `document.body` as their target.

### Safeguard 2: rescue a shortcut even if iPadOS moves focus again

Focus restoration alone is still timing-dependent. Therefore the script also installs a capture-phase `keydown` listener on `window`. Capture phase lets the patch inspect the event before the existing React keyboard handlers reject it.

When a recognized review shortcut arrives with a target other than `document.body`, the script:

1. Confirms the event is on the flashcard review route.
2. Ignores events originating inside editable or text-entry controls.
3. Restricts handling to the application's known shortcuts: `Space`, `1`, `2`, `3`, `R`, `A`, `E`, `Escape`, `Cmd/Ctrl+Z`, and `Cmd/Ctrl+D`.
4. Creates an equivalent bubbling `KeyboardEvent` and dispatches it from `document.body`.
5. Supplies compatibility getters for `which`, `keyCode`, and `charCode`, because the bundled keyboard package still reads those deprecated numeric properties.
6. Stops the stranded original event after the body-targeted replacement has been dispatched, preventing duplicate shortcut handling.

A `WeakSet` marks replacement events so the capture listener cannot recursively redispatch its own event. If the application's handler calls `preventDefault()` on the replacement, the patch mirrors that state onto the original event.

The important point is that the userscript does not implement the flashcard actions itself. It routes the real shortcut back through NativShark's existing React handlers. Card grading, replay, archive, edit, undo, delete, modal guards, and application state continue to be owned by the application.

### Why this demonstrates the diagnosis

The production handler has two relevant inputs: the pressed key and `event.target`. Before audio disrupts focus, the key event targets `BODY` and is accepted. After the disruption, the same key targets another element or an unfocused browser context and is rejected. The userscript changes only that failing condition:

```text
Original event:    R key → target BUTTON/non-BODY → production handler rejects it
Patched event:     R key → redispatched from BODY → production handler plays audio
```

The patch therefore provides an A/B test of the root-cause claim. It does not replace the audio player or directly call the replay function. If replay resumes solely after the event is retargeted to `BODY`, the body's identity check—not the key mapping or review state—is what prevented the shortcut.

### Built-in instrumentation

The userscript exposes a read-only debugging API at `window.__NSKeyboardPatch`:

```js
window.__NSKeyboardPatch.getState()
window.__NSKeyboardPatch.runSelfTest()
window.__NSKeyboardPatch.beginReplayProof()
window.__NSKeyboardPatch.finishReplayProof()
window.__NSKeyboardPatch.restoreFocus()
window.__NSKeyboardPatch.uninstall()
```

`getState()` reports the installed version, current active element, whether the body is active, media `play()` calls, focus-restoration attempts and successes, rescued-key count, last restoration reason, and original target of the last rescued key.

`runSelfTest()` is harmless. It focuses an invisible off-screen button, sends a reserved `F24` test event from that button, and verifies that the capture listener produces a corresponding body-targeted event. It then verifies that focus can be restored to the body. It does not grade a card or invoke a production shortcut.

`beginReplayProof()` is the functional test. It focuses an invisible off-screen button so the next real keyboard event definitely does not originate from `BODY`. The tester then presses the physical `R` key once and calls `finishReplayProof()`. The proof passes only if all of the following occurred:

- The original `R` event came from `BUTTON#__ns-keyboard-proof-proxy`
- The rescued-key counter increased
- NativShark handled the replacement event and called media `play()`
- Focus ended on `document.body`

During the desktop Chrome validation, the exact userscript produced this result:

```js
{
  passed: true,
  originalKeyTarget: "BUTTON#__ns-keyboard-proof-proxy",
  rescuedKeyDelta: 1,
  mediaPlayDelta: 1,
  bodyFocused: true
}
```

The female pronunciation audio was playing after the rescued `R` event. This is evidence that a key deliberately originating from the wrong element was accepted once—and only once—after being retargeted to `BODY`, using NativShark's normal replay path.

This desktop test proves the event-target failure and validates the patch mechanism. The final platform proof remains a run on iPadOS 26 with the hardware keyboard: allow audio to play, confirm shortcuts continue working without a pointer click, and repeat for at least 50 cards using the verification checklist above.

### How this maps to the production fix

The userscript's capture listener demonstrates the durable application change: listen at the review surface or `window`, reject only genuinely editable targets, and stop requiring `event.target === document.body`. Its repeated focus restoration demonstrates where the application should manage focus: a stable `tabIndex={-1}` review root after playback and UI transitions.

The production release should not need to monkey-patch `HTMLMediaElement.prototype.play` or synthesize keyboard events. Those techniques are appropriate here because they prove the fix against already-deployed bundles. Once the review keyboard handler accepts non-editable targets and the Howler lifecycle no longer unloads live audio objects, the userscript can be removed.

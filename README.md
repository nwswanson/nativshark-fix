## Developer report: iPad keyboard stops after flashcard audio


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

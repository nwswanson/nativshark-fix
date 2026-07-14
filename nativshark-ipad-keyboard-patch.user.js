// ==UserScript==
// @name         NativShark iPad Audio Keyboard Patch
// @namespace    https://app.nativshark.com/
// @version      0.2.1
// @description  Keeps flashcard shortcuts working when iPadOS moves keyboard focus during HTML5 audio playback.
// @match        https://app.nativshark.com/*
// @include      https://app.nativshark.com/library/flashcards/review*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const PATCH_NAME = "NativShark iPad keyboard patch";
  const VERSION = "0.2.1";
  const API_NAME = "__NSKeyboardPatch";
  const EDITABLE_SELECTOR =
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

  if (window[API_NAME]) {
    console.info(`[${PATCH_NAME}] Already installed.`);
    return;
  }

  const redispatchedEvents = new WeakSet();
  const selfTestEvents = new WeakSet();
  const stats = {
    installedAt: new Date().toISOString(),
    mediaPlayCalls: 0,
    focusRestoreAttempts: 0,
    focusRestoreSuccesses: 0,
    rescuedKeys: 0,
    lastFocusReason: null,
    lastOriginalKeyTarget: null,
  };

  let patchedBody = null;
  let bodyOriginallyHadTabIndex = false;
  let bodyOriginalTabIndex = null;
  let replayProofSession = null;

  function isReviewPage() {
    return location.pathname.startsWith("/library/flashcards/review");
  }

  function isEditableTarget(target) {
    return (
      target instanceof Element && Boolean(target.closest(EDITABLE_SELECTOR))
    );
  }

  function describeElement(element) {
    if (!(element instanceof Element)) return String(element || "null");

    const id = element.id ? `#${element.id}` : "";
    const className =
      typeof element.className === "string" && element.className.trim()
        ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
        : "";

    return `${element.tagName}${id}${className}`;
  }

  function ensureBodyIsFocusable() {
    if (!document.body) return false;

    if (patchedBody !== document.body) {
      patchedBody = document.body;
      bodyOriginallyHadTabIndex = patchedBody.hasAttribute("tabindex");
      bodyOriginalTabIndex = patchedBody.getAttribute("tabindex");
    }

    if (!patchedBody.hasAttribute("tabindex")) {
      // -1 allows programmatic focus without adding BODY to normal tab order.
      patchedBody.setAttribute("tabindex", "-1");
    }

    return true;
  }

  function restoreBodyFocus(reason = "manual") {
    if (!isReviewPage() || !ensureBodyIsFocusable()) return false;

    const activeElement = document.activeElement;

    // Never pull focus out of an editor or form control.
    if (isEditableTarget(activeElement)) return false;

    stats.focusRestoreAttempts += 1;
    stats.lastFocusReason = reason;

    try {
      document.body.focus({ preventScroll: true });
    } catch (_error) {
      document.body.focus();
    }

    const restored = document.activeElement === document.body;
    if (restored) stats.focusRestoreSuccesses += 1;
    return restored;
  }

  function scheduleFocusRestore(reason) {
    queueMicrotask(() => restoreBodyFocus(`${reason}:microtask`));

    requestAnimationFrame(() => {
      restoreBodyFocus(`${reason}:animation-frame`);
    });

    // iPadOS may change focus after play() resolves or the media session starts.
    setTimeout(() => restoreBodyFocus(`${reason}:80ms`), 80);
  }

  function normalizedKey(event) {
    if (event.code === "Space" || event.key === " " || event.key === "Spacebar") {
      return "space";
    }

    return String(event.key || "").toLowerCase();
  }

  function isReviewShortcut(event) {
    const key = normalizedKey(event);

    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      return key === "z" || key === "d";
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return false;

    return ["space", "1", "2", "3", "r", "a", "e", "escape"].includes(
      key,
    );
  }

  function legacyKeyCodeFor(event) {
    if (event.which) return event.which;
    if (event.keyCode) return event.keyCode;

    const key = normalizedKey(event);
    const codes = {
      space: 32,
      "1": 49,
      "2": 50,
      "3": 51,
      a: 65,
      d: 68,
      e: 69,
      r: 82,
      z: 90,
      escape: 27,
      f24: 135,
    };

    return codes[key] || 0;
  }

  function createRetargetedKeyboardEvent(sourceEvent) {
    const clone = new KeyboardEvent(sourceEvent.type, {
      key: sourceEvent.key,
      code: sourceEvent.code,
      location: sourceEvent.location,
      repeat: sourceEvent.repeat,
      isComposing: sourceEvent.isComposing,
      ctrlKey: sourceEvent.ctrlKey,
      shiftKey: sourceEvent.shiftKey,
      altKey: sourceEvent.altKey,
      metaKey: sourceEvent.metaKey,
      bubbles: true,
      cancelable: true,
      composed: true,
    });

    // The production keyboard package reads deprecated which/keyCode values.
    // Synthetic KeyboardEvents report zero unless these compatibility getters
    // are supplied. Real hardware events retain their original numeric value.
    const legacyCode = legacyKeyCodeFor(sourceEvent);
    for (const property of ["which", "keyCode", "charCode"]) {
      try {
        Object.defineProperty(clone, property, {
          configurable: true,
          get: () => legacyCode,
        });
      } catch (_error) {
        // Some engines make these properties non-configurable. event.key/code
        // still work for the patch itself, and real events already have values.
      }
    }

    redispatchedEvents.add(clone);
    return clone;
  }

  function redispatchKeyFromBody(sourceEvent) {
    if (!document.body) return false;

    const clone = createRetargetedKeyboardEvent(sourceEvent);
    document.body.dispatchEvent(clone);

    if (clone.defaultPrevented && sourceEvent.cancelable) {
      sourceEvent.preventDefault();
    }

    stats.rescuedKeys += 1;
    stats.lastOriginalKeyTarget = describeElement(sourceEvent.target);
    return true;
  }

  function onWindowKeyDown(event) {
    if (!isReviewPage() || redispatchedEvents.has(event)) return;
    if (event.target === document.body || isEditableTarget(event.target)) return;
    if (!isReviewShortcut(event) && !selfTestEvents.has(event)) return;

    if (redispatchKeyFromBody(event)) {
      // The body-targeted clone is now the canonical shortcut event. Stopping
      // the stranded original prevents duplicate handlers or native activation.
      event.stopPropagation();
    }
  }

  window.addEventListener("keydown", onWindowKeyDown, true);

  const mediaPrototype = window.HTMLMediaElement?.prototype;
  const originalMediaPlay = mediaPrototype?.play;

  if (mediaPrototype && typeof originalMediaPlay === "function") {
    mediaPrototype.play = function patchedNativSharkMediaPlay(...args) {
      stats.mediaPlayCalls += 1;

      this.addEventListener(
        "playing",
        () => scheduleFocusRestore("media-playing"),
        { once: true },
      );
      this.addEventListener(
        "ended",
        () => scheduleFocusRestore("media-ended"),
        { once: true },
      );

      let result;
      try {
        result = originalMediaPlay.apply(this, args);
      } finally {
        scheduleFocusRestore("media-play-called");
      }

      if (result && typeof result.then === "function") {
        result.then(
          () => scheduleFocusRestore("media-play-resolved"),
          () => scheduleFocusRestore("media-play-rejected"),
        );
      }

      return result;
    };
  }

  function makeSyntheticKeyEvent({ key, code, keyCode, test = false }) {
    const event = new KeyboardEvent("keydown", {
      key,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
    });

    for (const property of ["which", "keyCode", "charCode"]) {
      try {
        Object.defineProperty(event, property, {
          configurable: true,
          get: () => keyCode,
        });
      } catch (_error) {
        // See createRetargetedKeyboardEvent.
      }
    }

    if (test) selfTestEvents.add(event);
    return event;
  }

  function createFocusProxy() {
    const proxy = document.createElement("button");
    proxy.type = "button";
    proxy.tabIndex = -1;
    proxy.setAttribute("aria-hidden", "true");
    proxy.style.cssText =
      "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(proxy);
    return proxy;
  }

  function runSelfTest() {
    if (!document.body) {
      return { passed: false, reason: "document.body is not ready" };
    }

    const proxy = createFocusProxy();
    let observedTarget = null;

    function observeRetargetedEvent(event) {
      if (event.key === "F24" && redispatchedEvents.has(event)) {
        observedTarget = event.target?.tagName || null;
      }
    }

    document.addEventListener("keydown", observeRetargetedEvent, true);
    proxy.focus({ preventScroll: true });

    const originalTarget = document.activeElement?.tagName || null;
    proxy.dispatchEvent(
      makeSyntheticKeyEvent({
        key: "F24",
        code: "F24",
        keyCode: 135,
        test: true,
      }),
    );

    document.removeEventListener("keydown", observeRetargetedEvent, true);
    proxy.remove();

    const bodyFocused = restoreBodyFocus("self-test");
    const result = {
      passed: originalTarget === "BUTTON" && observedTarget === "BODY" && bodyFocused,
      originalTarget,
      retargetedTarget: observedTarget,
      activeElementAfterRestore: document.activeElement?.tagName || null,
    };

    console.info(`[${PATCH_NAME}] Self-test`, result);
    return result;
  }

  function beginReplayProof() {
    if (!document.body) {
      return { passed: false, reason: "document.body is not ready" };
    }

    if (replayProofSession?.proxy) replayProofSession.proxy.remove();

    const proxy = createFocusProxy();
    proxy.id = "__ns-keyboard-proof-proxy";
    proxy.setAttribute("aria-label", "NativShark keyboard proof proxy");
    proxy.focus({ preventScroll: true });

    replayProofSession = {
      proxy,
      mediaPlayCallsBefore: stats.mediaPlayCalls,
      rescuedKeysBefore: stats.rescuedKeys,
    };

    const result = {
      ready: document.activeElement === proxy,
      focusedTarget: describeElement(document.activeElement),
      instruction:
        `Press the physical R key once, then run window.${API_NAME}.finishReplayProof().`,
    };

    console.info(`[${PATCH_NAME}] Replay proof ready`, result);
    return result;
  }

  function finishReplayProof() {
    if (!replayProofSession) {
      return {
        passed: false,
        reason: `Run window.${API_NAME}.beginReplayProof() first.`,
      };
    }

    const session = replayProofSession;
    replayProofSession = null;

    const result = {
      passed:
        stats.rescuedKeys > session.rescuedKeysBefore &&
        stats.mediaPlayCalls > session.mediaPlayCallsBefore &&
        stats.lastOriginalKeyTarget?.includes(
          "BUTTON#__ns-keyboard-proof-proxy",
        ) &&
        document.activeElement === document.body,
      originalKeyTarget: stats.lastOriginalKeyTarget,
      rescuedKeyDelta: stats.rescuedKeys - session.rescuedKeysBefore,
      mediaPlayDelta: stats.mediaPlayCalls - session.mediaPlayCallsBefore,
      bodyFocused: document.activeElement === document.body,
    };

    session.proxy.remove();
    restoreBodyFocus("replay-proof-finished");
    console.info(`[${PATCH_NAME}] Replay proof result`, result);
    return result;
  }

  function cancelReplayProof() {
    if (replayProofSession?.proxy) replayProofSession.proxy.remove();
    replayProofSession = null;
    restoreBodyFocus("replay-proof-cancelled");
  }

  function getState() {
    return {
      version: VERSION,
      installed: true,
      reviewPage: isReviewPage(),
      activeElement: describeElement(document.activeElement),
      bodyIsActive: document.activeElement === document.body,
      stats: { ...stats },
    };
  }

  function uninstall() {
    window.removeEventListener("keydown", onWindowKeyDown, true);

    if (
      mediaPrototype &&
      mediaPrototype.play?.name === "patchedNativSharkMediaPlay"
    ) {
      mediaPrototype.play = originalMediaPlay;
    }

    if (patchedBody) {
      if (bodyOriginallyHadTabIndex) {
        patchedBody.setAttribute("tabindex", bodyOriginalTabIndex);
      } else if (patchedBody.getAttribute("tabindex") === "-1") {
        patchedBody.removeAttribute("tabindex");
      }
    }

    delete window[API_NAME];
    console.info(`[${PATCH_NAME}] Uninstalled.`);
  }

  window[API_NAME] = Object.freeze({
    version: VERSION,
    getState,
    restoreFocus: () => restoreBodyFocus("api"),
    runSelfTest,
    beginReplayProof,
    finishReplayProof,
    cancelReplayProof,
    uninstall,
  });

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => scheduleFocusRestore("dom-ready"),
      { once: true },
    );
  } else {
    scheduleFocusRestore("installed");
  }

  console.info(
    `[${PATCH_NAME}] Installed v${VERSION}. Run window.${API_NAME}.runSelfTest() for a harmless check or .beginReplayProof() for a physical-key proof.`,
  );
})();

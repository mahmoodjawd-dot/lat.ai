// Push-to-talk keys: hold ctrl + option (ctrl + alt on Windows/Linux), the
// same chord as the macOS app. Optionally also hold Space, which the web home
// allows when focus isn't in a text field.

export function installPushToTalkKeys({ onPress, onRelease, allowSpaceKey = false, eventTarget = window }) {
  let pushToTalkHeldBy = null; // "chord" | "space" | null

  function isTypingIntoField(keyboardEvent) {
    const targetElement = keyboardEvent.target;
    return Boolean(
      targetElement?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(targetElement?.tagName),
    );
  }

  function handleKeyDown(keyboardEvent) {
    if (pushToTalkHeldBy || keyboardEvent.repeat) {
      return;
    }
    if (keyboardEvent.ctrlKey && keyboardEvent.altKey && (keyboardEvent.key === "Control" || keyboardEvent.key === "Alt")) {
      pushToTalkHeldBy = "chord";
      onPress();
    } else if (allowSpaceKey && keyboardEvent.code === "Space" && !isTypingIntoField(keyboardEvent)) {
      keyboardEvent.preventDefault();
      pushToTalkHeldBy = "space";
      onPress();
    }
  }

  function handleKeyUp(keyboardEvent) {
    const chordReleased = pushToTalkHeldBy === "chord" && (!keyboardEvent.ctrlKey || !keyboardEvent.altKey);
    const spaceReleased = pushToTalkHeldBy === "space" && keyboardEvent.code === "Space";
    if (chordReleased || spaceReleased) {
      keyboardEvent.preventDefault();
      pushToTalkHeldBy = null;
      onRelease();
    }
  }

  // Switching windows mid-press never delivers the keyup; treat it as a release.
  function handleWindowBlur() {
    if (pushToTalkHeldBy) {
      pushToTalkHeldBy = null;
      onRelease();
    }
  }

  eventTarget.addEventListener("keydown", handleKeyDown, true);
  eventTarget.addEventListener("keyup", handleKeyUp, true);
  window.addEventListener("blur", handleWindowBlur);

  return function uninstallPushToTalkKeys() {
    eventTarget.removeEventListener("keydown", handleKeyDown, true);
    eventTarget.removeEventListener("keyup", handleKeyUp, true);
    window.removeEventListener("blur", handleWindowBlur);
  };
}

// Runs on every page. While the Clicky side panel is open and this is the
// active tab, the panel holds a port to this script: we draw the secondary
// cursor on the page, follow the real pointer, fly to what Claude points at,
// and forward the ctrl + option push-to-talk chord back to the panel.
//
// Content scripts can't be ES modules, so the shared cursor and keyboard
// modules are loaded with dynamic import() from the extension's own files.

(() => {
  if (window.__clickyContentScriptLoaded) {
    return;
  }
  window.__clickyContentScriptLoaded = true;

  const INTERACTIVE_ELEMENT_SELECTOR =
    'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [contenteditable="true"]';
  const SNAP_MAX_DISTANCE_PX = 40;
  const SNAP_MAX_VIEWPORT_FRACTION = 0.12;

  let sharedModulesPromise = null;
  let cursor = null;
  let uninstallPushToTalkKeys = null;
  let connectedPanelPort = null;

  function loadSharedModules() {
    sharedModulesPromise ??= Promise.all([
      import(chrome.runtime.getURL("shared/cursor.js")),
      import(chrome.runtime.getURL("shared/keyboard.js")),
    ]);
    return sharedModulesPromise;
  }

  /**
   * Claude's coordinates are usually within a few dozen pixels. If they land
   * on or right next to a reasonably small clickable element, center on it.
   */
  function snapToNearbyInteractiveElement(x, y) {
    const elementAtPoint = document.elementFromPoint(x, y);
    const interactiveElement = elementAtPoint?.closest(INTERACTIVE_ELEMENT_SELECTOR);
    if (!interactiveElement) {
      return { x, y };
    }
    const elementRect = interactiveElement.getBoundingClientRect();
    const viewportArea = window.innerWidth * window.innerHeight;
    const elementIsSmallEnough = elementRect.width * elementRect.height <= viewportArea * SNAP_MAX_VIEWPORT_FRACTION;
    const distanceToRect = Math.hypot(
      Math.max(elementRect.left - x, 0, x - elementRect.right),
      Math.max(elementRect.top - y, 0, y - elementRect.bottom),
    );
    if (!elementIsSmallEnough || distanceToRect > SNAP_MAX_DISTANCE_PX) {
      return { x, y };
    }
    return { x: elementRect.left + elementRect.width / 2, y: elementRect.top + elementRect.height / 2 };
  }

  function handleMouseMove(mouseEvent) {
    cursor?.followPointer(mouseEvent.clientX, mouseEvent.clientY);
  }

  async function handlePanelConnected(panelPort) {
    connectedPanelPort = panelPort;
    const [{ createClickyCursor }, { installPushToTalkKeys }] = await loadSharedModules();
    if (connectedPanelPort !== panelPort) {
      return; // disconnected while loading
    }

    cursor ??= createClickyCursor({ positioning: "fixed", container: document.documentElement });
    cursor.show();
    document.addEventListener("mousemove", handleMouseMove, { passive: true });

    uninstallPushToTalkKeys?.();
    uninstallPushToTalkKeys = installPushToTalkKeys({
      onPress: () => panelPort.postMessage({ type: "push-to-talk", pressed: true }),
      onRelease: () => panelPort.postMessage({ type: "push-to-talk", pressed: false }),
    });

    panelPort.onMessage.addListener((panelMessage) => {
      switch (panelMessage.type) {
        case "color":
          cursor.setColor(panelMessage.color);
          break;
        case "bubble":
          cursor.setBubbleText(panelMessage.text);
          break;
        case "release":
          cursor.releasePoint();
          break;
        case "point": {
          const snappedPoint = snapToNearbyInteractiveElement(
            panelMessage.fx * window.innerWidth,
            panelMessage.fy * window.innerHeight,
          );
          cursor.pointAt(snappedPoint.x, snappedPoint.y, panelMessage.label);
          break;
        }
      }
    });
    panelPort.postMessage({ type: "ready" });
  }

  function handlePanelDisconnected(panelPort) {
    if (connectedPanelPort !== panelPort) {
      return;
    }
    connectedPanelPort = null;
    cursor?.hide();
    cursor?.setBubbleText(null);
    document.removeEventListener("mousemove", handleMouseMove);
    uninstallPushToTalkKeys?.();
    uninstallPushToTalkKeys = null;
  }

  chrome.runtime.onConnect.addListener((panelPort) => {
    if (panelPort.name !== "clicky-cursor") {
      return;
    }
    panelPort.onDisconnect.addListener(() => handlePanelDisconnected(panelPort));
    handlePanelConnected(panelPort);
  });
})();

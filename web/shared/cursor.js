// The secondary Clicky cursor: a colored triangle that trails your real
// pointer, flies along a curved arc to whatever Claude points at, holds there
// with a label, then drifts back to your pointer. Rendered inside a shadow
// root so host-page CSS (in the extension) can't restyle it.
//
// positioning "fixed"    → covers the viewport (extension content script)
// positioning "absolute" → covers `container`, which must be position:relative
//                          (the web home's screen preview)

const FOLLOW_OFFSET_X = 22;
const FOLLOW_OFFSET_Y = 18;
const FOLLOW_SMOOTHING = 0.18;
const POINT_HOLD_MS = 6000;
const BUBBLE_ROOM_RIGHT_PX = 310;
const BUBBLE_ROOM_BELOW_PX = 200;

const CURSOR_STYLES = `
  :host { all: initial; }
  .layer { position: var(--clicky-positioning); inset: 0; pointer-events: none; overflow: hidden;
    z-index: 2147483647; opacity: 0; transition: opacity 250ms ease; font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .layer.visible { opacity: 1; }
  .cursor { position: absolute; left: 0; top: 0; will-change: transform; }
  .triangle { display: block; filter: drop-shadow(0 0 6px var(--clicky-color)) drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
  .ring { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
    border: 2px solid var(--clicky-color); opacity: 0; }
  .cursor.landed .ring { animation: ring 900ms ease-out 2; }
  @keyframes ring { from { transform: scale(.3); opacity: .9; } to { transform: scale(2.2); opacity: 0; } }
  .label { position: absolute; left: 20px; top: -26px; white-space: nowrap; padding: 3px 8px; border-radius: 999px;
    background: var(--clicky-color); color: #fff; font-size: 12px; font-weight: 600; opacity: 0; transform: translateY(4px);
    transition: opacity 200ms, transform 200ms; }
  .label.visible { opacity: 1; transform: none; }
  .bubble { position: absolute; left: 24px; top: 22px; width: max-content; max-width: 280px; padding: 8px 11px;
    border-radius: 4px 12px 12px 12px; background: rgba(17, 19, 24, .92); color: #f4f5f7;
    border: 1px solid color-mix(in srgb, var(--clicky-color) 55%, transparent); box-shadow: 0 6px 24px rgba(0,0,0,.35);
    opacity: 0; transition: opacity 200ms; max-height: 160px; overflow: hidden; }
  .bubble.visible { opacity: 1; }
  /* Near the right or bottom edge, open the label and bubble the other way so they stay on screen. */
  .cursor.flip-x .label { left: auto; right: 4px; }
  .cursor.flip-x .bubble { left: auto; right: 4px; border-radius: 12px 4px 12px 12px; }
  .cursor.flip-y .bubble { top: auto; bottom: 30px; }
`;

export function createClickyCursor({ positioning = "fixed", container = document.body } = {}) {
  const hostElement = document.createElement("clicky-cursor");
  const shadowRoot = hostElement.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `
    <style>${CURSOR_STYLES}</style>
    <div class="layer">
      <div class="cursor">
        <div class="ring"></div>
        <svg class="triangle" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 2 L22 10 L12.5 12.5 L10 22 Z" fill="var(--clicky-color)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
        </svg>
        <div class="label"></div>
        <div class="bubble"></div>
      </div>
    </div>`;
  const layerElement = shadowRoot.querySelector(".layer");
  const cursorElement = shadowRoot.querySelector(".cursor");
  const labelElement = shadowRoot.querySelector(".label");
  const bubbleElement = shadowRoot.querySelector(".bubble");
  layerElement.style.setProperty("--clicky-positioning", positioning);
  container.appendChild(hostElement);

  const initialBounds = getLayerSize();
  const cursorPosition = { x: initialBounds.width - 140, y: initialBounds.height - 140 };
  let pointerFollowTarget = null;
  let activeFlight = null;
  let holdAtTargetUntil = 0;
  let animationFrameId = null;
  let landedClassTimeoutId = null;

  function getLayerSize() {
    if (positioning === "fixed") {
      return { width: window.innerWidth, height: window.innerHeight };
    }
    return { width: container.clientWidth, height: container.clientHeight };
  }

  function renderCursorPosition() {
    cursorElement.style.transform = `translate3d(${cursorPosition.x}px, ${cursorPosition.y}px, 0)`;
    const layerSize = getLayerSize();
    cursorElement.classList.toggle("flip-x", cursorPosition.x > layerSize.width - BUBBLE_ROOM_RIGHT_PX);
    cursorElement.classList.toggle("flip-y", cursorPosition.y > layerSize.height - BUBBLE_ROOM_BELOW_PX);
  }

  function animationTick(now) {
    if (activeFlight) {
      const flightProgress = Math.min((now - activeFlight.startTime) / activeFlight.durationMs, 1);
      const easedProgress = flightProgress * flightProgress * (3 - 2 * flightProgress);
      const remaining = 1 - easedProgress;
      // Quadratic bezier: start → lifted control point → target.
      cursorPosition.x =
        remaining * remaining * activeFlight.start.x +
        2 * remaining * easedProgress * activeFlight.control.x +
        easedProgress * easedProgress * activeFlight.end.x;
      cursorPosition.y =
        remaining * remaining * activeFlight.start.y +
        2 * remaining * easedProgress * activeFlight.control.y +
        easedProgress * easedProgress * activeFlight.end.y;

      if (flightProgress === 1) {
        const landedLabel = activeFlight.label;
        activeFlight = null;
        holdAtTargetUntil = now + POINT_HOLD_MS;
        if (landedLabel) {
          labelElement.textContent = landedLabel;
          labelElement.classList.add("visible");
        }
        cursorElement.classList.add("landed");
        clearTimeout(landedClassTimeoutId);
        landedClassTimeoutId = setTimeout(() => cursorElement.classList.remove("landed"), 1900);
      }
    } else if (now < holdAtTargetUntil) {
      // Stay on the pointed-at element so the user can find it.
    } else {
      labelElement.classList.remove("visible");
      if (pointerFollowTarget) {
        cursorPosition.x += (pointerFollowTarget.x + FOLLOW_OFFSET_X - cursorPosition.x) * FOLLOW_SMOOTHING;
        cursorPosition.y += (pointerFollowTarget.y + FOLLOW_OFFSET_Y - cursorPosition.y) * FOLLOW_SMOOTHING;
      }
    }
    renderCursorPosition();
    animationFrameId = requestAnimationFrame(animationTick);
  }
  renderCursorPosition();
  animationFrameId = requestAnimationFrame(animationTick);

  return {
    setColor(color) {
      layerElement.style.setProperty("--clicky-color", color);
    },
    show() {
      layerElement.classList.add("visible");
    },
    hide() {
      layerElement.classList.remove("visible");
    },
    /** Where the user's real pointer is, in this layer's coordinates. */
    followPointer(x, y) {
      pointerFollowTarget = { x, y };
    },
    /** Text in the speech bubble next to the cursor; null hides it. */
    setBubbleText(text) {
      bubbleElement.textContent = text ?? "";
      bubbleElement.classList.toggle("visible", Boolean(text));
      bubbleElement.scrollTop = bubbleElement.scrollHeight;
    },
    /** Fly the cursor tip to (x, y) in this layer's coordinates. */
    pointAt(x, y, label) {
      const layerSize = getLayerSize();
      const end = {
        x: Math.max(0, Math.min(x, layerSize.width - 4)),
        y: Math.max(0, Math.min(y, layerSize.height - 4)),
      };
      const start = { ...cursorPosition };
      const flightDistance = Math.hypot(end.x - start.x, end.y - start.y);
      const arcLift = Math.min(220, flightDistance * 0.4);
      activeFlight = {
        start,
        end,
        control: { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - arcLift },
        startTime: performance.now(),
        durationMs: Math.max(500, Math.min(1100, 400 + flightDistance * 0.5)),
        label: label ?? null,
      };
      labelElement.classList.remove("visible");
      layerElement.classList.add("visible");
    },
    /** Let the cursor return to the pointer now instead of after the hold. */
    releasePoint() {
      holdAtTargetUntil = 0;
    },
    destroy() {
      cancelAnimationFrame(animationFrameId);
      clearTimeout(landedClassTimeoutId);
      hostElement.remove();
    },
  };
}

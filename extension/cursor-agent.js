/*
 * Cursor Agent SDK
 *
 * A second cursor, like Clicky's, that trails your own on any page that loads
 * this script. Press ctrl + option (ctrl + alt on Windows/Linux) and a small
 * card pops out of it. Ask anything; the agent reads the page and can:
 *   - Do:           click, type, scroll, navigate and run site actions until it's done
 *   - Explain:      walk you through the page, pointing at each part
 *   - Troubleshoot: read page errors and on-screen messages, find the cause, point at the fix
 *   - Pitch:        guide a visitor through the product using the site's own context
 *   - Guide me:     make a step plan, show progress on the cursor, point at the next
 *                   step and check in automatically as you click, to keep you on track
 *
 *   <script src="https://YOUR-WORKER/cursor-agent.js"></script>
 *   <script>
 *     CursorAgent.init({
 *       endpoint: "https://YOUR-WORKER",
 *       siteContext: "Acme Cloud hosts web apps. Plans: Free, Pro $20/mo, Team $50/mo...",
 *       actions: [{
 *         name: "add_to_cart",
 *         description: "Add a product to the cart.",
 *         parameters: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "integer" } }, required: ["sku"] },
 *         run: async ({ sku, quantity }) => cart.add(sku, quantity ?? 1),
 *       }],
 *     });
 *   </script>
 *
 * One plain script with no dependencies, so the Chrome extension can inject
 * the very same file into every page.
 */
(function () {
  "use strict";

  if (window.CursorAgent) {
    return;
  }

  const DEFAULT_OPTIONS = {
    endpoint: "", // Worker base URL; "" means same origin
    accessToken: "", // sent as x-cursor-agent-token when the Worker sets ACCESS_TOKEN
    siteContext: "", // what the site owner wants the agent to know (product, pricing, policies)
    actions: [], // site actions: { name, description, parameters (JSON Schema), run(params) }
    hotkey: true, // ctrl + option toggles the card
    showCursor: "always", // "always": trail the pointer everywhere; "active": only while the card is open or a guide runs
    label: window.location.hostname || "this page",
    color: "#2563eb",
    maxSteps: 20,
    transport: null, // { requestAgentStep(body, signal) } to route requests elsewhere (the extension uses this)
    persistence: null, // { load(), save(state), clear() } to carry tasks and guides across page loads
  };

  const MODES = {
    explain: { label: "Explain", placeholder: "e.g. what does this page let me do?" },
    troubleshoot: { label: "Troubleshoot", placeholder: "e.g. why won't this form submit?" },
    pitch: { label: "Pitch", placeholder: "e.g. why should I choose this?" },
    guide: { label: "Guide me", placeholder: "e.g. help me set up my account" },
  };
  const DEFAULT_PLACEHOLDER = "e.g. find the latest blog post";

  const MAX_SNAPSHOT_ELEMENTS = 200;
  const MAX_PAGE_TEXT_CHARACTERS = 2500;
  const MAX_SITE_CONTEXT_CHARACTERS = 4000;
  const MAX_TOOL_RESULT_CHARACTERS = 4000;
  const MAX_RECENT_PAGE_ERRORS = 10;
  const TASK_RESUME_MAX_AGE_MS = 2 * 60 * 1000;
  const GUIDE_RESUME_MAX_AGE_MS = 30 * 60 * 1000;
  const SETTLE_AFTER_ACTION_MS = 700;
  const HOLD_AFTER_POINT_MS = 700;
  const CURSOR_HOLD_AFTER_TASK_MS = 3000;
  const GUIDE_CHECK_IN_DELAY_MS = 1200;
  const MAX_GUIDE_CHECK_INS = 40;
  const COMPACT_CONVERSATION_AFTER_MESSAGES = 40;
  const CURSOR_BUBBLE_DURATION_MS = 9000;

  // ===================================================================
  // Page snapshot: what the agent "sees"
  // ===================================================================

  const INTERACTIVE_ELEMENT_SELECTOR = [
    "a[href]", "button", "input", "textarea", "select", "summary", "[contenteditable='true']",
    "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']", "[role='checkbox']",
    "[role='option']", "[role='switch']", "[role='combobox']", "[role='searchbox']",
  ].join(", ");
  const CONTEXT_ELEMENT_SELECTOR = "h1, h2, h3";
  const ON_SCREEN_ERROR_SELECTOR = "[role='alert'], [aria-invalid='true'], .error, .errors, .alert-danger, .alert-error, .form-error, .invalid-feedback";

  function collapseWhitespace(text, maxLength = 100) {
    const collapsedText = String(text ?? "").replace(/\s+/g, " ").trim();
    return collapsedText.length > maxLength ? `${collapsedText.slice(0, maxLength - 1)}…` : collapsedText;
  }

  function truncateText(text, maxLength) {
    const fullText = String(text ?? "");
    return fullText.length > maxLength ? `${fullText.slice(0, maxLength - 1)}…` : fullText;
  }

  /** Password, one-time-code and payment-card fields are never shown to or typed into by the agent. */
  function isSensitiveField(element) {
    if (element.tagName === "INPUT" && ["password", "hidden"].includes(element.type)) {
      return true;
    }
    return /cc-|password|one-time-code/.test(element.getAttribute("autocomplete") ?? "");
  }

  function isRendered(element) {
    const elementRect = element.getBoundingClientRect();
    if (elementRect.width < 1 || elementRect.height < 1) {
      return false;
    }
    const computedStyle = getComputedStyle(element);
    return computedStyle.visibility !== "hidden" && computedStyle.display !== "none" && computedStyle.opacity !== "0";
  }

  function isInViewport(element) {
    const elementRect = element.getBoundingClientRect();
    return elementRect.bottom > 0 && elementRect.right > 0 && elementRect.top < innerHeight && elementRect.left < innerWidth;
  }

  function getLabelText(element) {
    const labelText = element.labels?.[0]?.innerText ?? "";
    // A <label> wrapping its control also contains the control's own text (a select's options).
    return element.innerText ? labelText.replace(element.innerText, "") : labelText;
  }

  function getAccessibleName(element) {
    const labelledByIds = element.getAttribute("aria-labelledby");
    const labelledByText = labelledByIds
      ? labelledByIds.split(/\s+/).map((labelId) => document.getElementById(labelId)?.innerText ?? "").join(" ")
      : "";
    return collapseWhitespace(
      element.getAttribute("aria-label") ||
        labelledByText ||
        getLabelText(element) ||
        (element.tagName === "INPUT" && ["submit", "button"].includes(element.type) ? element.value : "") ||
        element.innerText ||
        element.getAttribute("title") ||
        element.querySelector?.("img[alt]")?.getAttribute("alt") ||
        "",
    );
  }

  function describeElementKind(element) {
    const tagName = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    if (/^h[1-3]$/.test(tagName)) return `heading ${tagName}`;
    if (tagName === "a") return "link";
    if (tagName === "input") return `input[${element.type || "text"}]`;
    if (tagName === "select" || tagName === "textarea" || tagName === "button") return tagName;
    if (role) return role;
    if (element.isContentEditable) return "editable";
    return tagName;
  }

  function describeElement(element) {
    const descriptionParts = [describeElementKind(element)];
    const accessibleName = getAccessibleName(element);
    if (accessibleName) descriptionParts.push(`"${accessibleName}"`);

    if (element.tagName === "A") {
      const linkTarget = element.getAttribute("href");
      if (linkTarget && !linkTarget.startsWith("javascript:")) descriptionParts.push(`-> ${collapseWhitespace(linkTarget, 80)}`);
    }
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      if (element.placeholder) descriptionParts.push(`placeholder="${collapseWhitespace(element.placeholder, 60)}"`);
      if (["checkbox", "radio"].includes(element.type)) descriptionParts.push(element.checked ? "checked" : "unchecked");
      else if (element.value) descriptionParts.push(`value="${collapseWhitespace(element.value, 60)}"`);
      if (element.required) descriptionParts.push("(required)");
      if (element.validationMessage) descriptionParts.push(`(invalid: ${collapseWhitespace(element.validationMessage, 80)})`);
    }
    if (element.tagName === "SELECT") {
      const optionTexts = [...element.options].slice(0, 15).map((option) => collapseWhitespace(option.text, 30));
      descriptionParts.push(`selected="${collapseWhitespace(element.selectedOptions[0]?.text ?? "", 40)}" options=[${optionTexts.join(" | ")}]`);
    }
    if (element.disabled || element.getAttribute("aria-disabled") === "true") descriptionParts.push("(disabled)");
    if (!isInViewport(element)) descriptionParts.push("(off-screen)");
    return descriptionParts.join(" ");
  }

  /** Images that already failed to load, including ones that failed before this script ran. */
  function collectBrokenImages() {
    return [...document.images]
      .filter((imageElement) => imageElement.complete && imageElement.naturalWidth === 0 && imageElement.currentSrc)
      .slice(0, 5)
      .map((imageElement) => `Failed to load img: ${imageElement.currentSrc}`);
  }

  function collectOnScreenErrorMessages(hostElementToIgnore) {
    const errorMessages = new Set();
    for (const errorElement of document.querySelectorAll(ON_SCREEN_ERROR_SELECTOR)) {
      if (errorElement === hostElementToIgnore || !isRendered(errorElement)) continue;
      const errorText = collapseWhitespace(errorElement.innerText || errorElement.getAttribute("aria-label"), 200);
      if (errorText) errorMessages.add(errorText);
      if (errorMessages.size >= 8) break;
    }
    return [...errorMessages];
  }

  /**
   * Numbers the page's visible interactive elements and headings, on-screen
   * ones first, and returns the text the agent reads plus an id → element map
   * for the tools. Ids only stay valid until the next snapshot.
   */
  function takePageSnapshot({ hostElementToIgnore, recentPageErrors, siteContext }) {
    const candidateElements = [...document.querySelectorAll(`${INTERACTIVE_ELEMENT_SELECTOR}, ${CONTEXT_ELEMENT_SELECTOR}`)].filter(
      (element) => element !== hostElementToIgnore && !isSensitiveField(element) && isRendered(element),
    );
    const onScreenElements = candidateElements.filter(isInViewport);
    const offScreenElements = candidateElements.filter((element) => !isInViewport(element));
    const snapshotElements = [...onScreenElements, ...offScreenElements].slice(0, MAX_SNAPSHOT_ELEMENTS);
    // Keep document order within the snapshot so it reads like the page.
    snapshotElements.sort((firstElement, secondElement) =>
      firstElement.compareDocumentPosition(secondElement) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );

    const elementsById = new Map();
    const elementLines = snapshotElements.map((element, elementIndex) => {
      const elementId = elementIndex + 1;
      elementsById.set(elementId, element);
      return `[${elementId}] ${describeElement(element)}`;
    });

    const scrollableHeight = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const scrolledPercent = Math.round((scrollY / scrollableHeight) * 100);
    const metaDescription = document.querySelector('meta[name="description"]')?.content;
    const selectedText = collapseWhitespace(window.getSelection()?.toString(), 500);
    const mainContentElement = document.querySelector("main, [role='main'], article") ?? document.body;
    const pageTextExcerpt = collapseWhitespace(mainContentElement?.innerText ?? "", MAX_PAGE_TEXT_CHARACTERS);
    const onScreenErrorMessages = collectOnScreenErrorMessages(hostElementToIgnore);
    const pageErrors = [...new Set([...recentPageErrors, ...collectBrokenImages()])];

    const snapshotText = [
      `Page title: ${document.title}`,
      `URL: ${location.href}`,
      metaDescription ? `Description: ${collapseWhitespace(metaDescription, 200)}` : null,
      `Scrolled: ${scrolledPercent}% of the page`,
      selectedText ? `User's selected text: ${selectedText}` : null,
      onScreenErrorMessages.length ? `Error messages on screen:\n- ${onScreenErrorMessages.join("\n- ")}` : null,
      pageErrors.length ? `Recent page errors (from the page's scripts and resources):\n- ${pageErrors.join("\n- ")}` : null,
      siteContext ? `Site context (written by the website's owner):\n${collapseWhitespace(siteContext, MAX_SITE_CONTEXT_CHARACTERS)}` : null,
      "",
      "Elements:",
      elementLines.join("\n") || "(none)",
      candidateElements.length > snapshotElements.length ? `(${candidateElements.length - snapshotElements.length} more not listed; scroll to see others)` : null,
      "",
      "Page text excerpt:",
      pageTextExcerpt || "(empty)",
    ]
      .filter((line) => line !== null)
      .join("\n");

    return { snapshotText, elementsById };
  }

  // ===================================================================
  // UI: the secondary cursor and the pop-up card (inside a shadow root)
  // ===================================================================

  const UI_STYLES = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; color: #111827; }
    [hidden] { display: none !important; }

    .cursor { position: absolute; left: 0; top: 0; opacity: 0; transition: opacity 200ms ease; will-change: transform; }
    .cursor.visible { opacity: 1; }
    .triangle { display: block; filter: drop-shadow(0 0 6px var(--agent-color)) drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
    .ring { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
      border: 2px solid var(--agent-color); opacity: 0; }
    .cursor.clicking .ring { animation: ring 650ms ease-out; }
    @keyframes ring { from { transform: scale(.3); opacity: .95; } to { transform: scale(2); opacity: 0; } }
    .cursor-label { position: absolute; left: 20px; top: -24px; white-space: nowrap; padding: 2px 8px; border-radius: 999px;
      background: var(--agent-color); color: #fff; font-size: 12px; font-weight: 600; opacity: 0; transition: opacity 150ms; }
    .cursor-label.visible { opacity: 1; }
    .cursor-pill { position: absolute; left: 22px; top: 18px; max-width: 240px; padding: 3px 9px; border-radius: 999px;
      background: #111827; color: #fff; font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    .cursor-bubble { position: absolute; left: 22px; top: 44px; width: max-content; max-width: 260px; padding: 8px 11px;
      border-radius: 4px 12px 12px 12px; background: #fff; color: #111827; font-size: 13px;
      box-shadow: 0 6px 24px rgba(0,0,0,.25), 0 0 0 1px rgba(0,0,0,.06); }
    .cursor.flip-x .cursor-label, .cursor.flip-x .cursor-pill { left: auto; right: 6px; }
    .cursor.flip-x .cursor-bubble { left: auto; right: 6px; border-radius: 12px 4px 12px 12px; }
    .cursor.flip-y .cursor-bubble { top: auto; bottom: 34px; }

    .card { position: absolute; width: 344px; max-width: calc(100vw - 24px); pointer-events: auto; background: #fff;
      border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.06); overflow: hidden;
      opacity: 0; transform: translateY(4px) scale(.98); transition: opacity 140ms ease, transform 140ms ease; }
    .card.open { opacity: 1; transform: none; }
    .card-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 10px 16px;
      border-bottom: 1px solid #ececef; }
    .card-title { font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #6b7280;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .icon-button { width: 26px; height: 26px; border: 0; border-radius: 8px; background: transparent; color: #6b7280;
      font-size: 18px; line-height: 1; cursor: pointer; }
    .icon-button:hover { background: #f3f4f6; color: #111827; }
    .ask-form { display: flex; gap: 8px; padding: 12px 12px 8px; }
    .ask-input { flex: 1; min-width: 0; padding: 9px 12px; border: 1.5px solid #d1d5db; border-radius: 10px; font: inherit;
      color: #111827; background: #fff; outline: none; }
    .ask-input:focus { border-color: #111827; }
    .ask-input::placeholder { color: #9ca3af; }
    .go-button { padding: 0 14px; border: 0; border-radius: 10px; background: #111827; color: #fff; font: inherit;
      font-weight: 600; cursor: pointer; }
    .go-button:disabled { background: #9ca3af; cursor: default; }
    .go-button.stop { background: #ef4444; }
    .modes { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 12px; }
    .mode-chip { padding: 4px 9px; border: 1px solid #e5e7eb; border-radius: 999px; background: #f9fafb; color: #374151;
      font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
    .mode-chip:hover { border-color: #9ca3af; }
    .mode-chip[aria-pressed="true"] { background: var(--agent-color); border-color: var(--agent-color); color: #fff; }
    button:focus-visible { outline: 2px solid var(--agent-color); outline-offset: 2px; }

    .plan { margin: 0 12px 12px; padding: 10px 12px; border-radius: 12px; background: #f6f7f9; }
    .plan-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .plan-goal { font-size: 13px; font-weight: 600; }
    .end-guide { border: 0; background: transparent; color: #6b7280; font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; }
    .plan-steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; counter-reset: plan; }
    .plan-step { display: flex; gap: 8px; font-size: 13px; color: #374151; counter-increment: plan; }
    .plan-step::before { content: counter(plan); flex: none; width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid #d1d5db;
      font-size: 11px; font-weight: 600; display: grid; place-items: center; color: #6b7280; }
    .plan-step.current { color: #111827; font-weight: 600; }
    .plan-step.current::before { border-color: var(--agent-color); color: var(--agent-color); }
    .plan-step.done { color: #9ca3af; text-decoration: line-through; }
    .plan-step.done::before { content: "✓"; background: var(--agent-color); border-color: var(--agent-color); color: #fff; }

    .output { padding: 0 16px 14px; display: flex; flex-direction: column; gap: 8px; max-height: 240px; overflow-y: auto; }
    .output:empty { display: none; }
    .steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .step { display: flex; gap: 8px; align-items: baseline; font-size: 13px; color: #6b7280; }
    .step::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: #d1d5db; transform: translateY(-1px); }
    .step.active { color: #111827; }
    .step.active::before { background: var(--agent-color); animation: pulse 900ms infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    .answer { white-space: pre-wrap; color: #111827; }
    .answer:empty, .error:empty, .steps:empty { display: none; }
    .error { font-size: 13px; color: #b91c1c; }
  `;

  function createAgentInterface({ color, label, onSubmit, onStop, onClose, onEndGuide }) {
    const hostElement = document.createElement("cursor-agent");
    const shadowRoot = hostElement.attachShadow({ mode: "open" });
    const modeChipsMarkup = Object.entries(MODES)
      .map(([modeKey, mode]) => `<button type="button" class="mode-chip" data-mode="${modeKey}" aria-pressed="false">${mode.label}</button>`)
      .join("");
    shadowRoot.innerHTML = `
      <style>${UI_STYLES}</style>
      <div class="layer">
        <div class="cursor">
          <div class="ring"></div>
          <svg class="triangle" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2 2 L22 10 L12.5 12.5 L10 22 Z" fill="var(--agent-color)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
          </svg>
          <div class="cursor-label"></div>
          <div class="cursor-pill" hidden></div>
          <div class="cursor-bubble" hidden></div>
        </div>
        <div class="card" role="dialog" aria-label="Cursor Agent" hidden>
          <div class="card-header">
            <span class="card-title"></span>
            <button type="button" class="icon-button close-button" aria-label="Close">×</button>
          </div>
          <form class="ask-form">
            <input class="ask-input" type="text" autocomplete="off" aria-label="Ask Cursor Agent">
            <button type="submit" class="go-button" disabled>Go</button>
          </form>
          <div class="modes" role="group" aria-label="Mode">${modeChipsMarkup}</div>
          <div class="plan" hidden>
            <div class="plan-header"><span class="plan-goal"></span><button type="button" class="end-guide">End guide</button></div>
            <ol class="plan-steps"></ol>
          </div>
          <div class="output" aria-live="polite">
            <ol class="steps"></ol>
            <div class="answer"></div>
            <div class="error" role="alert"></div>
          </div>
        </div>
      </div>`;
    const select = (selector) => shadowRoot.querySelector(selector);
    const layerElement = select(".layer");
    const cursorElement = select(".cursor");
    const cursorLabelElement = select(".cursor-label");
    const cursorPillElement = select(".cursor-pill");
    const cursorBubbleElement = select(".cursor-bubble");
    const cardElement = select(".card");
    const askFormElement = select(".ask-form");
    const askInputElement = select(".ask-input");
    const goButtonElement = select(".go-button");
    const planElement = select(".plan");
    const planGoalElement = select(".plan-goal");
    const planStepsElement = select(".plan-steps");
    const outputElement = select(".output");
    const stepsElement = select(".steps");
    const answerElement = select(".answer");
    const errorElement = select(".error");
    layerElement.style.setProperty("--agent-color", color);
    select(".card-title").textContent = `Cursor Agent · ${label}`;
    askInputElement.placeholder = DEFAULT_PLACEHOLDER;
    document.documentElement.appendChild(hostElement);

    let isWorking = false;
    let selectedMode = null;
    let cursorBubbleTimeoutId = null;
    const cursorPosition = { x: innerWidth / 2, y: innerHeight / 2 };
    let cursorIsBusy = false; // flying to or holding on an element instead of trailing the pointer

    function renderCursor() {
      cursorElement.style.transform = `translate3d(${cursorPosition.x}px, ${cursorPosition.y}px, 0)`;
      cursorElement.classList.toggle("flip-x", cursorPosition.x > innerWidth - 290);
      cursorElement.classList.toggle("flip-y", cursorPosition.y > innerHeight - 180);
    }
    renderCursor();

    function updateGoButton() {
      goButtonElement.textContent = isWorking ? "Stop" : "Go";
      goButtonElement.classList.toggle("stop", isWorking);
      goButtonElement.disabled = !isWorking && !askInputElement.value.trim();
    }

    function selectMode(modeKey) {
      selectedMode = selectedMode === modeKey ? null : modeKey;
      for (const modeChipElement of shadowRoot.querySelectorAll(".mode-chip")) {
        modeChipElement.setAttribute("aria-pressed", String(modeChipElement.dataset.mode === selectedMode));
      }
      askInputElement.placeholder = selectedMode ? MODES[selectedMode].placeholder : DEFAULT_PLACEHOLDER;
      askInputElement.focus();
    }

    askInputElement.addEventListener("input", updateGoButton);
    askFormElement.addEventListener("submit", (submitEvent) => {
      submitEvent.preventDefault();
      if (isWorking) {
        onStop();
        return;
      }
      const request = askInputElement.value.trim();
      if (request) {
        askInputElement.value = "";
        updateGoButton();
        onSubmit(request, selectedMode);
      }
    });
    for (const modeChipElement of shadowRoot.querySelectorAll(".mode-chip")) {
      modeChipElement.addEventListener("click", () => selectMode(modeChipElement.dataset.mode));
    }
    select(".close-button").addEventListener("click", onClose);
    select(".end-guide").addEventListener("click", onEndGuide);
    // Keep the page's own shortcuts from firing while typing in the card.
    for (const keyboardEventType of ["keydown", "keyup", "keypress"]) {
      cardElement.addEventListener(keyboardEventType, (keyboardEvent) => {
        if (keyboardEvent.key === "Escape" && keyboardEventType === "keydown") onClose();
        keyboardEvent.stopPropagation();
      });
    }

    /** Places the card beside a point, flipped to stay on screen. */
    function placeCard(anchorX, anchorY) {
      const cardWidth = Math.min(344, innerWidth - 24);
      const estimatedCardHeight = 300;
      const left = anchorX + 18 + cardWidth > innerWidth - 12 ? anchorX - 18 - cardWidth : anchorX + 18;
      const top = anchorY + 14 + estimatedCardHeight > innerHeight - 12 ? Math.max(12, anchorY - estimatedCardHeight) : anchorY + 14;
      cardElement.style.left = `${Math.max(12, left)}px`;
      cardElement.style.top = `${Math.max(12, top)}px`;
    }

    return {
      hostElement,
      isCardOpen: () => !cardElement.hidden,
      openCard(anchorX, anchorY) {
        placeCard(anchorX, anchorY);
        cardElement.hidden = false;
        requestAnimationFrame(() => cardElement.classList.add("open"));
        cursorBubbleElement.hidden = true;
        if (!cursorIsBusy) {
          cursorPosition.x = anchorX;
          cursorPosition.y = anchorY;
          renderCursor();
        }
        cursorElement.classList.add("visible");
        askInputElement.focus({ preventScroll: true }); // right away, so typing straight after the hotkey isn't lost
      },
      closeCard() {
        cardElement.classList.remove("open");
        cardElement.hidden = true;
      },
      getCardAnchor() {
        return { x: parseFloat(cardElement.style.left) - 18, y: parseFloat(cardElement.style.top) - 14 };
      },
      getSelectedMode: () => selectedMode,
      setSelectedMode(modeKey) {
        if (selectedMode !== modeKey) selectMode(modeKey);
      },
      setWorking(working) {
        isWorking = working;
        askInputElement.disabled = working;
        updateGoButton();
        if (!working && !cardElement.hidden) askInputElement.focus();
      },
      clearOutput() {
        stepsElement.innerHTML = "";
        answerElement.textContent = "";
        errorElement.textContent = "";
      },
      addStep(stepText) {
        stepsElement.querySelector(".step.active")?.classList.remove("active");
        const stepElement = document.createElement("li");
        stepElement.className = "step active";
        stepElement.textContent = stepText;
        stepsElement.appendChild(stepElement);
        outputElement.scrollTop = outputElement.scrollHeight;
      },
      finishSteps() {
        stepsElement.querySelector(".step.active")?.classList.remove("active");
      },
      getSteps: () => [...stepsElement.children].map((stepElement) => stepElement.textContent),
      setAnswer(answerText) {
        answerElement.textContent = answerText;
        outputElement.scrollTop = outputElement.scrollHeight;
        // With the card closed (a guide running in the background), say it from the cursor, Clicky-style.
        if (cardElement.hidden && answerText) {
          cursorBubbleElement.textContent = answerText;
          cursorBubbleElement.hidden = false;
          clearTimeout(cursorBubbleTimeoutId);
          cursorBubbleTimeoutId = setTimeout(() => (cursorBubbleElement.hidden = true), CURSOR_BUBBLE_DURATION_MS);
        }
      },
      setError(errorText) {
        errorElement.textContent = errorText;
      },
      renderPlan(activePlan) {
        planElement.hidden = !activePlan;
        cursorPillElement.hidden = !activePlan;
        if (!activePlan) return;
        planGoalElement.textContent = activePlan.goal;
        planStepsElement.innerHTML = "";
        const currentStepIndex = activePlan.steps.findIndex((planStep) => !planStep.done);
        activePlan.steps.forEach((planStep, planStepIndex) => {
          const planStepElement = document.createElement("li");
          planStepElement.className = `plan-step${planStep.done ? " done" : ""}${planStepIndex === currentStepIndex ? " current" : ""}`;
          planStepElement.textContent = planStep.text;
          planStepsElement.appendChild(planStepElement);
        });
        const doneCount = activePlan.steps.filter((planStep) => planStep.done).length;
        cursorPillElement.textContent =
          currentStepIndex === -1
            ? `All ${activePlan.steps.length} steps done`
            : `${doneCount + 1}/${activePlan.steps.length} · ${activePlan.steps[currentStepIndex].text}`;
      },
      showCursor() {
        cursorElement.classList.add("visible");
      },
      hideCursor() {
        cursorElement.classList.remove("visible");
        cursorLabelElement.classList.remove("visible");
        cursorBubbleElement.hidden = true;
      },
      followPointer(x, y) {
        if (!cursorIsBusy) {
          cursorPosition.x = x + 16;
          cursorPosition.y = y + 14;
          renderCursor();
        }
      },
      setCursorLabel(labelText) {
        cursorLabelElement.textContent = labelText ?? "";
        cursorLabelElement.classList.toggle("visible", Boolean(labelText));
      },
      /** Flies the cursor tip to (x, y) along a curved arc; resolves on arrival. */
      flyCursorTo(targetX, targetY) {
        cursorIsBusy = true;
        cursorElement.classList.add("visible");
        const start = { ...cursorPosition };
        const flightDistance = Math.hypot(targetX - start.x, targetY - start.y);
        const control = { x: (start.x + targetX) / 2, y: Math.min(start.y, targetY) - Math.min(200, flightDistance * 0.35) };
        const durationMs = Math.max(350, Math.min(900, 300 + flightDistance * 0.45));
        const startTime = performance.now();
        return new Promise((resolve) => {
          function flightFrame(now) {
            const progress = Math.min((now - startTime) / durationMs, 1);
            const eased = progress * progress * (3 - 2 * progress);
            const remaining = 1 - eased;
            cursorPosition.x = remaining * remaining * start.x + 2 * remaining * eased * control.x + eased * eased * targetX;
            cursorPosition.y = remaining * remaining * start.y + 2 * remaining * eased * control.y + eased * eased * targetY;
            renderCursor();
            if (progress < 1) requestAnimationFrame(flightFrame);
            else resolve();
          }
          requestAnimationFrame(flightFrame);
        });
      },
      /** Lets the cursor go back to trailing the user's pointer. */
      releaseCursor(pointerX, pointerY) {
        cursorIsBusy = false;
        if (pointerX !== undefined) this.followPointer(pointerX, pointerY);
      },
      pulseClick() {
        cursorElement.classList.remove("clicking");
        void cursorElement.offsetWidth; // restart the animation
        cursorElement.classList.add("clicking");
      },
    };
  }

  // ===================================================================
  // Tools: how the agent acts on the page
  // ===================================================================

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function setNativeValue(element, value) {
    const elementPrototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    // Going through the prototype's setter lets React/Vue-controlled inputs see the change.
    Object.getOwnPropertyDescriptor(elementPrototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function describeToolUse(toolUse, elementsById) {
    const targetElement = elementsById.get(toolUse.input?.element_id);
    const targetName = targetElement ? getAccessibleName(targetElement) || describeElementKind(targetElement) : "";
    switch (toolUse.name) {
      case "read_page": return "Reading the page";
      case "point": return `Pointing at ${targetName ? `“${collapseWhitespace(targetName, 40)}”` : toolUse.input.label}`;
      case "click": return `Clicking ${targetName ? `“${collapseWhitespace(targetName, 40)}”` : "an element"}`;
      case "type": return `Typing “${collapseWhitespace(toolUse.input.text, 40)}”`;
      case "select_option": return `Choosing “${collapseWhitespace(toolUse.input.option, 40)}”`;
      case "scroll": return `Scrolling ${toolUse.input.direction}`;
      case "navigate": return `Opening ${collapseWhitespace(toolUse.input.url, 50)}`;
      case "set_plan": return "Making a plan";
      case "complete_step": return `Step ${toolUse.input.step_number} done`;
      default: return `Running ${toolUse.name.replace(/_/g, " ")}`;
    }
  }

  // ===================================================================
  // Transport and persistence (both replaceable; the extension swaps them)
  // ===================================================================

  function createDefaultTransport(options) {
    return {
      async requestAgentStep(requestBody, abortSignal) {
        const headers = { "content-type": "application/json" };
        if (options.accessToken) headers["x-cursor-agent-token"] = options.accessToken;
        const response = await fetch(`${options.endpoint.replace(/\/+$/, "")}/api/agent`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: abortSignal,
        });
        const responseBody = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(responseBody.error || `Agent request failed (${response.status})`);
        }
        return responseBody;
      },
    };
  }

  function createSessionStoragePersistence() {
    const storageKey = "cursor-agent-state";
    return {
      async load() {
        try {
          return JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
        } catch {
          return null;
        }
      },
      async save(savedState) {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(savedState));
        } catch {
          // Storage full or blocked: the task just won't survive a page load.
        }
      },
      async clear() {
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          // ignore
        }
      },
    };
  }

  // ===================================================================
  // The agent
  // ===================================================================

  function createCursorAgent(userOptions) {
    const options = { ...DEFAULT_OPTIONS, ...userOptions };
    const transport = options.transport ?? createDefaultTransport(options);
    const persistence = options.persistence ?? createSessionStoragePersistence();
    const siteActions = new Map((options.actions ?? []).map((siteAction) => [siteAction.name, siteAction]));

    let conversationMessages = [];
    let currentElementsById = new Map();
    let currentAbortController = null;
    let currentStepCount = 0;
    let activePlan = null; // { goal, steps: [{ text, done }] } while Guide me runs
    let guideCheckInCount = 0;
    let guideCheckInTimeoutId = null;
    let pendingGuideCheckIn = null;
    let lastPointerPosition = null;
    let cursorReleaseTimeoutId = null;
    let currentToolBatch = null; // { toolUses, toolIndex, completedToolResults } while tools run
    const recentPageErrors = [];
    const pageEventListeners = [];

    const agentInterface = createAgentInterface({
      color: options.color,
      label: options.label,
      onSubmit: (request, modeKey) => runTask(request, modeKey),
      onStop: () => stopTask("Stopped."),
      onClose: () => close(),
      onEndGuide: () => endGuide(),
    });

    function listen(eventTarget, eventType, listener, listenerOptions) {
      eventTarget.addEventListener(eventType, listener, listenerOptions);
      pageEventListeners.push(() => eventTarget.removeEventListener(eventType, listener, listenerOptions));
    }

    // ---------- context ----------

    function recordPageError(errorText) {
      recentPageErrors.push(collapseWhitespace(errorText, 300));
      if (recentPageErrors.length > MAX_RECENT_PAGE_ERRORS) recentPageErrors.shift();
    }

    function getSiteActionDefinitions() {
      return [...siteActions.values()].map((siteAction) => ({
        name: siteAction.name,
        description: siteAction.description ?? "",
        parameters: siteAction.parameters ?? { type: "object", properties: {} },
      }));
    }

    function refreshSnapshot() {
      const { snapshotText, elementsById } = takePageSnapshot({
        hostElementToIgnore: agentInterface.hostElement,
        recentPageErrors,
        siteContext: options.siteContext,
      });
      currentElementsById = elementsById;
      return snapshotText;
    }

    // ---------- card and cursor ----------

    function cursorShouldBeVisible() {
      return options.showCursor === "always" || agentInterface.isCardOpen() || Boolean(activePlan) || Boolean(currentAbortController);
    }

    function updateCursorVisibility() {
      if (cursorShouldBeVisible() && lastPointerPosition) agentInterface.showCursor();
      else if (!cursorShouldBeVisible()) agentInterface.hideCursor();
    }

    function open(anchor) {
      const anchorPoint = anchor ?? lastPointerPosition ?? { x: innerWidth / 2, y: innerHeight / 3 };
      agentInterface.openCard(anchorPoint.x, anchorPoint.y);
    }

    /** Hides the card. A running guide keeps going from the cursor; anything else is reset. */
    function close() {
      agentInterface.closeCard();
      if (!activePlan) {
        stopTask(null);
        conversationMessages = [];
        agentInterface.clearOutput();
        persistence.clear();
      }
      updateCursorVisibility();
    }

    function toggle(anchor) {
      if (agentInterface.isCardOpen()) close();
      else open(anchor);
    }

    function endGuide() {
      activePlan = null;
      clearTimeout(guideCheckInTimeoutId);
      pendingGuideCheckIn = null;
      agentInterface.renderPlan(null);
      stopTask(null);
      conversationMessages = [];
      agentInterface.clearOutput();
      persistence.clear();
      updateCursorVisibility();
    }

    // ---------- conversation bookkeeping ----------

    /** Ends a running task, leaving the conversation valid for a follow-up. */
    function stopTask(message) {
      if (!currentAbortController) return;
      currentAbortController.abort();
      currentAbortController = null;
      closeDanglingToolUses("Cancelled by the user.");
      agentInterface.finishSteps();
      agentInterface.setWorking(false);
      if (message) agentInterface.setError(message);
      if (!activePlan) persistence.clear();
    }

    /** Every tool_use needs a tool_result before the next request; fill any gaps. */
    function closeDanglingToolUses(resultText) {
      const lastMessage = conversationMessages[conversationMessages.length - 1];
      if (lastMessage?.role !== "assistant") return;
      const danglingToolUses = lastMessage.content.filter((contentBlock) => contentBlock.type === "tool_use");
      if (danglingToolUses.length) {
        conversationMessages.push({
          role: "user",
          content: danglingToolUses.map((toolUse) => ({ type: "tool_result", tool_use_id: toolUse.id, content: resultText })),
        });
      }
    }

    function describePlanForSummary() {
      return activePlan.steps.map((planStep, planStepIndex) => `${planStepIndex + 1}. ${planStep.text}${planStep.done ? " (done)" : ""}`).join("\n");
    }

    /** Long guides would outgrow the request limit; restart the conversation from a summary of the plan. */
    function compactGuideConversationIfLong() {
      if (!activePlan || conversationMessages.length < COMPACT_CONVERSATION_AFTER_MESSAGES) return;
      conversationMessages = [
        {
          role: "user",
          content: [{ type: "text", text: `[Mode: Guide me] I'm working toward: ${activePlan.goal}\nOur plan so far (already shown to me):\n${describePlanForSummary()}\nKeep guiding me from here.` }],
        },
        { role: "assistant", content: [{ type: "text", text: "Got it, I'll keep guiding you from where you are." }] },
      ];
    }

    function buildSavedState(extraState) {
      return {
        savedAt: Date.now(),
        fromUrl: location.href,
        conversationMessages,
        activePlan,
        guideCheckInCount,
        mode: agentInterface.getSelectedMode(),
        cardOpen: agentInterface.isCardOpen(),
        cardAnchor: agentInterface.getCardAnchor(),
        steps: agentInterface.getSteps(),
        stepCount: currentStepCount,
        ...extraState,
      };
    }

    /**
     * The page is unloading (a click, a form, navigate, or the user). Save
     * whatever is running so the next page can carry on: the unfinished tool
     * batch if tools were running, otherwise the conversation, so the step
     * that was in flight is simply asked again.
     */
    function saveBeforePageUnload() {
      if (!currentAbortController && !activePlan) return;
      const unfinishedToolBatch = currentToolBatch
        ? {
            pendingToolUses: currentToolBatch.toolUses.slice(currentToolBatch.toolIndex),
            completedToolResults: currentToolBatch.completedToolResults,
          }
        : {};
      persistence.save(buildSavedState({ taskWasRunning: Boolean(currentAbortController), ...unfinishedToolBatch }));
    }

    // ---------- tools ----------

    async function moveCursorToElement(element, label) {
      clearTimeout(cursorReleaseTimeoutId);
      if (!isInViewport(element)) {
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        await wait(450);
      }
      const elementRect = element.getBoundingClientRect();
      agentInterface.setCursorLabel(null);
      await agentInterface.flyCursorTo(elementRect.left + Math.min(elementRect.width / 2, 40), elementRect.top + elementRect.height / 2);
      if (label) agentInterface.setCursorLabel(label);
    }

    async function runTool(toolUse) {
      const toolInput = toolUse.input ?? {};
      const targetElement = currentElementsById.get(toolInput.element_id);
      const needsElement = ["point", "click", "type", "select_option"].includes(toolUse.name);
      if (needsElement && (!targetElement || !targetElement.isConnected)) {
        return { text: `No element [${toolInput.element_id}] on the page now. Call read_page for fresh ids.`, isError: true };
      }

      switch (toolUse.name) {
        case "read_page":
          return { text: refreshSnapshot() };

        case "point":
          await moveCursorToElement(targetElement, toolInput.label);
          await wait(HOLD_AFTER_POINT_MS); // long enough to follow when explaining several things
          return { text: `Pointed at [${toolInput.element_id}].` };

        case "click": {
          await moveCursorToElement(targetElement, null);
          agentInterface.pulseClick();
          const urlBeforeClick = location.href;
          targetElement.focus?.({ preventScroll: true });
          targetElement.click();
          await wait(SETTLE_AFTER_ACTION_MS);
          const urlChanged = location.href !== urlBeforeClick;
          return { text: `Clicked [${toolInput.element_id}].${urlChanged ? ` URL is now ${location.href}.` : ""} Call read_page to see the result.` };
        }

        case "type": {
          if (isSensitiveField(targetElement)) {
            return { text: "That field holds a password or payment details; ask the user to fill it in.", isError: true };
          }
          await moveCursorToElement(targetElement, null);
          targetElement.focus?.({ preventScroll: true });
          if (targetElement.isContentEditable) {
            targetElement.textContent = toolInput.text;
            targetElement.dispatchEvent(new InputEvent("input", { bubbles: true }));
          } else if ("value" in targetElement) {
            setNativeValue(targetElement, toolInput.text);
          } else {
            return { text: `[${toolInput.element_id}] isn't a text field.`, isError: true };
          }
          if (toolInput.press_enter) {
            const enterKeyOptions = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
            const enterNotHandled = targetElement.dispatchEvent(new KeyboardEvent("keydown", enterKeyOptions));
            targetElement.dispatchEvent(new KeyboardEvent("keyup", enterKeyOptions));
            if (enterNotHandled && targetElement.form) targetElement.form.requestSubmit();
            await wait(SETTLE_AFTER_ACTION_MS);
          }
          return { text: `Typed into [${toolInput.element_id}]${toolInput.press_enter ? " and pressed Enter" : ""}. Call read_page to see the result.` };
        }

        case "select_option": {
          if (targetElement.tagName !== "SELECT") {
            return { text: `[${toolInput.element_id}] isn't a dropdown; click it instead.`, isError: true };
          }
          const wantedOption = String(toolInput.option).toLowerCase();
          const matchingOption = [...targetElement.options].find(
            (option) => option.value.toLowerCase() === wantedOption || option.text.trim().toLowerCase() === wantedOption,
          );
          if (!matchingOption) {
            return { text: `No option "${toolInput.option}" in [${toolInput.element_id}].`, isError: true };
          }
          await moveCursorToElement(targetElement, null);
          targetElement.value = matchingOption.value;
          targetElement.dispatchEvent(new Event("input", { bubbles: true }));
          targetElement.dispatchEvent(new Event("change", { bubbles: true }));
          return { text: `Selected "${matchingOption.text.trim()}".` };
        }

        case "scroll":
          window.scrollBy({ top: (toolInput.direction === "up" ? -1 : 1) * innerHeight * 0.8, behavior: "smooth" });
          await wait(500);
          return { text: `Scrolled ${toolInput.direction}. Call read_page to see what's visible now.` };

        case "navigate": {
          let destinationUrl;
          try {
            destinationUrl = new URL(toolInput.url, location.href);
          } catch {
            return { text: `"${toolInput.url}" isn't a valid URL.`, isError: true };
          }
          if (!["http:", "https:"].includes(destinationUrl.protocol)) {
            return { text: "Only http and https addresses can be opened.", isError: true };
          }
          location.href = destinationUrl.href;
          await wait(8000); // the page normally unloads before this
          return { text: `Navigation to ${destinationUrl.href} didn't load a new page. Call read_page.` };
        }

        case "set_plan": {
          const planSteps = (toolInput.steps ?? []).map((stepText) => collapseWhitespace(stepText, 80)).filter(Boolean).slice(0, 7);
          if (planSteps.length === 0) return { text: "A plan needs at least one step.", isError: true };
          activePlan = { goal: collapseWhitespace(toolInput.goal, 80), steps: planSteps.map((stepText) => ({ text: stepText, done: false })) };
          guideCheckInCount = 0;
          agentInterface.renderPlan(activePlan);
          updateCursorVisibility();
          return { text: `Plan shown with ${planSteps.length} steps. Point at what to do for step 1, then stop and let the user act.` };
        }

        case "complete_step": {
          const planStep = activePlan?.steps[toolInput.step_number - 1];
          if (!planStep) return { text: "There's no such step in the current plan.", isError: true };
          planStep.done = true;
          agentInterface.renderPlan(activePlan);
          const remainingSteps = activePlan.steps.filter((step) => !step.done).length;
          return { text: remainingSteps ? `Step ${toolInput.step_number} ticked off; ${remainingSteps} to go.` : "Every step is done. Congratulate the user briefly." };
        }

        default: {
          const siteAction = siteActions.get(toolUse.name);
          if (!siteAction) {
            return { text: `Unknown tool ${toolUse.name}.`, isError: true };
          }
          const siteActionResult = await siteAction.run(toolInput);
          const resultText = typeof siteActionResult === "string" ? siteActionResult : JSON.stringify(siteActionResult ?? "done");
          return { text: collapseWhitespace(resultText, MAX_TOOL_RESULT_CHARACTERS) || "done" };
        }
      }
    }

    /** Runs one batch of tool uses and returns their tool_result blocks. */
    async function runToolBatch(toolUses, abortSignal) {
      const toolResults = [];
      for (let toolIndex = 0; toolIndex < toolUses.length; toolIndex++) {
        const toolUse = toolUses[toolIndex];
        if (abortSignal.aborted) return toolResults;
        agentInterface.addStep(describeToolUse(toolUse, currentElementsById));
        currentToolBatch = { toolUses, toolIndex, completedToolResults: [...toolResults] };
        let toolOutcome;
        try {
          toolOutcome = await runTool(toolUse);
        } catch (error) {
          toolOutcome = { text: `Error: ${error?.message ?? error}`, isError: true };
        } finally {
          currentToolBatch = null;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: truncateText(toolOutcome.text, 20000), // keep line breaks: snapshots are line-based
          ...(toolOutcome.isError ? { is_error: true } : {}),
        });
      }
      return toolResults;
    }

    // ---------- the loop ----------

    /** Calls Claude, runs the tools it asks for, and repeats until it answers. */
    async function continueAgentLoop(abortController) {
      const abortSignal = abortController.signal;
      try {
        while (currentStepCount < options.maxSteps) {
          currentStepCount++;
          const agentStep = await transport.requestAgentStep(
            { messages: conversationMessages, siteActions: getSiteActionDefinitions() },
            abortSignal,
          );
          if (abortSignal.aborted) return;
          conversationMessages.push({ role: "assistant", content: agentStep.content });

          if (agentStep.stop_reason === "refusal") {
            // A refused turn can't be continued, so the next request starts fresh.
            conversationMessages = [];
            agentInterface.setAnswer("Sorry, I can't help with that one.");
            return;
          }

          const replyText = agentStep.content
            .filter((contentBlock) => contentBlock.type === "text")
            .map((contentBlock) => contentBlock.text)
            .join("\n")
            .trim();
          const toolUses = agentStep.content.filter((contentBlock) => contentBlock.type === "tool_use");
          if (toolUses.length === 0) {
            agentInterface.setAnswer(replyText || "Done.");
            return;
          }

          const toolResults = await runToolBatch(toolUses, abortSignal);
          if (abortSignal.aborted) return;
          conversationMessages.push({ role: "user", content: toolResults });
        }
        closeDanglingToolUses("Stopped: step limit reached.");
        agentInterface.setError(`Stopped after ${options.maxSteps} steps. Try a more specific request.`);
      } catch (error) {
        if (abortSignal.aborted) return;
        closeDanglingToolUses("The request failed.");
        agentInterface.setError(String(error?.message ?? error));
      } finally {
        if (currentAbortController === abortController) {
          currentAbortController = null;
          agentInterface.finishSteps();
          agentInterface.setWorking(false);
          if (activePlan) {
            // Keep the guide alive across page loads and run any check-in that queued up meanwhile.
            persistence.save(buildSavedState());
            if (pendingGuideCheckIn) {
              const queuedCheckIn = pendingGuideCheckIn;
              pendingGuideCheckIn = null;
              scheduleGuideCheckIn(queuedCheckIn);
            }
          }
          cursorReleaseTimeoutId = setTimeout(() => {
            agentInterface.releaseCursor(lastPointerPosition?.x, lastPointerPosition?.y);
            agentInterface.setCursorLabel(null);
            updateCursorVisibility();
          }, CURSOR_HOLD_AFTER_TASK_MS);
        }
      }
    }

    function beginWorking() {
      stopTask(null);
      clearTimeout(cursorReleaseTimeoutId);
      const abortController = new AbortController();
      currentAbortController = abortController;
      agentInterface.setWorking(true);
      return abortController;
    }

    async function runTask(request, modeKey) {
      if (!agentInterface.isCardOpen()) open();
      const abortController = beginWorking();
      agentInterface.clearOutput();
      currentStepCount = 0;
      agentInterface.addStep("Reading the page");
      const snapshotText = refreshSnapshot();
      const modeLine = modeKey ? `[Mode: ${MODES[modeKey].label}]\n` : "";
      conversationMessages.push({
        role: "user",
        content: [{ type: "text", text: `${modeLine}${request}\n\n<page_snapshot>\n${snapshotText}\n</page_snapshot>` }],
      });
      await continueAgentLoop(abortController);
    }

    // ---------- Guide me: check in as the user acts ----------

    function scheduleGuideCheckIn(userActivityDescription) {
      if (!activePlan || activePlan.steps.every((planStep) => planStep.done)) return;
      if (currentAbortController) {
        pendingGuideCheckIn = userActivityDescription; // run once the current step finishes
        return;
      }
      clearTimeout(guideCheckInTimeoutId);
      guideCheckInTimeoutId = setTimeout(() => runGuideCheckIn(userActivityDescription), GUIDE_CHECK_IN_DELAY_MS);
    }

    async function runGuideCheckIn(userActivityDescription) {
      if (!activePlan || currentAbortController || guideCheckInCount >= MAX_GUIDE_CHECK_INS) return;
      guideCheckInCount++;
      compactGuideConversationIfLong();
      const abortController = beginWorking();
      agentInterface.clearOutput();
      currentStepCount = 0;
      agentInterface.addStep("Checking your progress");
      const snapshotText = refreshSnapshot();
      conversationMessages.push({
        role: "user",
        content: [{
          type: "text",
          text: `[Guide check-in] ${userActivityDescription} Check the plan against the page: complete_step for anything now finished, then point at what to do next, or steer me back if I've drifted. Reply in one short sentence.\n\n<page_snapshot>\n${snapshotText}\n</page_snapshot>`,
        }],
      });
      await continueAgentLoop(abortController);
    }

    // ---------- resuming after a page load ----------

    async function restoreSavedState(savedState) {
      conversationMessages = savedState.conversationMessages ?? [];
      activePlan = savedState.activePlan ?? null;
      guideCheckInCount = savedState.guideCheckInCount ?? 0;
      currentStepCount = savedState.stepCount ?? 0;
      agentInterface.renderPlan(activePlan);
      if (savedState.mode) agentInterface.setSelectedMode(savedState.mode);
      if (savedState.cardOpen || savedState.pendingToolUses?.length) {
        agentInterface.openCard(savedState.cardAnchor?.x ?? innerWidth / 2, savedState.cardAnchor?.y ?? innerHeight / 3);
      }
      updateCursorVisibility();
    }

    /** Picks up a tool batch that was interrupted when one of its actions loaded this page. */
    async function resumeToolBatch(savedState) {
      for (const stepText of savedState.steps ?? []) agentInterface.addStep(stepText);
      const abortController = beginWorking();
      const [interruptedToolUse, ...skippedToolUses] = savedState.pendingToolUses;
      conversationMessages.push({
        role: "user",
        content: [
          ...(savedState.completedToolResults ?? []),
          { type: "tool_result", tool_use_id: interruptedToolUse.id, content: `Done. That loaded a new page: ${location.href}. Call read_page to see it.` },
          ...skippedToolUses.map((skippedToolUse) => ({
            type: "tool_result",
            tool_use_id: skippedToolUse.id,
            content: "Not run: the page changed before this step.",
          })),
        ],
      });
      await continueAgentLoop(abortController);
    }

    async function resumeFromSavedState() {
      const savedState = await persistence.load();
      if (!savedState) return;
      await persistence.clear();
      const savedAgeMs = Date.now() - (savedState.savedAt ?? 0);

      if (savedState.taskWasRunning && savedAgeMs < TASK_RESUME_MAX_AGE_MS) {
        await restoreSavedState(savedState);
        if (savedState.pendingToolUses?.length) {
          await resumeToolBatch(savedState);
        } else if (conversationMessages.at(-1)?.role === "user") {
          // A request was in flight when the page unloaded; ask it again here.
          for (const stepText of savedState.steps ?? []) agentInterface.addStep(stepText);
          await continueAgentLoop(beginWorking());
        }
      } else if (savedState.activePlan && savedAgeMs < GUIDE_RESUME_MAX_AGE_MS) {
        await restoreSavedState(savedState);
        closeDanglingToolUses("The page reloaded before this step.");
        const pageChanged = savedState.fromUrl !== location.href;
        scheduleGuideCheckIn(pageChanged ? `I moved to a new page: ${location.href}.` : "The page reloaded.");
      }
    }

    // ---------- page wiring ----------

    listen(
      document,
      "mousemove",
      (mouseEvent) => {
        const isFirstMove = !lastPointerPosition;
        lastPointerPosition = { x: mouseEvent.clientX, y: mouseEvent.clientY };
        agentInterface.followPointer(mouseEvent.clientX, mouseEvent.clientY);
        if (isFirstMove) updateCursorVisibility();
      },
      { passive: true },
    );

    // Guide me: every click or form submit by the user triggers a progress check-in.
    listen(
      document,
      "click",
      (mouseEvent) => {
        if (!activePlan || !mouseEvent.isTrusted || mouseEvent.composedPath().includes(agentInterface.hostElement)) return;
        const clickedElement = mouseEvent.target instanceof Element ? mouseEvent.target.closest(INTERACTIVE_ELEMENT_SELECTOR) ?? mouseEvent.target : null;
        const clickedName = clickedElement ? getAccessibleName(clickedElement) || describeElementKind(clickedElement) : "the page";
        // If this click loads a new page, pagehide saves the guide and it checks in on arrival.
        scheduleGuideCheckIn(`I clicked “${collapseWhitespace(clickedName, 60)}”.`);
      },
      true,
    );
    listen(document, "submit", (submitEvent) => {
      if (!activePlan || !submitEvent.isTrusted) return;
      scheduleGuideCheckIn("I submitted a form.");
    }, true);

    listen(window, "pagehide", saveBeforePageUnload);

    // Troubleshoot: remember what went wrong on the page.
    listen(window, "error", (errorEvent) => {
      if (errorEvent instanceof ErrorEvent) {
        recordPageError(`${errorEvent.message}${errorEvent.filename ? ` (${errorEvent.filename.split("/").pop()}:${errorEvent.lineno})` : ""}`);
      } else if (errorEvent.target instanceof Element) {
        const failedResource = errorEvent.target.src || errorEvent.target.href;
        if (failedResource) recordPageError(`Failed to load ${errorEvent.target.tagName.toLowerCase()}: ${failedResource}`);
      }
    }, true);
    listen(window, "unhandledrejection", (rejectionEvent) => {
      recordPageError(`Unhandled promise rejection: ${rejectionEvent.reason?.message ?? rejectionEvent.reason}`);
    });

    if (options.hotkey) {
      // ctrl + option: pressing the second of the two keys toggles the card.
      let chordAlreadyFired = false;
      listen(window, "keydown", (keyboardEvent) => {
        const isChordKey = keyboardEvent.key === "Control" || keyboardEvent.key === "Alt";
        if (isChordKey && keyboardEvent.ctrlKey && keyboardEvent.altKey && !chordAlreadyFired) {
          chordAlreadyFired = true;
          toggle();
        }
      }, true);
      listen(window, "keyup", (keyboardEvent) => {
        if (!keyboardEvent.ctrlKey || !keyboardEvent.altKey) chordAlreadyFired = false;
      }, true);
    }

    resumeFromSavedState();

    return {
      open,
      close,
      toggle,
      /** Opens the card and runs a request right away; mode is "explain", "troubleshoot", "pitch", "guide" or omitted. */
      ask(request, modeKey) {
        if (modeKey) agentInterface.setSelectedMode(modeKey);
        return runTask(request, modeKey ?? agentInterface.getSelectedMode());
      },
      registerAction(siteAction) {
        siteActions.set(siteAction.name, siteAction);
      },
      setSiteContext(siteContext) {
        options.siteContext = siteContext;
      },
      destroy() {
        endGuide();
        close();
        pageEventListeners.forEach((removeListener) => removeListener());
        agentInterface.hostElement.remove();
      },
    };
  }

  let sharedAgentInstance = null;
  window.CursorAgent = {
    init(options = {}) {
      sharedAgentInstance?.destroy();
      sharedAgentInstance = createCursorAgent(options);
      return sharedAgentInstance;
    },
    open: (anchor) => sharedAgentInstance?.open(anchor),
    close: () => sharedAgentInstance?.close(),
    toggle: (anchor) => sharedAgentInstance?.toggle(anchor),
    ask: (request, modeKey) => sharedAgentInstance?.ask(request, modeKey),
    registerAction: (siteAction) => sharedAgentInstance?.registerAction(siteAction),
    setSiteContext: (siteContext) => sharedAgentInstance?.setSiteContext(siteContext),
  };
})();

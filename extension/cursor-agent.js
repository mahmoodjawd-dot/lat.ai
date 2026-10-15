/*
 * Cursor Agent SDK
 *
 * A second cursor, a small triangle like Clicky's, that trails your own on any
 * page that loads this script. Press ctrl + option (ctrl + alt on
 * Windows/Linux) and a speech bubble opens from it. Ask anything: the agent
 * works out where you are (site, page, section, what your pointer is on) and
 * what kind of help fits, then does it, narrating in the bubble as the
 * triangle flies around the page:
 *   - do things: click, type, choose, scroll, navigate and run site actions
 *   - explain what's on the page, pointing at each part
 *   - troubleshoot errors and blocked forms, pointing at the fix
 *   - pitch the product using context the site provides
 *   - guide you through a goal step by step, checking in as you click
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
    showCursor: "always", // "always": trail the pointer everywhere; "active": only while the agent is busy or a guide runs
    color: "#34a56f", // the triangle and speech bubble
    placeholder: "Ask me anything about this page",
    maxSteps: 20,
    transport: null, // { requestAgentStep(body, signal) } to route requests elsewhere (the extension uses this)
    persistence: null, // { load(), save(state), clear() } to carry tasks and guides across page loads
  };

  // The agent picks the right kind of help itself; ask(request, mode) can force one.
  const MODE_LABELS = { do: "Do", explain: "Explain", troubleshoot: "Troubleshoot", pitch: "Pitch", guide: "Guide me" };

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
  const ANSWER_MIN_LINGER_MS = 6000;
  const ANSWER_LINGER_PER_WORD_MS = 350;
  const CONVERSATION_IDLE_RESET_MS = 5 * 60 * 1000;

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
    const region = describeRegion(element);
    const descriptionParts = [region ? `(${region}) ${describeElementKind(element)}` : describeElementKind(element)];
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

  // ---------- orientation: where on the web the user is ----------

  const REGION_SELECTOR = "nav, header, footer, aside, dialog, [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary'], [role='dialog'], [role='menu'], [role='search'], form";
  const PRICE_PATTERN = /(?:[$€£¥₹]\s?\d[\d,.]*(?:\s?\/\s?(?:month|mo|year|yr)\b)?|\d[\d,.]*\s?(?:USD|EUR|GBP))/g;

  /** A short tag for the part of the page an element sits in, e.g. "nav" or "form: Sign up". */
  function describeRegion(element) {
    const regionElement = element.parentElement?.closest(REGION_SELECTOR);
    if (!regionElement) return "";
    const role = regionElement.getAttribute("role");
    const tagName = regionElement.tagName.toLowerCase();
    const regionKind =
      { navigation: "nav", banner: "header", contentinfo: "footer", complementary: "aside" }[role] ?? role ?? tagName;
    if (regionKind === "form" || regionKind === "dialog" || regionKind === "search") {
      const regionName = collapseWhitespace(
        regionElement.getAttribute("aria-label") || regionElement.querySelector("h1, h2, h3, legend")?.innerText || "",
        40,
      );
      return regionName ? `${regionKind}: ${regionName}` : regionKind;
    }
    return regionKind;
  }

  function readStructuredData() {
    const structuredTypes = new Set();
    const structuredFacts = [];
    for (const scriptElement of document.querySelectorAll('script[type="application/ld+json"]')) {
      let parsedData;
      try {
        parsedData = JSON.parse(scriptElement.textContent);
      } catch {
        continue;
      }
      const pendingNodes = Array.isArray(parsedData) ? [...parsedData] : [parsedData];
      while (pendingNodes.length && structuredFacts.length < 8) {
        const node = pendingNodes.shift();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node["@graph"])) pendingNodes.push(...node["@graph"]);
        const nodeTypes = [].concat(node["@type"] ?? []);
        nodeTypes.forEach((nodeType) => structuredTypes.add(String(nodeType)));
        if (nodeTypes.includes("Product") && node.name) {
          const offer = [].concat(node.offers ?? [])[0];
          const offerPrice = offer?.price ?? offer?.lowPrice;
          structuredFacts.push(`Product: ${collapseWhitespace(node.name, 80)}${offerPrice ? ` at ${offerPrice} ${offer.priceCurrency ?? ""}`.trimEnd() : ""}`);
        }
        if (nodeTypes.includes("BreadcrumbList") && Array.isArray(node.itemListElement)) {
          const crumbNames = node.itemListElement.map((crumb) => crumb.name ?? crumb.item?.name).filter(Boolean);
          if (crumbNames.length) structuredFacts.push(`Breadcrumbs: ${crumbNames.join(" › ")}`);
        }
      }
    }
    return { structuredTypes: [...structuredTypes].slice(0, 8), structuredFacts };
  }

  function readBreadcrumbs() {
    const breadcrumbElement = document.querySelector("[aria-label*='breadcrumb' i], .breadcrumb, .breadcrumbs, [class*='breadcrumb' i]");
    if (!breadcrumbElement || !isRendered(breadcrumbElement)) return "";
    const crumbTexts = [...breadcrumbElement.querySelectorAll("a, li, span")]
      .map((crumbElement) => collapseWhitespace(crumbElement.innerText, 40))
      .filter((crumbText, crumbIndex, allCrumbs) => crumbText && allCrumbs.indexOf(crumbText) === crumbIndex);
    return crumbTexts.slice(0, 8).join(" › ");
  }

  function findOpenDialog(hostElementToIgnore) {
    const dialogElement = [...document.querySelectorAll("dialog[open], [role='dialog'], [aria-modal='true']")].find(
      (candidate) => candidate !== hostElementToIgnore && isRendered(candidate),
    );
    if (!dialogElement) return "";
    return collapseWhitespace(
      dialogElement.getAttribute("aria-label") || dialogElement.querySelector("h1, h2, h3")?.innerText || dialogElement.innerText,
      100,
    );
  }

  /** Prices with a few words of what they belong to, e.g. "Pro: $20 / month". */
  function findPricesOnScreen(mainContentElement) {
    const textLines = (mainContentElement?.innerText ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    const priceMentions = [];
    textLines.forEach((line, lineIndex) => {
      for (const priceMatch of line.matchAll(PRICE_PATTERN)) {
        const lineWithoutPrice = line.replace(priceMatch[0], "").replace(/[\s:–—-]+$/, "").trim();
        // A line that is only the price takes its label from the line above (a plan or product name).
        const priceLabel = lineWithoutPrice.length >= 3 ? lineWithoutPrice : textLines[lineIndex - 1] ?? "";
        priceMentions.push(`${collapseWhitespace(priceLabel, 50)}: ${priceMatch[0]}${lineWithoutPrice.length < 3 && lineWithoutPrice ? ` ${lineWithoutPrice}` : ""}`);
        if (priceMentions.length >= 8) return;
      }
    });
    return [...new Set(priceMentions)].slice(0, 8);
  }

  /** What the user's own pointer is resting on, so "what is this?" has an answer. */
  function describeElementUnderPointer(pointerPosition, elementsById, hostElementToIgnore) {
    if (!pointerPosition) return "";
    const elementAtPointer = document.elementFromPoint(pointerPosition.x, pointerPosition.y);
    if (!elementAtPointer || elementAtPointer === hostElementToIgnore || elementAtPointer === document.body || elementAtPointer === document.documentElement) {
      return "";
    }
    for (const [elementId, element] of elementsById) {
      if (element === elementAtPointer || element.contains(elementAtPointer)) return `[${elementId}] ${describeElement(element)}`;
    }
    const blockElement = elementAtPointer.closest("p, li, td, th, figure, section, article, div") ?? elementAtPointer;
    const imageAlt = elementAtPointer.tagName === "IMG" ? elementAtPointer.getAttribute("alt") : "";
    return imageAlt ? `image "${collapseWhitespace(imageAlt, 80)}"` : `text "${collapseWhitespace(blockElement.innerText, 140)}"`;
  }

  function describeWhereTheUserIs({ hostElementToIgnore, mainContentElement, pointerPosition, elementsById }) {
    const siteName =
      document.querySelector('meta[property="og:site_name"]')?.content ||
      document.querySelector('meta[name="application-name"]')?.content ||
      location.hostname.replace(/^www\./, "");
    const openGraphType = document.querySelector('meta[property="og:type"]')?.content;
    const { structuredTypes, structuredFacts } = readStructuredData();
    const formsOnPage = [...document.forms].filter(isRendered);
    const formHints = formsOnPage
      .map((formElement) => {
        const formText = `${formElement.getAttribute("aria-label") ?? ""} ${formElement.querySelector("button, [type=submit]")?.innerText ?? ""} ${formElement.action ?? ""}`.toLowerCase();
        if (/sign ?in|log ?in/.test(formText)) return "sign-in form";
        if (/sign ?up|register|create account/.test(formText)) return "sign-up form";
        if (/checkout|payment|place order/.test(formText)) return "checkout form";
        if (/search/.test(formText)) return "search form";
        return null;
      })
      .filter(Boolean);
    const pageKindHints = [openGraphType, ...structuredTypes, ...new Set(formHints)].filter(Boolean);
    const breadcrumbs = readBreadcrumbs();
    const openDialog = findOpenDialog(hostElementToIgnore);
    const headingsInView = [...document.querySelectorAll("h1, h2")]
      .filter((headingElement) => isRendered(headingElement) && isInViewport(headingElement))
      .map((headingElement) => collapseWhitespace(headingElement.innerText, 60))
      .slice(0, 4);
    const pricesOnScreen = findPricesOnScreen(mainContentElement);
    const underPointer = describeElementUnderPointer(pointerPosition, elementsById, hostElementToIgnore);

    return [
      `Site: ${siteName}`,
      pageKindHints.length ? `Page kind hints: ${pageKindHints.join(", ")}` : null,
      breadcrumbs ? `Breadcrumbs: ${breadcrumbs}` : null,
      ...structuredFacts,
      openDialog ? `A dialog or popup is open: ${openDialog}` : null,
      headingsInView.length ? `On screen now: ${headingsInView.join(" / ")}` : null,
      pricesOnScreen.length ? `Prices on the page: ${pricesOnScreen.join("; ")}` : null,
      underPointer ? `The user's pointer is on: ${underPointer}` : null,
    ].filter(Boolean);
  }

  /**
   * Numbers the page's visible interactive elements and headings, on-screen
   * ones first, and returns the text the agent reads plus an id → element map
   * for the tools. Ids only stay valid until the next snapshot.
   */
  function takePageSnapshot({ hostElementToIgnore, recentPageErrors, siteContext, pointerPosition }) {
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
    const whereTheUserIs = describeWhereTheUserIs({ hostElementToIgnore, mainContentElement, pointerPosition, elementsById });

    const snapshotText = [
      "Where the user is:",
      ...whereTheUserIs,
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
  // UI: the agent's triangle cursor and its speech bubble (in a shadow root)
  // ===================================================================

  // The triangle's tip sits at the agent element's origin, so translating the
  // element to a point puts the tip exactly there, and rotation pivots on it.
  const IDLE_TRIANGLE_ANGLE_DEGREES = -18;
  const TRAIL_OFFSET_X = 30;
  const TRAIL_OFFSET_Y = 30;

  const UI_STYLES = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
      font: 600 15px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif;
      -webkit-font-smoothing: antialiased; }
    [hidden] { display: none !important; }

    .agent { position: absolute; left: 0; top: 0; will-change: transform; opacity: 0; transition: opacity 220ms ease; }
    .agent.visible { opacity: 1; }
    .triangle { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; will-change: transform; }
    .triangle svg { position: absolute; left: -19px; top: -9px; overflow: visible;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,.25)) drop-shadow(0 0 7px color-mix(in srgb, var(--agent-color) 55%, transparent)); }
    .ring { position: absolute; left: -16px; top: -16px; width: 32px; height: 32px; border-radius: 50%;
      border: 2px solid var(--agent-color); opacity: 0; }
    .agent.clicking .ring { animation: ring 650ms ease-out; }
    @keyframes ring { from { transform: scale(.3); opacity: .9; } to { transform: scale(2); opacity: 0; } }

    .stack { position: absolute; left: -20px; top: 22px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
    .agent.flip-x .stack { left: auto; right: -6px; align-items: flex-end; }
    .agent.flip-y .stack { top: auto; bottom: 22px; flex-direction: column-reverse; }

    .bubble { pointer-events: auto; box-sizing: border-box; width: max-content; min-width: 120px; max-width: min(380px, calc(100vw - 32px));
      padding: 10px 14px; border-radius: 11px; color: #fff;
      background: color-mix(in srgb, var(--agent-color) 90%, transparent);
      box-shadow: 0 8px 24px rgba(0,0,0,.22), inset 0 0 0 1px rgba(255,255,255,.12);
      -webkit-backdrop-filter: blur(10px) saturate(1.3); backdrop-filter: blur(10px) saturate(1.3);
      transform-origin: top left; animation: pop 160ms ease-out; }
    .agent.flip-x .bubble { transform-origin: top right; }
    @keyframes pop { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: none; } }
    .bubble.error { background: color-mix(in srgb, #c2410c 92%, transparent); }
    .bubble.answer { cursor: pointer; }
    .bubble-text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow-y: auto; }
    .bubble.working .bubble-text::after { content: ""; display: inline-block; width: 1.2em; text-align: left;
      animation: dots 1.2s steps(4, end) infinite; }
    @keyframes dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }
    .bubble-input { display: block; width: 300px; max-width: 100%; margin: 0; padding: 0; border: 0; outline: none; background: transparent;
      color: #fff; font: inherit; caret-color: #fff; }
    .bubble-input::placeholder { color: rgba(255,255,255,.72); }
    .bubble-hint { margin-top: 6px; font-size: 11.5px; font-weight: 500; color: rgba(255,255,255,.72); }

    .label { pointer-events: none; padding: 3px 9px; border-radius: 999px; background: #fff; color: color-mix(in srgb, var(--agent-color) 80%, #000);
      font-size: 12px; font-weight: 700; box-shadow: 0 2px 8px rgba(0,0,0,.18); animation: pop 140ms ease-out; }

    .plan-chip { pointer-events: auto; display: flex; align-items: center; gap: 8px; max-width: 320px; padding: 5px 6px 5px 11px; border-radius: 999px;
      background: rgba(17, 24, 39, .88); color: #fff; font-size: 12.5px; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.22);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
    .plan-count { flex: none; color: var(--agent-color); filter: brightness(1.35); }
    .plan-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .plan-end { flex: none; width: 20px; height: 20px; border: 0; border-radius: 50%; background: rgba(255,255,255,.12); color: #fff;
      font: 600 13px/1 system-ui, sans-serif; cursor: pointer; }
    .plan-end:hover { background: rgba(255,255,255,.25); }
    button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

    @media (prefers-reduced-motion: reduce) { .bubble, .label { animation: none; } }
  `;

  function createAgentInterface({ color, onSubmit, onDismiss, onEndGuide, onAnswerClick }) {
    const hostElement = document.createElement("cursor-agent");
    const shadowRoot = hostElement.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <style>${UI_STYLES}</style>
      <div class="layer">
        <div class="agent">
          <div class="ring"></div>
          <div class="triangle">
            <svg width="22" height="18" viewBox="-19 -9 22 18" aria-hidden="true">
              <path d="M1.5 0 L-17 -7.5 Q-18.6 -8.1 -18.2 -6.4 L-15.5 0 L-18.2 6.4 Q-18.6 8.1 -17 7.5 Z" fill="var(--agent-color)" stroke="rgba(255,255,255,.9)" stroke-width="1.2" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="stack">
            <div class="label" hidden></div>
            <form class="bubble" hidden aria-live="polite">
              <div class="bubble-text"></div>
              <input class="bubble-input" type="text" autocomplete="off" aria-label="Ask Cursor Agent" hidden>
              <div class="bubble-hint" hidden></div>
            </form>
            <div class="plan-chip" hidden>
              <span class="plan-count"></span><span class="plan-text"></span>
              <button type="button" class="plan-end" aria-label="End guide" title="End guide">×</button>
            </div>
          </div>
        </div>
      </div>`;
    const select = (selector) => shadowRoot.querySelector(selector);
    const layerElement = select(".layer");
    const agentElement = select(".agent");
    const triangleElement = select(".triangle");
    const labelElement = select(".label");
    const bubbleElement = select(".bubble");
    const bubbleTextElement = select(".bubble-text");
    const bubbleInputElement = select(".bubble-input");
    const bubbleHintElement = select(".bubble-hint");
    const planChipElement = select(".plan-chip");
    const planCountElement = select(".plan-count");
    const planTextElement = select(".plan-text");
    layerElement.style.setProperty("--agent-color", color);
    document.documentElement.appendChild(hostElement);

    const agentPosition = { x: innerWidth / 2, y: innerHeight / 2 };
    let triangleAngle = IDLE_TRIANGLE_ANGLE_DEGREES;
    let agentIsBusy = false; // flying to or holding on an element instead of trailing the pointer
    let bubbleState = "hidden"; // hidden | input | working | answer | error
    let bubbleHideTimeoutId = null;

    function render() {
      agentElement.style.transform = `translate3d(${agentPosition.x}px, ${agentPosition.y}px, 0)`;
      triangleElement.style.transform = `rotate(${triangleAngle}deg)`;
      agentElement.classList.toggle("flip-x", agentPosition.x > innerWidth - 400);
      agentElement.classList.toggle("flip-y", agentPosition.y > innerHeight - 190);
    }
    render();

    function setBubble(state, text, { placeholder, hint } = {}) {
      clearTimeout(bubbleHideTimeoutId);
      bubbleState = state;
      bubbleElement.hidden = state === "hidden";
      bubbleElement.className = `bubble ${state}`;
      const isInput = state === "input";
      bubbleInputElement.hidden = !isInput;
      bubbleTextElement.hidden = isInput;
      bubbleHintElement.hidden = !hint;
      bubbleHintElement.textContent = hint ?? "";
      if (isInput) {
        bubbleInputElement.placeholder = placeholder ?? "";
        bubbleInputElement.value = "";
        bubbleInputElement.focus({ preventScroll: true }); // right away, so typing straight after the hotkey isn't lost
      } else {
        bubbleTextElement.textContent = text ?? "";
        bubbleTextElement.scrollTop = bubbleTextElement.scrollHeight;
      }
      if (state !== "hidden") agentElement.classList.add("visible");
    }

    bubbleElement.addEventListener("submit", (submitEvent) => {
      submitEvent.preventDefault();
      const request = bubbleInputElement.value.trim();
      if (bubbleState === "input" && request) onSubmit(request);
    });
    bubbleElement.addEventListener("click", () => {
      if (bubbleState === "answer" || bubbleState === "error") onAnswerClick();
    });
    select(".plan-end").addEventListener("click", onEndGuide);
    // Keep the page's own shortcuts from firing while typing in the bubble.
    for (const keyboardEventType of ["keydown", "keyup", "keypress"]) {
      bubbleElement.addEventListener(keyboardEventType, (keyboardEvent) => {
        if (keyboardEvent.key === "Escape" && keyboardEventType === "keydown") onDismiss();
        keyboardEvent.stopPropagation();
      });
    }

    return {
      hostElement,
      getBubbleState: () => bubbleState,
      isTyping: () => bubbleState === "input",
      isBubbleVisible: () => bubbleState !== "hidden",
      showInput(placeholder, hint) {
        setBubble("input", null, { placeholder, hint });
      },
      showStatus(statusText) {
        setBubble("working", statusText);
      },
      showAnswer(answerText, lingerMs) {
        setBubble("answer", answerText);
        if (lingerMs) bubbleHideTimeoutId = setTimeout(() => setBubble("hidden"), lingerMs);
      },
      showError(errorText) {
        setBubble("error", errorText, { hint: "Click to try again · esc to close" });
      },
      hideBubble() {
        setBubble("hidden");
      },
      renderPlan(activePlan) {
        planChipElement.hidden = !activePlan;
        if (!activePlan) return;
        const currentStepIndex = activePlan.steps.findIndex((planStep) => !planStep.done);
        const doneCount = activePlan.steps.filter((planStep) => planStep.done).length;
        planCountElement.textContent = currentStepIndex === -1 ? "Done" : `${doneCount + 1}/${activePlan.steps.length}`;
        planTextElement.textContent = currentStepIndex === -1 ? activePlan.goal : activePlan.steps[currentStepIndex].text;
        planChipElement.title = activePlan.steps.map((planStep, index) => `${planStep.done ? "✓" : `${index + 1}.`} ${planStep.text}`).join("\n");
        agentElement.classList.add("visible");
      },
      showCursor() {
        agentElement.classList.add("visible");
      },
      hideCursor() {
        agentElement.classList.remove("visible");
        labelElement.hidden = true;
      },
      followPointer(x, y) {
        // Hold still while the user types, so the bubble doesn't run away from them.
        if (agentIsBusy || bubbleState === "input") return;
        agentPosition.x = x + TRAIL_OFFSET_X;
        agentPosition.y = y + TRAIL_OFFSET_Y;
        triangleAngle += (IDLE_TRIANGLE_ANGLE_DEGREES - triangleAngle) * 0.25;
        render();
      },
      setPointLabel(labelText) {
        labelElement.textContent = labelText ?? "";
        labelElement.hidden = !labelText;
      },
      /** Flies the triangle's tip to (x, y) along a curved arc, turning to face where it's going. */
      flyTo(targetX, targetY) {
        agentIsBusy = true;
        agentElement.classList.add("visible");
        const start = { ...agentPosition };
        const flightDistance = Math.hypot(targetX - start.x, targetY - start.y);
        const control = { x: (start.x + targetX) / 2, y: Math.min(start.y, targetY) - Math.min(180, flightDistance * 0.3) };
        const durationMs = Math.max(380, Math.min(950, 320 + flightDistance * 0.45));
        const startTime = performance.now();
        return new Promise((resolve) => {
          function flightFrame(now) {
            const progress = Math.min((now - startTime) / durationMs, 1);
            const eased = progress * progress * (3 - 2 * progress);
            const remaining = 1 - eased;
            const nextX = remaining * remaining * start.x + 2 * remaining * eased * control.x + eased * eased * targetX;
            const nextY = remaining * remaining * start.y + 2 * remaining * eased * control.y + eased * eased * targetY;
            if (Math.hypot(nextX - agentPosition.x, nextY - agentPosition.y) > 0.5) {
              triangleAngle = (Math.atan2(nextY - agentPosition.y, nextX - agentPosition.x) * 180) / Math.PI;
            }
            agentPosition.x = nextX;
            agentPosition.y = nextY;
            render();
            if (progress < 1) requestAnimationFrame(flightFrame);
            else resolve();
          }
          requestAnimationFrame(flightFrame);
        });
      },
      /** Lets the triangle go back to trailing the user's pointer. */
      release(pointerX, pointerY) {
        agentIsBusy = false;
        labelElement.hidden = true;
        if (pointerX !== undefined) this.followPointer(pointerX, pointerY);
      },
      pulseClick() {
        agentElement.classList.remove("clicking");
        void agentElement.offsetWidth; // restart the animation
        agentElement.classList.add("clicking");
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
    let progressSteps = []; // what the bubble has narrated for the current task, kept for resuming
    let lastActivityAt = Date.now();
    const recentPageErrors = [];
    const pageEventListeners = [];

    const agentInterface = createAgentInterface({
      color: options.color,
      onSubmit: (request) => runTask(request),
      onDismiss: () => close(),
      onEndGuide: () => endGuide(),
      onAnswerClick: () => open(),
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
        pointerPosition: lastPointerPosition,
      });
      currentElementsById = elementsById;
      return snapshotText;
    }

    // ---------- bubble and cursor ----------

    function cursorShouldBeVisible() {
      return options.showCursor === "always" || agentInterface.isBubbleVisible() || Boolean(activePlan) || Boolean(currentAbortController);
    }

    function updateCursorVisibility() {
      if (cursorShouldBeVisible() && lastPointerPosition) agentInterface.showCursor();
      else if (!cursorShouldBeVisible()) agentInterface.hideCursor();
    }

    function hasRecentConversation() {
      return conversationMessages.length > 0 && Date.now() - lastActivityAt < CONVERSATION_IDLE_RESET_MS;
    }

    /** Opens the speech bubble as a text box at the triangle, ready to type. */
    function open() {
      if (currentAbortController) return; // busy: the bubble is narrating
      if (!hasRecentConversation() && !activePlan) conversationMessages = [];
      const isFollowUp = conversationMessages.length > 0;
      agentInterface.showInput(isFollowUp ? "Reply, or ask something new" : options.placeholder, "return to send · esc to close");
    }

    /** Esc / hotkey: stops a running task, or closes the bubble. A running guide keeps going from the cursor. */
    function close() {
      if (currentAbortController) {
        stopTask();
        agentInterface.showAnswer("Stopped.", ANSWER_MIN_LINGER_MS);
        return;
      }
      agentInterface.hideBubble();
      if (!activePlan) persistence.clear();
      updateCursorVisibility();
    }

    function toggle() {
      if (agentInterface.isTyping() || currentAbortController) close();
      else open();
    }

    function endGuide() {
      activePlan = null;
      clearTimeout(guideCheckInTimeoutId);
      pendingGuideCheckIn = null;
      agentInterface.renderPlan(null);
      stopTask();
      conversationMessages = [];
      agentInterface.hideBubble();
      persistence.clear();
      updateCursorVisibility();
    }

    function narrate(statusText) {
      progressSteps.push(statusText);
      agentInterface.showStatus(statusText);
    }

    function answer(answerText) {
      const wordCount = answerText.split(/\s+/).length;
      agentInterface.showAnswer(answerText, Math.max(ANSWER_MIN_LINGER_MS, wordCount * ANSWER_LINGER_PER_WORD_MS));
    }

    // ---------- conversation bookkeeping ----------

    /** Ends a running task, leaving the conversation valid for a follow-up. */
    function stopTask() {
      if (!currentAbortController) return;
      currentAbortController.abort();
      currentAbortController = null;
      closeDanglingToolUses("Cancelled by the user.");
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
        steps: progressSteps,
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
      agentInterface.setPointLabel(null);
      await agentInterface.flyTo(elementRect.left + Math.min(elementRect.width / 2, 40), elementRect.top + elementRect.height / 2);
      if (label) agentInterface.setPointLabel(label);
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
    async function runToolBatch(toolUses, abortSignal, agentNarratedThisStep) {
      const toolResults = [];
      for (let toolIndex = 0; toolIndex < toolUses.length; toolIndex++) {
        const toolUse = toolUses[toolIndex];
        if (abortSignal.aborted) return toolResults;
        // The agent's own words read better than "Clicking …", so they stay up while its tools run.
        if (agentNarratedThisStep) progressSteps.push(describeToolUse(toolUse, currentElementsById));
        else narrate(describeToolUse(toolUse, currentElementsById));
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
            answer("Sorry, I can't help with that one.");
            return;
          }

          const replyText = agentStep.content
            .filter((contentBlock) => contentBlock.type === "text")
            .map((contentBlock) => contentBlock.text)
            .join("\n")
            .trim();
          const toolUses = agentStep.content.filter((contentBlock) => contentBlock.type === "tool_use");
          if (toolUses.length === 0) {
            answer(replyText || "Done.");
            return;
          }
          // Text the agent writes alongside tool calls is narration ("checking the dates first").
          if (replyText) narrate(replyText);

          const toolResults = await runToolBatch(toolUses, abortSignal, Boolean(replyText));
          if (abortSignal.aborted) return;
          conversationMessages.push({ role: "user", content: toolResults });
        }
        closeDanglingToolUses("Stopped: step limit reached.");
        agentInterface.showError(`I stopped after ${options.maxSteps} steps. Try a more specific request.`);
      } catch (error) {
        if (abortSignal.aborted) return;
        closeDanglingToolUses("The request failed.");
        agentInterface.showError(String(error?.message ?? error));
      } finally {
        if (currentAbortController === abortController) {
          currentAbortController = null;
          lastActivityAt = Date.now();
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
            agentInterface.release(lastPointerPosition?.x, lastPointerPosition?.y);
            updateCursorVisibility();
          }, CURSOR_HOLD_AFTER_TASK_MS);
        }
      }
    }

    function beginWorking() {
      stopTask();
      clearTimeout(cursorReleaseTimeoutId);
      const abortController = new AbortController();
      currentAbortController = abortController;
      lastActivityAt = Date.now();
      updateCursorVisibility();
      return abortController;
    }

    async function runTask(request, modeKey) {
      if (!hasRecentConversation() && !activePlan) conversationMessages = [];
      const abortController = beginWorking();
      currentStepCount = 0;
      progressSteps = [];
      narrate("Looking at the page");
      const snapshotText = refreshSnapshot();
      const modeLine = modeKey && MODE_LABELS[modeKey] ? `[Mode: ${MODE_LABELS[modeKey]}]\n` : "";
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
      currentStepCount = 0;
      progressSteps = [];
      narrate("Checking your progress");
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
      progressSteps = savedState.steps ?? [];
      lastActivityAt = Date.now();
      agentInterface.renderPlan(activePlan);
      updateCursorVisibility();
    }

    /** Picks up a tool batch that was interrupted when one of its actions loaded this page. */
    async function resumeToolBatch(savedState) {
      const abortController = beginWorking();
      narrate(progressSteps.at(-1) ?? "Picking up where I left off");
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
          const abortController = beginWorking();
          narrate("Picking up where I left off");
          await continueAgentLoop(abortController);
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
      // ctrl + option: pressing the second of the two keys opens or closes the bubble.
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
    // Esc stops a running task (or closes an answer) even when focus is on the page.
    listen(window, "keydown", (keyboardEvent) => {
      if (keyboardEvent.key === "Escape" && (currentAbortController || agentInterface.isBubbleVisible())) close();
    });

    resumeFromSavedState();

    return {
      open,
      close,
      toggle,
      /** Runs a request right away. Mode is optional ("do", "explain", "troubleshoot", "pitch", "guide"); the agent picks one otherwise. */
      ask(request, modeKey) {
        return runTask(request, modeKey);
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
    open: () => sharedAgentInstance?.open(),
    close: () => sharedAgentInstance?.close(),
    toggle: () => sharedAgentInstance?.toggle(),
    ask: (request, modeKey) => sharedAgentInstance?.ask(request, modeKey),
    registerAction: (siteAction) => sharedAgentInstance?.registerAction(siteAction),
    setSiteContext: (siteContext) => sharedAgentInstance?.setSiteContext(siteContext),
  };
})();

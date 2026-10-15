// The right-side Clicky panel: the roster of every Clicky, a hold-to-talk
// button, and the conversation with whichever Clicky is selected. The web
// home and the Chrome extension's side panel both mount this same panel.

const STATE_LABELS = {
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export function mountClickyPanel(rootElement, { clickys, conversation, shortcutHint, onClickySelected }) {
  rootElement.classList.add("clicky-panel");
  rootElement.innerHTML = `
    <div class="panel-section">
      <div class="panel-heading">Your Clickys</div>
      <div class="roster" role="listbox" aria-label="Clickys"></div>
    </div>
    <div class="panel-section talk-section">
      <div class="active-clicky">
        <span class="avatar active-avatar"></span>
        <div>
          <div class="active-name"></div>
          <div class="status-line"><span class="status-dot"></span><span class="status-text">Ready</span></div>
        </div>
        <button type="button" class="clear-button" title="Forget this conversation">Clear</button>
      </div>
      <button type="button" class="talk-button">
        <span class="talk-label">Hold to talk</span>
        <span class="level-meter"><span class="level-fill"></span></span>
      </button>
      <div class="shortcut-hint"></div>
      <div class="error-line" role="alert"></div>
    </div>
    <div class="panel-section log-section">
      <div class="conversation-log" aria-live="polite"></div>
    </div>`;

  const rosterElement = rootElement.querySelector(".roster");
  const activeAvatarElement = rootElement.querySelector(".active-avatar");
  const activeNameElement = rootElement.querySelector(".active-name");
  const statusTextElement = rootElement.querySelector(".status-text");
  const talkButtonElement = rootElement.querySelector(".talk-button");
  const talkLabelElement = rootElement.querySelector(".talk-label");
  const levelFillElement = rootElement.querySelector(".level-fill");
  const errorLineElement = rootElement.querySelector(".error-line");
  const conversationLogElement = rootElement.querySelector(".conversation-log");
  rootElement.querySelector(".shortcut-hint").textContent = shortcutHint ?? "";

  let liveUserBubbleElement = null;
  let liveReplyBubbleElement = null;

  for (const clicky of clickys) {
    const rosterItemElement = document.createElement("button");
    rosterItemElement.type = "button";
    rosterItemElement.className = "roster-item";
    rosterItemElement.dataset.clickyId = clicky.id;
    rosterItemElement.setAttribute("role", "option");
    rosterItemElement.style.setProperty("--clicky-color", clicky.color);
    rosterItemElement.innerHTML = `<span class="avatar"></span><span class="roster-text"><span class="roster-name"></span><span class="roster-tagline"></span></span>`;
    rosterItemElement.querySelector(".roster-name").textContent = clicky.name;
    rosterItemElement.querySelector(".roster-tagline").textContent = clicky.tagline;
    rosterItemElement.addEventListener("click", () => selectClicky(clicky.id));
    rosterElement.appendChild(rosterItemElement);
  }

  // Hold-to-talk with mouse, touch or pen. Pointer capture keeps the release
  // event even if the pointer slides off the button.
  talkButtonElement.addEventListener("pointerdown", (pointerEvent) => {
    talkButtonElement.setPointerCapture(pointerEvent.pointerId);
    conversation.startListening();
  });
  const releaseTalkButton = () => conversation.stopListeningAndRespond();
  talkButtonElement.addEventListener("pointerup", releaseTalkButton);
  talkButtonElement.addEventListener("pointercancel", releaseTalkButton);

  rootElement.querySelector(".clear-button").addEventListener("click", () => {
    const activeClicky = conversation.getActiveClicky();
    if (activeClicky) {
      conversation.clearHistory(activeClicky.id);
      renderConversationLog();
    }
  });

  function selectClicky(clickyId) {
    const clicky = clickys.find((candidateClicky) => candidateClicky.id === clickyId);
    if (!clicky) {
      return;
    }
    conversation.setClicky(clicky);
    rootElement.style.setProperty("--clicky-color", clicky.color);
    activeNameElement.textContent = clicky.name;
    activeAvatarElement.title = clicky.name;
    for (const rosterItemElement of rosterElement.children) {
      const isSelected = rosterItemElement.dataset.clickyId === clickyId;
      rosterItemElement.classList.toggle("selected", isSelected);
      rosterItemElement.setAttribute("aria-selected", String(isSelected));
    }
    errorLineElement.textContent = "";
    renderConversationLog();
    onClickySelected?.(clicky);
  }

  function appendBubble(role, text) {
    const bubbleElement = document.createElement("div");
    bubbleElement.className = `bubble ${role}`;
    bubbleElement.textContent = text;
    conversationLogElement.appendChild(bubbleElement);
    conversationLogElement.scrollTop = conversationLogElement.scrollHeight;
    return bubbleElement;
  }

  function renderConversationLog() {
    conversationLogElement.innerHTML = "";
    liveUserBubbleElement = null;
    liveReplyBubbleElement = null;
    const activeClicky = conversation.getActiveClicky();
    const clickyHistory = activeClicky ? conversation.getHistory(activeClicky.id) : [];
    if (clickyHistory.length === 0) {
      const emptyStateElement = document.createElement("div");
      emptyStateElement.className = "empty-log";
      emptyStateElement.textContent = `Ask ${activeClicky?.name ?? "a Clicky"} about anything on your screen.`;
      conversationLogElement.appendChild(emptyStateElement);
    }
    for (const historyTurn of clickyHistory) {
      appendBubble("user", historyTurn.userText);
      appendBubble("assistant", historyTurn.assistantText);
    }
  }

  function handleConversationEvent(conversationEvent) {
    switch (conversationEvent.type) {
      case "state": {
        const { state } = conversationEvent;
        rootElement.dataset.state = state;
        statusTextElement.textContent = STATE_LABELS[state];
        talkLabelElement.textContent = state === "listening" ? "Release to send" : "Hold to talk";
        if (state === "listening") {
          errorLineElement.textContent = "";
          conversationLogElement.querySelector(".empty-log")?.remove();
        }
        if (state === "idle") {
          levelFillElement.style.transform = "scaleX(0)";
          // The finished turn is now in history; rebuild so the log matches it.
          renderConversationLog();
        }
        break;
      }
      case "transcript":
        if (!conversationEvent.text) {
          break;
        }
        liveUserBubbleElement ??= appendBubble("user", "");
        liveUserBubbleElement.textContent = conversationEvent.text;
        break;
      case "reply":
        liveReplyBubbleElement ??= appendBubble("assistant", "");
        liveReplyBubbleElement.textContent = conversationEvent.text;
        conversationLogElement.scrollTop = conversationLogElement.scrollHeight;
        break;
      case "level":
        levelFillElement.style.transform = `scaleX(${Math.min(1, conversationEvent.level * 8)})`;
        break;
      case "error":
        errorLineElement.textContent = conversationEvent.message;
        break;
    }
  }

  selectClicky(clickys[0].id);
  return { handleConversationEvent, selectClicky };
}

// The Clicky side panel: the same roster and talk panel as the web home, but
// the screenshot is the active tab and the cursor is drawn on that page by
// content.js, reached through a port that lives as long as this panel.

import { CLICKYS } from "./shared/clickys.js";
import { createClickyApi } from "./shared/api.js";
import { createClickyConversation } from "./shared/conversation.js";
import { encodeScreenshotFromDataUrl } from "./shared/screenshot.js";
import { installPushToTalkKeys } from "./shared/keyboard.js";
import { mountClickyPanel } from "./shared/panel.js";

const CONTENT_SCRIPT_READY_TIMEOUT_MS = 1500;
const BUBBLE_LINGER_AFTER_REPLY_MS = 5000;

const settingsFormElement = document.getElementById("settings");
const settingsToggleElement = document.getElementById("settings-toggle");
const workerUrlInputElement = document.getElementById("worker-url-input");
const accessTokenInputElement = document.getElementById("access-token-input");
const pageStatusElement = document.getElementById("page-status");
const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;

const settings = { workerUrl: "", accessToken: "" };
const panelWindowId = (await chrome.windows.getCurrent()).id;

let activeTabId = null;
let cursorPort = null;
let cursorConnectionGeneration = 0;
let activeClickyColor = CLICKYS[0].color;
let hideBubbleTimeoutId = null;

// ---------- settings ----------

Object.assign(settings, await chrome.storage.local.get(["workerUrl", "accessToken"]));
document.getElementById("extension-origin").textContent = extensionOrigin;

function setSettingsVisible(settingsVisible) {
  settingsFormElement.hidden = !settingsVisible;
  settingsToggleElement.setAttribute("aria-expanded", String(settingsVisible));
  if (settingsVisible) {
    workerUrlInputElement.value = settings.workerUrl;
    accessTokenInputElement.value = settings.accessToken;
  }
}

settingsToggleElement.addEventListener("click", () => setSettingsVisible(settingsFormElement.hidden));
settingsFormElement.addEventListener("submit", async (submitEvent) => {
  submitEvent.preventDefault();
  settings.workerUrl = workerUrlInputElement.value.trim().replace(/\/+$/, "");
  settings.accessToken = accessTokenInputElement.value.trim();
  await chrome.storage.local.set(settings);
  setSettingsVisible(false);
});
document.getElementById("copy-origin").addEventListener("click", () => navigator.clipboard.writeText(extensionOrigin));

setSettingsVisible(!settings.workerUrl);

// ---------- cursor on the active tab ----------

function showPageStatus(message) {
  pageStatusElement.textContent = message ?? "";
  pageStatusElement.hidden = !message;
}

function sendToCursor(cursorMessage) {
  try {
    cursorPort?.postMessage(cursorMessage);
  } catch {
    cursorPort = null;
  }
}

/** Connects to content.js in a tab; resolves with the port once it reports ready, or null. */
function connectToContentScript(tabId) {
  return new Promise((resolve) => {
    const port = chrome.tabs.connect(tabId, { name: "clicky-cursor" });
    const readyTimeoutId = setTimeout(() => {
      port.disconnect();
      resolve(null);
    }, CONTENT_SCRIPT_READY_TIMEOUT_MS);
    port.onMessage.addListener(function handleReady(contentMessage) {
      if (contentMessage.type === "ready") {
        clearTimeout(readyTimeoutId);
        port.onMessage.removeListener(handleReady);
        resolve(port);
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // "Could not establish connection" when no content script
      clearTimeout(readyTimeoutId);
      resolve(null);
    });
  });
}

async function connectCursorToActiveTab() {
  // Tab switches and page loads can trigger overlapping connects; only the
  // newest one may keep its port.
  const thisConnectionGeneration = ++cursorConnectionGeneration;
  cursorPort?.disconnect();
  cursorPort = null;

  const [activeTab] = await chrome.tabs.query({ active: true, windowId: panelWindowId });
  if (!activeTab || thisConnectionGeneration !== cursorConnectionGeneration) {
    return;
  }
  activeTabId = activeTab.id;

  // Chrome doesn't let extensions run on its own pages or the Web Store.
  if (!/^(https?|file):/.test(activeTab.url ?? "")) {
    showPageStatus("Clicky can't see or point on this page. Switch to a regular website.");
    return;
  }

  let port = await connectToContentScript(activeTab.id);
  if (!port) {
    // Tabs opened before the extension was installed have no content script yet.
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ["content.js"] });
      port = await connectToContentScript(activeTab.id);
    } catch (error) {
      console.warn("Couldn't inject the cursor into this tab.", error);
    }
  }
  if (thisConnectionGeneration !== cursorConnectionGeneration) {
    port?.disconnect();
    return; // a newer connect (tab switch or reload) started while we waited
  }
  if (!port) {
    showPageStatus("Clicky can't point on this page. Try reloading it.");
    return;
  }

  showPageStatus(null);
  cursorPort = port;
  port.onMessage.addListener((contentMessage) => {
    if (contentMessage.type !== "push-to-talk") {
      return;
    }
    if (contentMessage.pressed) {
      conversation.startListening();
    } else {
      conversation.stopListeningAndRespond();
    }
  });
  port.onDisconnect.addListener(() => {
    if (cursorPort === port) {
      cursorPort = null;
    }
  });
  sendToCursor({ type: "color", color: activeClickyColor });
}

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (windowId === panelWindowId) {
    connectCursorToActiveTab();
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === "complete") {
    connectCursorToActiveTab();
  }
});

// ---------- conversation ----------

async function captureActiveTab() {
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(panelWindowId, { format: "jpeg", quality: 85 });
  return encodeScreenshotFromDataUrl(screenshotDataUrl);
}

function handleConversationEvent(conversationEvent) {
  panel.handleConversationEvent(conversationEvent);

  switch (conversationEvent.type) {
    case "state":
      clearTimeout(hideBubbleTimeoutId);
      if (conversationEvent.state === "listening") {
        sendToCursor({ type: "release" });
        sendToCursor({ type: "bubble", text: "listening…" });
      } else if (conversationEvent.state === "thinking") {
        sendToCursor({ type: "bubble", text: "thinking…" });
      } else if (conversationEvent.state === "idle") {
        hideBubbleTimeoutId = setTimeout(() => sendToCursor({ type: "bubble", text: null }), BUBBLE_LINGER_AFTER_REPLY_MS);
      }
      break;
    case "reply":
      if (conversationEvent.text) {
        sendToCursor({ type: "bubble", text: conversationEvent.text });
      }
      break;
    case "point":
      sendToCursor({ type: "point", fx: conversationEvent.fx, fy: conversationEvent.fy, label: conversationEvent.label });
      break;
    case "error":
      if (conversationEvent.code === "NotAllowedError") {
        // Side panels can't show Chrome's mic prompt; a normal tab can, and
        // the permission then applies to the whole extension.
        chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") });
      } else if (/\(403\)/.test(conversationEvent.message)) {
        setSettingsVisible(true);
        showPageStatus(`Your Worker rejected this extension. Add ${extensionOrigin} to ALLOWED_ORIGINS and redeploy.`);
      } else if (/\(401\)/.test(conversationEvent.message)) {
        setSettingsVisible(true);
        showPageStatus("Your Worker needs an access token. Paste it in Settings.");
      } else if (!settings.workerUrl) {
        setSettingsVisible(true);
      }
      break;
  }
}

const api = createClickyApi({
  workerBaseUrl: () => settings.workerUrl,
  accessToken: () => settings.accessToken,
  requireWorkerBaseUrl: true,
});

const conversation = createClickyConversation({
  api,
  captureScreenshot: captureActiveTab,
  onEvent: handleConversationEvent,
});

const panel = mountClickyPanel(document.getElementById("panel"), {
  clickys: CLICKYS,
  conversation,
  shortcutHint: "or hold ctrl + option on the page",
  onClickySelected(clicky) {
    activeClickyColor = clicky.color;
    document.documentElement.style.setProperty("--clicky-color", clicky.color);
    sendToCursor({ type: "color", color: clicky.color });
  },
});

installPushToTalkKeys({
  allowSpaceKey: true,
  onPress: () => conversation.startListening(),
  onRelease: () => conversation.stopListeningAndRespond(),
});

connectCursorToActiveTab();

// Cursor Agent's service worker. Content scripts can't call the Worker
// themselves (the page's CORS rules would apply), so agent steps go through
// here with the extension's own origin. It also keeps each tab's task or
// guide alive across page loads, and opens the card from the toolbar icon.

const CONTENT_SCRIPT_FILES = ["cursor-agent.js", "content.js"];

async function readSettings() {
  const { endpoint = "", accessToken = "" } = await chrome.storage.local.get(["endpoint", "accessToken"]);
  return { endpoint: endpoint.replace(/\/+$/, ""), accessToken };
}

async function requestAgentStep(requestBody) {
  const { endpoint, accessToken } = await readSettings();
  if (!endpoint) {
    return { ok: false, error: "Add your Cursor Agent address in the extension's options first (right-click the toolbar icon → Options)." };
  }
  const headers = { "content-type": "application/json" };
  if (accessToken) headers["x-cursor-agent-token"] = accessToken;
  try {
    const response = await fetch(`${endpoint}/api/agent`, { method: "POST", headers, body: JSON.stringify(requestBody) });
    const responseBody = await response.json().catch(() => ({}));
    if (response.status === 403) {
      return { ok: false, error: `Your Worker rejected this extension. Add chrome-extension://${chrome.runtime.id} to ALLOWED_ORIGINS and redeploy.` };
    }
    if (!response.ok) return { ok: false, error: responseBody.error || `Agent request failed (${response.status})` };
    return { ok: true, data: responseBody };
  } catch (error) {
    return { ok: false, error: `Couldn't reach ${endpoint}: ${error.message}` };
  }
}

const tabStateKey = (tabId) => `tab-state-${tabId}`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  switch (message.type) {
    case "agent-step":
      requestAgentStep(message.body).then(sendResponse);
      return true; // respond asynchronously
    case "state-load":
      chrome.storage.session.get(tabStateKey(tabId)).then((stored) => sendResponse(stored[tabStateKey(tabId)] ?? null));
      return true;
    case "state-save":
      chrome.storage.session.set({ [tabStateKey(tabId)]: message.state }).then(() => sendResponse(true));
      return true;
    case "state-clear":
      chrome.storage.session.remove(tabStateKey(tabId)).then(() => sendResponse(true));
      return true;
    case "open-options":
      chrome.runtime.openOptionsPage();
      return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabStateKey(tabId)));

/** Toggles the card in a tab, injecting the scripts first into tabs opened before install. */
async function toggleAgentInTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "toggle" });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
      await chrome.tabs.sendMessage(tabId, { type: "toggle" });
    } catch (error) {
      console.warn("Cursor Agent can't run on this page (Chrome blocks extensions on its own pages).", error);
    }
  }
}

chrome.action.onClicked.addListener((tab) => toggleAgentInTab(tab.id));
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-agent" && tab?.id) toggleAgentInTab(tab.id);
});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

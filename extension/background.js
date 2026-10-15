// Clicking the toolbar icon (or Alt+Shift+K) opens the Clicky side panel.
// Everything else happens in the side panel and the content script.

function openSidePanelOnActionClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));
}

chrome.runtime.onInstalled.addListener(openSidePanelOnActionClick);
chrome.runtime.onStartup.addListener(openSidePanelOnActionClick);

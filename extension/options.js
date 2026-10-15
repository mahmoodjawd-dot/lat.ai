// Saves the Worker address, optional access token and cursor preference.

const endpointInputElement = document.getElementById("endpoint");
const accessTokenInputElement = document.getElementById("access-token");
const showCursorAlwaysElement = document.getElementById("show-cursor-always");
const savedMessageElement = document.getElementById("saved");
const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;

/** Keep only the origin, so a pasted page link like …workers.dev/index.html still works. */
function toOrigin(address) {
  try {
    return new URL(address.trim()).origin;
  } catch {
    return address.trim();
  }
}

document.getElementById("extension-origin").textContent = extensionOrigin;
document.getElementById("copy-origin").addEventListener("click", () => navigator.clipboard.writeText(extensionOrigin));

chrome.storage.local.get(["endpoint", "accessToken", "showCursorAlways"]).then((savedSettings) => {
  endpointInputElement.value = savedSettings.endpoint ?? "";
  accessTokenInputElement.value = savedSettings.accessToken ?? "";
  showCursorAlwaysElement.checked = savedSettings.showCursorAlways ?? true;
});

document.getElementById("options-form").addEventListener("submit", async (submitEvent) => {
  submitEvent.preventDefault();
  await chrome.storage.local.set({
    endpoint: toOrigin(endpointInputElement.value),
    accessToken: accessTokenInputElement.value.trim(),
    showCursorAlways: showCursorAlwaysElement.checked,
  });
  endpointInputElement.value = toOrigin(endpointInputElement.value);
  savedMessageElement.textContent = "Saved. Reload open tabs to apply the cursor setting.";
});

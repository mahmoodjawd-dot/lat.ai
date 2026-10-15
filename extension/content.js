// Starts the Cursor Agent SDK (cursor-agent.js, injected just before this)
// on every page, routing agent requests and saved state through the
// extension's service worker.

(async () => {
  if (window.__cursorAgentExtensionStarted) return;
  window.__cursorAgentExtensionStarted = true;

  // A site that embeds the SDK itself already has its own cursor.
  if (document.querySelector("cursor-agent")) return;

  const { showCursorAlways = true } = await chrome.storage.local.get("showCursorAlways");

  CursorAgent.init({
    showCursor: showCursorAlways ? "always" : "active",
    transport: {
      requestAgentStep(requestBody, abortSignal) {
        return new Promise((resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          chrome.runtime
            .sendMessage({ type: "agent-step", body: requestBody })
            .then((stepResponse) => (stepResponse?.ok ? resolve(stepResponse.data) : reject(new Error(stepResponse?.error ?? "No answer from the extension"))))
            .catch(reject);
        });
      },
    },
    persistence: {
      load: () => chrome.runtime.sendMessage({ type: "state-load" }),
      save: (savedState) => chrome.runtime.sendMessage({ type: "state-save", state: savedState }),
      clear: () => chrome.runtime.sendMessage({ type: "state-clear" }),
    },
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "toggle") CursorAgent.toggle();
  });
})();

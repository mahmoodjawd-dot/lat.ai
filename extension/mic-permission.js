// Asks for the microphone from a normal extension tab. The grant belongs to
// the extension's origin, so the side panel can use the mic afterwards.

const resultElement = document.getElementById("result");

async function requestMicrophone() {
  try {
    const microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    microphoneStream.getTracks().forEach((track) => track.stop());
    resultElement.textContent = "All set. You can close this tab and talk to your Clickys.";
    setTimeout(async () => {
      const permissionTab = await chrome.tabs.getCurrent();
      if (permissionTab) {
        chrome.tabs.remove(permissionTab.id);
      }
    }, 1500);
  } catch (error) {
    resultElement.textContent =
      error?.name === "NotAllowedError"
        ? "Microphone is blocked. Click the icon at the right of the address bar, allow the microphone, then try again."
        : `Couldn't access the microphone: ${error?.message ?? error}`;
  }
}

document.getElementById("allow-button").addEventListener("click", requestMicrophone);
requestMicrophone();

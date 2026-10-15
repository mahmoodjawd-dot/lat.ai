// Web home: the dock of every Clicky, a shared-screen preview the secondary
// cursor points on, and the right-side panel to talk to the selected Clicky.

import { CLICKYS } from "./shared/clickys.js";
import { createClickyApi } from "./shared/api.js";
import { createClickyConversation } from "./shared/conversation.js";
import { createClickyCursor } from "./shared/cursor.js";
import { encodeScreenshot } from "./shared/screenshot.js";
import { installPushToTalkKeys } from "./shared/keyboard.js";
import { mountClickyPanel } from "./shared/panel.js";

const ACCESS_TOKEN_STORAGE_KEY = "clicky-access-token";
const BUBBLE_LINGER_AFTER_SPOKEN_REPLY_MS = 5000;
const BUBBLE_LINGER_AFTER_TEXT_REPLY_MS = 12000;

const dockGridElement = document.getElementById("dock-grid");
const shareButtonElement = document.getElementById("share-button");
const screenFrameElement = document.getElementById("screen-frame");
const screenPreviewElement = document.getElementById("screen-preview");
const screenPlaceholderElement = document.getElementById("screen-placeholder");
const settingsDialogElement = document.getElementById("settings-dialog");
const accessTokenInputElement = document.getElementById("access-token-input");

let sharedScreenStream = null;
let hideBubbleTimeoutId = null;
// Both stay off until the Worker reports it has the AssemblyAI / ElevenLabs keys.
let voiceInputAvailable = false;
let voiceOutputAvailable = false;

// localStorage can throw (private windows, blocked storage); the token is a
// convenience, so fall back to "none".
function readStoredAccessToken() {
  try {
    return localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeAccessToken(accessToken) {
  try {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, accessToken);
  } catch {
    // ignore
  }
}

const api = createClickyApi({ workerBaseUrl: "", accessToken: readStoredAccessToken });
const cursor = createClickyCursor({ positioning: "absolute", container: screenFrameElement });

/** The rectangle the video actually occupies inside the frame (object-fit: contain). */
function getVideoContentRect() {
  const frameWidth = screenPreviewElement.clientWidth;
  const frameHeight = screenPreviewElement.clientHeight;
  const videoWidth = screenPreviewElement.videoWidth || frameWidth;
  const videoHeight = screenPreviewElement.videoHeight || frameHeight;
  const displayScale = Math.min(frameWidth / videoWidth, frameHeight / videoHeight);
  const contentWidth = videoWidth * displayScale;
  const contentHeight = videoHeight * displayScale;
  return {
    left: (frameWidth - contentWidth) / 2,
    top: (frameHeight - contentHeight) / 2,
    width: contentWidth,
    height: contentHeight,
  };
}

function captureSharedScreen() {
  if (!sharedScreenStream || !screenPreviewElement.videoWidth) {
    return null;
  }
  return encodeScreenshot(screenPreviewElement, screenPreviewElement.videoWidth, screenPreviewElement.videoHeight);
}

function handleConversationEvent(conversationEvent) {
  panel.handleConversationEvent(conversationEvent);

  switch (conversationEvent.type) {
    case "state":
      clearTimeout(hideBubbleTimeoutId);
      if (conversationEvent.state === "listening") {
        cursor.releasePoint();
        cursor.setBubbleText("listening…");
      } else if (conversationEvent.state === "thinking") {
        cursor.setBubbleText("thinking…");
      } else if (conversationEvent.state === "idle") {
        // Text-only replies need longer on screen since nobody reads them aloud.
        const bubbleLingerMs = voiceOutputAvailable ? BUBBLE_LINGER_AFTER_SPOKEN_REPLY_MS : BUBBLE_LINGER_AFTER_TEXT_REPLY_MS;
        hideBubbleTimeoutId = setTimeout(() => cursor.setBubbleText(null), bubbleLingerMs);
      }
      break;
    case "reply":
      if (conversationEvent.text) {
        cursor.setBubbleText(conversationEvent.text);
      }
      break;
    case "point": {
      const videoContentRect = getVideoContentRect();
      cursor.pointAt(
        videoContentRect.left + conversationEvent.fx * videoContentRect.width,
        videoContentRect.top + conversationEvent.fy * videoContentRect.height,
        conversationEvent.label,
      );
      break;
    }
    case "error":
      if (/\(401\)/.test(conversationEvent.message)) {
        openSettings();
      }
      break;
  }
}

const conversation = createClickyConversation({
  api,
  captureScreenshot: captureSharedScreen,
  onEvent: handleConversationEvent,
});

const panel = mountClickyPanel(document.getElementById("panel"), {
  clickys: CLICKYS,
  conversation,
  shortcutHint: "or hold Space, or ctrl + option",
  onClickySelected(clicky) {
    cursor.setColor(clicky.color);
    document.documentElement.style.setProperty("--clicky-color", clicky.color);
    for (const dockCardElement of dockGridElement.children) {
      dockCardElement.classList.toggle("selected", dockCardElement.dataset.clickyId === clicky.id);
    }
  },
});

// Dock cards are built after the panel so the first selection can't miss them;
// re-apply the current selection once they exist.
for (const clicky of CLICKYS) {
  const dockCardElement = document.createElement("button");
  dockCardElement.type = "button";
  dockCardElement.className = "dock-card";
  dockCardElement.dataset.clickyId = clicky.id;
  dockCardElement.style.setProperty("--clicky-color", clicky.color);
  dockCardElement.innerHTML = `<span class="avatar dock-avatar"></span><span class="dock-name"></span><span class="dock-tagline"></span><span class="dock-cta"></span>`;
  dockCardElement.querySelector(".dock-name").textContent = clicky.name;
  dockCardElement.querySelector(".dock-tagline").textContent = clicky.tagline;
  dockCardElement.querySelector(".dock-cta").textContent = `Talk to ${clicky.name}`;
  dockCardElement.addEventListener("click", () => panel.selectClicky(clicky.id));
  dockGridElement.appendChild(dockCardElement);
}
panel.selectClicky(conversation.getActiveClicky().id);

installPushToTalkKeys({
  allowSpaceKey: true,
  onPress: () => {
    if (voiceInputAvailable) {
      conversation.startListening();
    }
  },
  onRelease: () => conversation.stopListeningAndRespond(),
});

async function applyVoiceConfig() {
  let voiceConfig = { voiceInput: false, voiceOutput: false };
  try {
    voiceConfig = await api.fetchVoiceConfig();
  } catch (error) {
    console.warn("Couldn't read the Worker's voice settings; using typed questions only.", error);
  }
  voiceInputAvailable = voiceConfig.voiceInput;
  voiceOutputAvailable = voiceConfig.voiceOutput;
  panel.setVoiceInputAvailable(voiceInputAvailable);
  conversation.setSpeakRepliesAloud(voiceOutputAvailable);
}
panel.setVoiceInputAvailable(false);
applyVoiceConfig();

screenFrameElement.addEventListener("pointermove", (pointerEvent) => {
  const frameRect = screenFrameElement.getBoundingClientRect();
  cursor.followPointer(pointerEvent.clientX - frameRect.left, pointerEvent.clientY - frameRect.top);
});

async function startSharingScreen() {
  try {
    sharedScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
  } catch (error) {
    if (error?.name !== "NotAllowedError") {
      console.error(error);
    }
    return;
  }
  screenPreviewElement.srcObject = sharedScreenStream;
  screenFrameElement.classList.add("sharing");
  screenPlaceholderElement.hidden = true;
  shareButtonElement.textContent = "Stop sharing";
  cursor.show();
  // Chrome's own "Stop sharing" bar ends the track without calling us.
  sharedScreenStream.getVideoTracks()[0].addEventListener("ended", stopSharingScreen);
}

function stopSharingScreen() {
  sharedScreenStream?.getTracks().forEach((track) => track.stop());
  sharedScreenStream = null;
  screenPreviewElement.srcObject = null;
  screenFrameElement.classList.remove("sharing");
  screenPlaceholderElement.hidden = false;
  shareButtonElement.textContent = "Share screen";
  cursor.hide();
}

shareButtonElement.addEventListener("click", () => (sharedScreenStream ? stopSharingScreen() : startSharingScreen()));

if (!navigator.mediaDevices?.getDisplayMedia) {
  shareButtonElement.disabled = true;
  shareButtonElement.textContent = "Screen sharing unsupported";
}

function openSettings() {
  accessTokenInputElement.value = readStoredAccessToken();
  if (!settingsDialogElement.open) {
    settingsDialogElement.showModal();
  }
}

document.getElementById("settings-button").addEventListener("click", openSettings);
settingsDialogElement.addEventListener("close", () => {
  if (settingsDialogElement.returnValue === "save") {
    storeAccessToken(accessTokenInputElement.value.trim());
    applyVoiceConfig();
  }
});

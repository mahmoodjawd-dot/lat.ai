// The push-to-talk → screenshot → Claude → speech → pointing pipeline, shared
// by the web home and the extension side panel. Callers supply how to take a
// screenshot and react to events; this module owns state and per-Clicky memory.
//
// Events passed to onEvent:
//   { type: "state", state: "idle" | "listening" | "thinking" | "speaking" }
//   { type: "transcript", text }          live words while listening
//   { type: "reply", text, isFinal }      Claude's reply as it streams (tag hidden)
//   { type: "point", fx, fy, label }      where to point, as 0–1 fractions of the screenshot
//   { type: "level", level }              mic loudness for the waveform
//   { type: "error", message, code? }    code is the DOMException name for mic errors

import { createPushToTalkTranscriber } from "./voice.js";
import { parsePointTag, hidePartialPointTag } from "./pointing.js";

const REFUSAL_SPOKEN_TEXT = "sorry, that's one i can't help with.";

export function createClickyConversation({ api, captureScreenshot, onEvent }) {
  const historyByClickyId = new Map();
  let activeClicky = null;
  let currentState = "idle";
  let currentAbortController = null;
  let currentAudioElement = null;
  // Off until the Worker has an ElevenLabs key; replies are then text only.
  let speakRepliesAloud = true;

  const transcriber = createPushToTalkTranscriber({
    fetchTranscribeToken: () => api.fetchTranscribeToken(),
    onPartialTranscript: (text) => onEvent({ type: "transcript", text }),
    onAudioLevel: (level) => onEvent({ type: "level", level }),
  });

  function setState(nextState) {
    currentState = nextState;
    onEvent({ type: "state", state: nextState });
  }

  function stopSpeakingAndRequests() {
    currentAbortController?.abort();
    currentAbortController = null;
    if (currentAudioElement) {
      currentAudioElement.pause();
      URL.revokeObjectURL(currentAudioElement.src);
      currentAudioElement = null;
    }
  }

  async function startListening() {
    if (!activeClicky || currentState === "listening") {
      return;
    }
    // Talking over Clicky interrupts whatever it was doing.
    stopSpeakingAndRequests();
    setState("listening");
    onEvent({ type: "transcript", text: "" });
    try {
      await transcriber.start();
    } catch (error) {
      transcriber.cancel();
      setState("idle");
      onEvent({ type: "error", message: describeMicrophoneError(error), code: error?.name ?? null });
    }
  }

  function captureScreenshotSafely() {
    return Promise.resolve()
      .then(() => captureScreenshot())
      .catch((error) => {
        console.warn("Screenshot failed; asking without one.", error);
        return null;
      });
  }

  async function stopListeningAndRespond() {
    if (currentState !== "listening") {
      return;
    }
    const respondingClicky = activeClicky;
    setState("thinking");

    // Take the screenshot at release, while the user is still looking at
    // what they asked about, in parallel with finalizing the transcript.
    const screenshotPromise = captureScreenshotSafely();
    const transcript = await transcriber.stop().catch(() => "");
    const screenshot = await screenshotPromise;

    if (!transcript) {
      setState("idle");
      onEvent({ type: "error", message: "Didn't catch that. Hold the key, talk, then let go." });
      return;
    }
    onEvent({ type: "transcript", text: transcript });
    await respondTo(respondingClicky, transcript, screenshot);
  }

  /** Same pipeline as push-to-talk, for a question typed into the panel. */
  async function askTypedQuestion(typedQuestion) {
    const question = typedQuestion.trim();
    if (!activeClicky || !question) {
      return;
    }
    transcriber.cancel();
    stopSpeakingAndRequests();
    const respondingClicky = activeClicky;
    setState("thinking");
    onEvent({ type: "transcript", text: question });
    const screenshot = await captureScreenshotSafely();
    await respondTo(respondingClicky, question, screenshot);
  }

  async function respondTo(respondingClicky, transcript, screenshot) {
    const abortController = new AbortController();
    currentAbortController = abortController;
    const clickyHistory = historyByClickyId.get(respondingClicky.id) ?? [];

    try {
      const { replyText, stopReason } = await api.streamChat({
        clickyId: respondingClicky.id,
        transcript,
        history: clickyHistory,
        screenshot,
        signal: abortController.signal,
        onTextDelta: (partialReplyText) =>
          onEvent({ type: "reply", text: hidePartialPointTag(partialReplyText), isFinal: false }),
      });

      const { spokenText, point } =
        stopReason === "refusal" ? { spokenText: REFUSAL_SPOKEN_TEXT, point: null } : parsePointTag(replyText);
      onEvent({ type: "reply", text: spokenText, isFinal: true });

      clickyHistory.push({ userText: transcript, assistantText: spokenText });
      historyByClickyId.set(respondingClicky.id, clickyHistory);

      if (point && screenshot) {
        onEvent({ type: "point", fx: point.x / screenshot.width, fy: point.y / screenshot.height, label: point.label });
      }

      if (spokenText && speakRepliesAloud) {
        setState("speaking");
        const speechAudioBlob = await api.fetchSpeechAudio({
          clickyId: respondingClicky.id,
          text: spokenText,
          signal: abortController.signal,
        });
        await playAudio(speechAudioBlob, abortController.signal);
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return; // interrupted by a new question or a Clicky switch
      }
      console.error(error);
      onEvent({ type: "error", message: String(error.message ?? error) });
    } finally {
      if (currentAbortController === abortController) {
        currentAbortController = null;
        setState("idle");
      }
    }
  }

  function playAudio(audioBlob, abortSignal) {
    return new Promise((resolve, reject) => {
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      const audioElement = new Audio(URL.createObjectURL(audioBlob));
      currentAudioElement = audioElement;
      const finishPlayback = () => {
        if (currentAudioElement === audioElement) {
          URL.revokeObjectURL(audioElement.src);
          currentAudioElement = null;
        }
        resolve();
      };
      audioElement.addEventListener("ended", finishPlayback);
      audioElement.addEventListener("pause", finishPlayback);
      audioElement.play().catch(reject);
    });
  }

  return {
    setClicky(clicky) {
      if (activeClicky?.id === clicky.id) {
        return;
      }
      cancel();
      activeClicky = clicky;
    },
    getActiveClicky: () => activeClicky,
    getHistory: (clickyId) => historyByClickyId.get(clickyId) ?? [],
    clearHistory(clickyId) {
      historyByClickyId.delete(clickyId);
    },
    getState: () => currentState,
    setSpeakRepliesAloud(shouldSpeak) {
      speakRepliesAloud = shouldSpeak;
    },
    startListening,
    stopListeningAndRespond,
    askTypedQuestion,
    cancel,
  };

  function cancel() {
    transcriber.cancel();
    stopSpeakingAndRequests();
    if (currentState !== "idle") {
      setState("idle");
    }
  }
}

function describeMicrophoneError(error) {
  if (error?.name === "NotAllowedError") {
    return "Microphone access is blocked. Allow it for this page and try again.";
  }
  if (error?.name === "NotFoundError") {
    return "No microphone found.";
  }
  return error?.message ?? String(error);
}

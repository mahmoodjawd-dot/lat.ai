// Push-to-talk transcription over AssemblyAI's v3 streaming websocket,
// mirroring AssemblyAIStreamingTranscriptionProvider.swift: fetch a
// short-lived token from the Worker, stream PCM16 audio while the key is
// held, then force an endpoint on release and wait for the formatted turn.

const ASSEMBLYAI_WEBSOCKET_URL = "wss://streaming.assemblyai.com/v3/ws";
const FINAL_TRANSCRIPT_TIMEOUT_MS = 2500;
const WEBSOCKET_OPEN_TIMEOUT_MS = 4000;

export function createPushToTalkTranscriber({ fetchTranscribeToken, onPartialTranscript, onAudioLevel }) {
  let activeSession = null;

  async function start() {
    if (activeSession) {
      return;
    }
    const session = {
      microphoneStream: null,
      audioContext: null,
      websocket: null,
      websocketOpenPromise: null,
      audioChunksWaitingForSocket: [],
      transcriptByTurnOrder: new Map(),
      lastTurnWasFinal: false,
      onFinalTurn: null,
      stopped: false,
      cancelled: false,
      startPromise: null,
    };
    activeSession = session;
    session.startPromise = connectSession(session);
    await session.startPromise;
  }

  async function connectSession(session) {
    // Start the token request and the mic together so the first words
    // aren't lost while the websocket connects; audio is buffered until open.
    const tokenPromise = fetchTranscribeToken();
    tokenPromise.catch(() => {}); // awaited below; avoids an unhandled rejection if we bail early

    session.microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (session.stopped) {
      // Released before the mic even opened: nothing was recorded.
      releaseMicrophone(session);
      return;
    }
    session.audioContext = new AudioContext();
    await session.audioContext.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
    const microphoneSource = session.audioContext.createMediaStreamSource(session.microphoneStream);
    const downsamplerNode = new AudioWorkletNode(session.audioContext, "pcm-downsampler");
    downsamplerNode.port.onmessage = ({ data }) => {
      if (data.type === "level") {
        onAudioLevel?.(data.level);
        return;
      }
      if (session.websocket?.readyState === WebSocket.OPEN) {
        session.websocket.send(data.buffer);
      } else {
        session.audioChunksWaitingForSocket.push(data.buffer);
      }
    };
    microphoneSource.connect(downsamplerNode);

    const temporaryToken = await tokenPromise;
    if (session.cancelled) {
      return;
    }

    const websocketQuery = new URLSearchParams({
      sample_rate: "16000",
      encoding: "pcm_s16le",
      format_turns: "true",
      speech_model: "u3-rt-pro",
      token: temporaryToken,
    });
    session.websocket = new WebSocket(`${ASSEMBLYAI_WEBSOCKET_URL}?${websocketQuery}`);
    session.websocket.binaryType = "arraybuffer";

    session.websocketOpenPromise = new Promise((resolve, reject) => {
      session.websocket.addEventListener("open", () => {
        session.audioChunksWaitingForSocket.forEach((audioChunk) => session.websocket.send(audioChunk));
        session.audioChunksWaitingForSocket = [];
        resolve();
      });
      session.websocket.addEventListener("error", () => reject(new Error("AssemblyAI websocket failed to connect")));
    });
    session.websocketOpenPromise.catch(() => {});

    session.websocket.addEventListener("message", ({ data }) => {
      const streamingMessage = JSON.parse(data);
      if (streamingMessage.type !== "Turn") {
        return;
      }
      session.transcriptByTurnOrder.set(streamingMessage.turn_order, streamingMessage.transcript ?? "");
      onPartialTranscript?.(joinTurns(session.transcriptByTurnOrder));
      session.lastTurnWasFinal = Boolean(streamingMessage.end_of_turn && streamingMessage.turn_is_formatted);
      if (session.lastTurnWasFinal) {
        session.onFinalTurn?.();
      }
    });
  }

  /** Stops listening and resolves with the final transcript ("" if nothing was said). */
  async function stop() {
    const session = activeSession;
    if (!session) {
      return "";
    }
    activeSession = null;
    session.stopped = true;
    releaseMicrophone(session);

    try {
      // A very short press can end before the mic or the socket is ready;
      // let setup finish so the audio already captured still gets sent.
      await session.startPromise.catch(() => {});
      releaseMicrophone(session);
      if (!session.websocketOpenPromise) {
        return "";
      }
      await withTimeout(session.websocketOpenPromise, WEBSOCKET_OPEN_TIMEOUT_MS);

      // Ask AssemblyAI to close the current turn now instead of waiting for
      // silence, then wait for its formatted version.
      const finalTurnPromise = new Promise((resolve) => {
        session.onFinalTurn = resolve;
      });
      session.lastTurnWasFinal = false;
      session.websocket.send(JSON.stringify({ type: "ForceEndpoint" }));
      await withTimeout(finalTurnPromise, FINAL_TRANSCRIPT_TIMEOUT_MS).catch(() => {});

      return joinTurns(session.transcriptByTurnOrder);
    } finally {
      closeWebsocket(session);
    }
  }

  function cancel() {
    const session = activeSession;
    if (!session) {
      return;
    }
    activeSession = null;
    session.stopped = true;
    session.cancelled = true;
    releaseMicrophone(session);
    closeWebsocket(session);
  }

  return { start, stop, cancel, isListening: () => activeSession !== null };
}

function joinTurns(transcriptByTurnOrder) {
  return [...transcriptByTurnOrder.entries()]
    .sort(([firstTurnOrder], [secondTurnOrder]) => firstTurnOrder - secondTurnOrder)
    .map(([, turnTranscript]) => turnTranscript.trim())
    .filter(Boolean)
    .join(" ");
}

function releaseMicrophone(session) {
  session.microphoneStream?.getTracks().forEach((track) => track.stop());
  if (session.audioContext && session.audioContext.state !== "closed") {
    session.audioContext.close().catch(() => {});
  }
}

function closeWebsocket(session) {
  const websocket = session.websocket;
  if (!websocket) {
    return;
  }
  if (websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: "Terminate" }));
  }
  setTimeout(() => websocket.close(), 500);
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs)),
  ]);
}

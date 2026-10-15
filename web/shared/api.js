// Talks to the Clicky Worker. The web home uses a relative base URL (same
// origin); the extension passes the full Worker URL from its settings.
// workerBaseUrl and accessToken may be strings or functions returning the
// current value, so settings changes apply without rebuilding the client.

export function createClickyApi({ workerBaseUrl = "", accessToken = "", requireWorkerBaseUrl = false } = {}) {
  const resolveBaseUrl = () =>
    (typeof workerBaseUrl === "function" ? workerBaseUrl() : workerBaseUrl).replace(/\/+$/, "");
  const resolveAccessToken = () => (typeof accessToken === "function" ? accessToken() : accessToken);

  function buildHeaders() {
    const headers = { "content-type": "application/json" };
    const currentAccessToken = resolveAccessToken();
    if (currentAccessToken) {
      headers["x-clicky-token"] = currentAccessToken;
    }
    return headers;
  }

  async function postJson(path, body, signal) {
    const baseUrl = resolveBaseUrl();
    if (requireWorkerBaseUrl && !baseUrl) {
      throw new Error("Add your Clicky site address in Settings first.");
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(body ?? {}),
      signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`${path} failed (${response.status}): ${errorText.slice(0, 300)}`);
    }
    return response;
  }

  /**
   * Streams Claude's reply. `onTextDelta` receives the accumulated text so far.
   * Resolves with the full text and the final stop reason.
   */
  async function streamChat({ clickyId, transcript, history, screenshot, onTextDelta, signal }) {
    const response = await postJson("/api/chat", { clickyId, transcript, history, screenshot }, signal);

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let unparsedBuffer = "";
    let accumulatedReplyText = "";
    let stopReason = null;

    // The Worker sends one Messages API stream event per line as JSON.
    function handleStreamEventLine(streamEventLine) {
      if (!streamEventLine.trim()) {
        return;
      }
      const streamEvent = JSON.parse(streamEventLine);
      if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
        accumulatedReplyText += streamEvent.delta.text;
        onTextDelta?.(accumulatedReplyText);
      } else if (streamEvent.type === "message_delta" && streamEvent.delta?.stop_reason) {
        stopReason = streamEvent.delta.stop_reason;
      } else if (streamEvent.type === "error") {
        throw new Error(streamEvent.error?.message ?? "Claude stream error");
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      unparsedBuffer += value;
      const completeLines = unparsedBuffer.split("\n");
      unparsedBuffer = completeLines.pop();
      completeLines.forEach(handleStreamEventLine);
    }
    handleStreamEventLine(unparsedBuffer);

    return { replyText: accumulatedReplyText, stopReason };
  }

  /** Fetches spoken audio for `text` in the given Clicky's voice. */
  async function fetchSpeechAudio({ clickyId, text, signal }) {
    const response = await postJson("/api/tts", { clickyId, text }, signal);
    return response.blob();
  }

  async function fetchTranscribeToken() {
    const response = await postJson("/api/transcribe-token");
    const { token } = await response.json();
    if (!token) {
      throw new Error("Worker returned no AssemblyAI token");
    }
    return token;
  }

  return { streamChat, fetchSpeechAudio, fetchTranscribeToken };
}

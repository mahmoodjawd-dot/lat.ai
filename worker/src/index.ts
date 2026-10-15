/**
 * Clicky Web proxy Worker
 *
 * Serves the web home from ../web (static assets) and proxies the three APIs
 * Clicky needs, so no API key ever reaches the browser or the extension.
 *
 * Routes:
 *   POST /api/config            → which voice features are switched on
 *   POST /api/chat              → Claude (streamed back as newline-delimited JSON events)
 *   POST /api/tts               → ElevenLabs text-to-speech (audio/mpeg)
 *   POST /api/transcribe-token  → short-lived AssemblyAI streaming token
 *
 * Access control: browsers may only call these routes from this Worker's own
 * origin or an origin listed in ALLOWED_ORIGINS (e.g. your extension's
 * chrome-extension://<id>). If the ACCESS_TOKEN secret is set, every request
 * must also send it in the x-clicky-token header.
 *
 * Only ANTHROPIC_API_KEY is required. Without ASSEMBLYAI_API_KEY the apps
 * take typed questions only; without ELEVENLABS_API_KEY replies are text only.
 */

import Anthropic from "@anthropic-ai/sdk";
import { findClickyById } from "../../web/shared/clickys.js";
import { buildSystemPrompt } from "./prompt";

interface Env {
  ANTHROPIC_API_KEY: string;
  ASSEMBLYAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID: string;
  CLAUDE_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  ACCESS_TOKEN?: string;
}

interface ChatHistoryTurn {
  userText: string;
  assistantText: string;
}

interface ChatScreenshot {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}

interface ChatRequestBody {
  clickyId: string;
  transcript: string;
  history?: ChatHistoryTurn[];
  screenshot?: ChatScreenshot | null;
}

const MAX_TRANSCRIPT_CHARACTERS = 4000;
const MAX_HISTORY_TURNS = 10;
const MAX_SCREENSHOT_BASE64_CHARACTERS = 6_000_000;
const MAX_TTS_CHARACTERS = 2500;
const ALLOWED_SCREENSHOT_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Anything outside /api/ that didn't match a static file is a 404.
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    const requestOrigin = request.headers.get("origin");
    const originIsAllowed = isOriginAllowed(requestOrigin, url.origin, env);
    const corsHeaders = buildCorsHeaders(originIsAllowed ? requestOrigin : null);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: originIsAllowed ? 204 : 403, headers: corsHeaders });
    }

    if (!originIsAllowed) {
      return jsonResponse({ error: "Origin not allowed" }, 403, corsHeaders);
    }

    if (env.ACCESS_TOKEN && request.headers.get("x-clicky-token") !== env.ACCESS_TOKEN) {
      return jsonResponse({ error: "Missing or wrong access token" }, 401, corsHeaders);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    try {
      if (url.pathname === "/api/config") {
        return jsonResponse(
          { voiceInput: Boolean(env.ASSEMBLYAI_API_KEY), voiceOutput: Boolean(env.ELEVENLABS_API_KEY) },
          200,
          corsHeaders,
        );
      }
      if (url.pathname === "/api/chat") {
        return await handleChat(request, env, corsHeaders);
      }
      if (url.pathname === "/api/tts") {
        return await handleTTS(request, env, corsHeaders);
      }
      if (url.pathname === "/api/transcribe-token") {
        return await handleTranscribeToken(env, corsHeaders);
      }
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return jsonResponse({ error: String(error) }, 500, corsHeaders);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

/**
 * Requests without an Origin header (curl, server-to-server) pass this check;
 * the optional ACCESS_TOKEN is what stops those. The origin check is what stops
 * other websites from using your Worker from their visitors' browsers.
 */
function isOriginAllowed(requestOrigin: string | null, workerOrigin: string, env: Env): boolean {
  if (!requestOrigin || requestOrigin === workerOrigin) {
    return true;
  }
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return allowedOrigins.includes("*") || allowedOrigins.includes(requestOrigin);
}

function buildCorsHeaders(allowedOrigin: string | null): Record<string, string> {
  if (!allowedOrigin) {
    return {};
  }
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-clicky-token",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

/**
 * An upstream 401/403 means one of the Worker's own API keys is wrong. Report
 * it as 502 so the app doesn't mistake it for a bad access token or origin.
 */
function upstreamErrorStatus(upstreamStatus: number | undefined): number {
  if (!upstreamStatus || upstreamStatus === 401 || upstreamStatus === 403) {
    return 502;
  }
  return upstreamStatus;
}

function jsonResponse(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

async function handleChat(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const chatRequestBody = (await request.json()) as ChatRequestBody;

  const clicky = findClickyById(chatRequestBody.clickyId);
  if (!clicky) {
    return jsonResponse({ error: "Unknown clickyId" }, 400, corsHeaders);
  }

  const transcript = String(chatRequestBody.transcript ?? "").trim();
  if (!transcript || transcript.length > MAX_TRANSCRIPT_CHARACTERS) {
    return jsonResponse({ error: "Transcript is empty or too long" }, 400, corsHeaders);
  }

  const screenshot = chatRequestBody.screenshot ?? null;
  if (screenshot) {
    const screenshotIsValid =
      ALLOWED_SCREENSHOT_MEDIA_TYPES.includes(screenshot.mediaType) &&
      typeof screenshot.base64 === "string" &&
      screenshot.base64.length <= MAX_SCREENSHOT_BASE64_CHARACTERS &&
      Number.isInteger(screenshot.width) &&
      Number.isInteger(screenshot.height);
    if (!screenshotIsValid) {
      return jsonResponse({ error: "Invalid screenshot" }, 400, corsHeaders);
    }
  }

  // Earlier turns are sent as text only; only the newest turn carries a
  // screenshot. That keeps each request small while Claude still remembers
  // the conversation.
  const recentHistoryTurns = (chatRequestBody.history ?? []).slice(-MAX_HISTORY_TURNS);
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const historyTurn of recentHistoryTurns) {
    messages.push({ role: "user", content: String(historyTurn.userText).slice(0, MAX_TRANSCRIPT_CHARACTERS) });
    messages.push({ role: "assistant", content: String(historyTurn.assistantText).slice(0, MAX_TRANSCRIPT_CHARACTERS) });
  }

  const newestTurnContent: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (screenshot) {
    newestTurnContent.push({
      type: "image",
      source: { type: "base64", media_type: screenshot.mediaType, data: screenshot.base64 },
    });
    newestTurnContent.push({
      type: "text",
      text: `(screenshot of the user's screen, ${screenshot.width}x${screenshot.height} pixels)`,
    });
  } else {
    newestTurnContent.push({ type: "text", text: "(no screenshot this turn: the user isn't sharing a screen)" });
  }
  newestTurnContent.push({ type: "text", text: transcript });
  messages.push({ role: "user", content: newestTurnContent });

  const anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let claudeEventStream;
  try {
    // Awaiting create() waits for Claude's response headers, so a bad key,
    // rate limit or outage becomes a real HTTP error the app can show,
    // instead of an empty 200 stream.
    claudeEventStream = await anthropicClient.beta.messages.create({
      model: env.CLAUDE_MODEL || "claude-opus-5-5",
      max_tokens: 8000,
      // Low effort keeps spoken replies quick; raise it if answers feel shallow.
      output_config: { effort: "low" },
      system: buildSystemPrompt(clicky.focus),
      messages,
      stream: true,
      // If Claude's safety classifiers decline, retry on Anthropic's
      // recommended fallback model instead of returning a refusal.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(`[/api/chat] Claude API error ${error.status}: ${error.message}`);
      return jsonResponse({ error: `Claude: ${error.message}` }, upstreamErrorStatus(error.status), corsHeaders);
    }
    throw error;
  }

  // Each line of the body is one raw Messages API stream event as JSON.
  return new Response(claudeEventStream.toReadableStream(), {
    status: 200,
    headers: {
      ...corsHeaders,
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
    },
  });
}

async function handleTTS(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  if (!env.ELEVENLABS_API_KEY) {
    return jsonResponse({ error: "Voice replies aren't set up: add the ELEVENLABS_API_KEY secret" }, 501, corsHeaders);
  }
  const { clickyId, text } = (await request.json()) as { clickyId: string; text: string };

  const clicky = findClickyById(clickyId);
  const spokenText = String(text ?? "").trim();
  if (!clicky || !spokenText || spokenText.length > MAX_TTS_CHARACTERS) {
    return jsonResponse({ error: "Unknown clickyId, or text is empty or too long" }, 400, corsHeaders);
  }

  const voiceId = clicky.voiceId ?? env.ELEVENLABS_VOICE_ID;
  const elevenLabsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: spokenText,
      model_id: "eleven_flash_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!elevenLabsResponse.ok) {
    const errorBody = await elevenLabsResponse.text();
    console.error(`[/api/tts] ElevenLabs error ${elevenLabsResponse.status}: ${errorBody}`);
    return jsonResponse(
      { error: `ElevenLabs ${elevenLabsResponse.status}: ${errorBody.slice(0, 300)}` },
      upstreamErrorStatus(elevenLabsResponse.status),
      corsHeaders,
    );
  }

  return new Response(elevenLabsResponse.body, {
    status: 200,
    headers: { ...corsHeaders, "content-type": "audio/mpeg" },
  });
}

async function handleTranscribeToken(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  if (!env.ASSEMBLYAI_API_KEY) {
    return jsonResponse({ error: "Voice input isn't set up: add the ASSEMBLYAI_API_KEY secret" }, 501, corsHeaders);
  }
  const assemblyAIResponse = await fetch("https://streaming.assemblyai.com/v3/token?expires_in_seconds=480", {
    method: "GET",
    headers: { authorization: env.ASSEMBLYAI_API_KEY },
  });

  const responseBody = await assemblyAIResponse.text();
  if (!assemblyAIResponse.ok) {
    console.error(`[/api/transcribe-token] AssemblyAI error ${assemblyAIResponse.status}: ${responseBody}`);
    return jsonResponse(
      { error: `AssemblyAI ${assemblyAIResponse.status}: ${responseBody.slice(0, 300)}` },
      upstreamErrorStatus(assemblyAIResponse.status),
      corsHeaders,
    );
  }
  return new Response(responseBody, {
    status: 200,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

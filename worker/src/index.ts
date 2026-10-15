/**
 * Cursor Agent Worker
 *
 * Serves the SDK (/cursor-agent.js) and the demo site from ../web as static
 * files, and runs agent steps for the SDK so the Anthropic key never reaches
 * a browser.
 *
 * Route:
 *   POST /api/agent → one Claude step: { messages, siteActions } in,
 *                      { content, stop_reason, stop_details } out.
 *                      The SDK runs the tools on the page and calls again.
 *
 * Access control: browsers may only call /api/agent from this Worker's own
 * origin or an origin listed in ALLOWED_ORIGINS (sites embedding the SDK, or
 * the extension's chrome-extension://<id>). If the ACCESS_TOKEN secret is set,
 * every request must also send it in the x-cursor-agent-token header.
 */

import Anthropic from "@anthropic-ai/sdk";
import { AGENT_SYSTEM_PROMPT, BUILT_IN_TOOLS, BUILT_IN_TOOL_NAMES } from "./agent";

interface Env {
  ANTHROPIC_API_KEY: string;
  CLAUDE_MODEL?: string;
  AGENT_EFFORT?: string;
  ALLOWED_ORIGINS?: string;
  ACCESS_TOKEN?: string;
}

interface SiteAction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface AgentRequestBody {
  messages: Anthropic.Beta.BetaMessageParam[];
  siteActions?: SiteAction[];
}

const MAX_REQUEST_BYTES = 4_000_000;
const MAX_MESSAGES = 80;
const MAX_SITE_ACTIONS = 20;
const MAX_SITE_ACTION_SCHEMA_CHARACTERS = 4000;
const SITE_ACTION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

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
      return jsonResponse({ error: `Origin ${requestOrigin} is not in ALLOWED_ORIGINS` }, 403, corsHeaders);
    }
    if (env.ACCESS_TOKEN && request.headers.get("x-cursor-agent-token") !== env.ACCESS_TOKEN) {
      return jsonResponse({ error: "Missing or wrong access token" }, 401, corsHeaders);
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    try {
      if (url.pathname === "/api/agent") {
        return await handleAgentStep(request, env, corsHeaders);
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
    "access-control-allow-headers": "content-type, x-cursor-agent-token",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function jsonResponse(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

/** Turns the site actions a page registered into Claude tools, rejecting anything malformed. */
function buildSiteActionTools(siteActions: unknown): Anthropic.Beta.BetaTool[] | string {
  if (siteActions === undefined) {
    return [];
  }
  if (!Array.isArray(siteActions) || siteActions.length > MAX_SITE_ACTIONS) {
    return `siteActions must be an array of at most ${MAX_SITE_ACTIONS}`;
  }
  const siteActionTools: Anthropic.Beta.BetaTool[] = [];
  for (const siteAction of siteActions as SiteAction[]) {
    const nameIsValid =
      typeof siteAction?.name === "string" &&
      SITE_ACTION_NAME_PATTERN.test(siteAction.name) &&
      !BUILT_IN_TOOL_NAMES.has(siteAction.name);
    const parameters = siteAction?.parameters ?? { type: "object", properties: {} };
    const parametersAreValid =
      typeof parameters === "object" &&
      parameters !== null &&
      (parameters as { type?: unknown }).type === "object" &&
      JSON.stringify(parameters).length <= MAX_SITE_ACTION_SCHEMA_CHARACTERS;
    if (!nameIsValid || !parametersAreValid) {
      return `Invalid site action: ${String(siteAction?.name)}`;
    }
    siteActionTools.push({
      name: siteAction.name,
      description: `Site action provided by this page. ${String(siteAction.description ?? "").slice(0, 1000)}`,
      input_schema: parameters as Anthropic.Beta.BetaTool.InputSchema,
    });
  }
  return siteActionTools;
}

async function handleAgentStep(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const requestBodyText = await request.text();
  if (requestBodyText.length > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Request too large; start a new conversation" }, 413, corsHeaders);
  }
  const agentRequestBody = JSON.parse(requestBodyText) as AgentRequestBody;

  const messages = agentRequestBody.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return jsonResponse({ error: `messages must have 1 to ${MAX_MESSAGES} entries` }, 400, corsHeaders);
  }

  const siteActionTools = buildSiteActionTools(agentRequestBody.siteActions);
  if (typeof siteActionTools === "string") {
    return jsonResponse({ error: siteActionTools }, 400, corsHeaders);
  }

  const effort: EffortLevel = EFFORT_LEVELS.includes(env.AGENT_EFFORT as EffortLevel)
    ? (env.AGENT_EFFORT as EffortLevel)
    : "low";

  const anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const agentMessage = await anthropicClient.beta.messages.create({
      model: env.CLAUDE_MODEL || "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort },
      system: AGENT_SYSTEM_PROMPT,
      tools: [...BUILT_IN_TOOLS, ...siteActionTools],
      messages,
      // The system prompt and tools repeat on every step of a task; caching
      // them makes the later steps cheaper and faster.
      cache_control: { type: "ephemeral" },
      // If Claude's safety classifiers decline, retry on Anthropic's
      // recommended fallback model instead of returning a refusal.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    // The SDK must send `content` back unchanged on the next step (thinking
    // blocks included), so it is returned as-is.
    return jsonResponse(
      {
        content: agentMessage.content,
        stop_reason: agentMessage.stop_reason,
        stop_details: agentMessage.stop_details ?? null,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(`[/api/agent] Claude API error ${error.status}: ${error.message}`);
      // An upstream 401/403 means the Worker's own key is wrong; report it as
      // 502 so the SDK doesn't mistake it for a bad access token or origin.
      const status = !error.status || error.status === 401 || error.status === 403 ? 502 : error.status;
      return jsonResponse({ error: `Claude: ${error.message}` }, status, corsHeaders);
    }
    throw error;
  }
}

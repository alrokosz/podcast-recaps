#!/usr/bin/env node
// Podcast Recaps MCP server for Claude Code. It has no dependencies, because an installed plugin
// is copied without node_modules. It only talks to the local Podcast Recaps service on this Mac,
// and it never reads, stores, or forwards Claude credentials.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "0.1.0";
const API = (process.env.RECAPS_API ?? "http://127.0.0.1:8786").replace(/\/$/, "");
const PACKET_DIR = process.env.RECAPS_PACKET_DIR || join(tmpdir(), "podcast-recaps-packets");
const SESSION_WRITER = "claude-code";

// ---------- local service ----------

class ServiceError extends Error {}

const api = async (path, { method = "GET", body } = {}) => {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ServiceError(
      `The Podcast Recaps service isn't running at ${API}. Start it (see /recaps:setup), then try again.`,
    );
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ServiceError(json.error ?? `The service returned ${response.status}.`);
  return json;
};

/** Finds an episode by label ("1.5") or exact title. */
const findEpisode = (episodes, key) => {
  const wanted = String(key).trim().toLowerCase();
  return episodes.find(({ label, title }) => label.toLowerCase() === wanted || title.toLowerCase() === wanted);
};

const settingsFor = async (showId, overrides) => {
  const defaults = await api(`/api/shows/${showId}/defaults`);
  const settings = { ...defaults, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) };
  return { ...settings, model: SESSION_WRITER };
};

const rangeBody = async (args) => {
  const episodes = await api(`/api/shows/${args.showId}/episodes`);
  const from = findEpisode(episodes, args.from);
  if (!from) throw new ServiceError(`No episode "${args.from}" in this show. Use list_episodes to see labels.`);
  const to = args.to === undefined ? from : findEpisode(episodes, args.to);
  if (!to) throw new ServiceError(`No episode "${args.to}" in this show.`);
  return {
    from: from.guid,
    to: to.guid,
    settings: await settingsFor(args.showId, { mode: args.mode, tone: args.tone, instructions: args.instructions }),
  };
};

// ---------- packets ----------

/** Writes a packet to a private file, since prompts with transcripts are too long for a tool result. */
const writePacketFile = (packet) => {
  mkdirSync(PACKET_DIR, { recursive: true, mode: 0o700 });
  const path = join(PACKET_DIR, `${packet.id}.md`);
  const text = `# Work packet ${packet.id}

Show: ${packet.show ?? "unknown"}
Episode being prepared: ${packet.episode ?? "unknown"}
Step: ${packet.step}
Kind: ${packet.kind}${packet.maxSearches ? `\nMax web searches: ${packet.maxSearches}` : ""}

## How to answer

${packet.instructions}

When done, call the submit_result tool with packetId "${packet.id}" and output set to your JSON value.
If it's rejected, fix exactly what the error says and submit again.

## Output schema (JSON Schema)

\`\`\`json
${JSON.stringify(packet.outputSchema, null, 2)}
\`\`\`

## System instructions

${packet.system}

## Task

${packet.prompt}
`;
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

const packetPath = (id) => join(PACKET_DIR, `${String(id).replace(/[^\w-]/g, "")}.md`);

// ---------- tools ----------

const tools = [
  {
    name: "status",
    description: "Checks the local Podcast Recaps service and lists shows, active jobs, and work waiting for Claude Code.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const [status, shows, jobs, packets] = await Promise.all([
        api("/api/status"),
        api("/api/shows"),
        api("/api/jobs"),
        api("/api/packets"),
      ]);
      const active = jobs.filter(({ status: s }) => ["queued", "running", "waiting_for_budget"].includes(s));
      return {
        service: API,
        webUi: API,
        apiKeyConfigured: status.apiKeyConfigured,
        spentThisMonthUsd: status.spentThisMonthUsd,
        shows: shows.map(({ id, title }) => ({ id, title })),
        activeJobs: active.map(({ id, showId, episodeGuid, status: s, progress, settings }) => ({
          id,
          showId,
          episodeGuid,
          status: s,
          progress,
          writer: settings?.model === SESSION_WRITER ? "Claude Code" : settings?.model,
        })),
        packetsWaitingForClaudeCode: packets.length,
      };
    },
  },
  {
    name: "search_podcasts",
    description: "Searches Apple Podcasts by name and returns feed URLs that can be added.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: ({ query }) => api(`/api/search?q=${encodeURIComponent(query)}`),
  },
  {
    name: "add_show",
    description: "Adds a show by RSS feed URL. Free: it only reads the public feed. Returns the show and its private feed URL.",
    inputSchema: { type: "object", properties: { feedUrl: { type: "string" } }, required: ["feedUrl"] },
    run: async ({ feedUrl }) => {
      const show = await api("/api/shows", { method: "POST", body: { feedUrl } });
      const feed = await api(`/api/shows/${show.id}/feed`).catch(() => ({}));
      return { id: show.id, title: show.title, privateFeedUrl: feed.feedUrl ?? null, qrCodeAndSettings: API };
    },
  },
  {
    name: "list_episodes",
    description:
      "Lists a show's episodes (label, title, recap status). Filter with query, or onlyWithRecaps. Returns at most 150.",
    inputSchema: {
      type: "object",
      properties: {
        showId: { type: "integer" },
        query: { type: "string", description: "Matches labels and titles." },
        onlyWithRecaps: { type: "boolean" },
      },
      required: ["showId"],
    },
    run: async ({ showId, query, onlyWithRecaps }) => {
      const episodes = await api(`/api/shows/${showId}/episodes`);
      const wanted = query?.toLowerCase();
      const rows = episodes
        .filter(({ label, title }) => !wanted || `${label} ${title}`.toLowerCase().includes(wanted))
        .filter((episode) => !onlyWithRecaps || episode.publishedJobId || episode.latestJob)
        .map(({ label, title, publishedJobId, deliveredToPhone, latestJob }) => ({
          label,
          title,
          recap: deliveredToPhone
            ? "on iPhone"
            : publishedJobId
              ? "ready"
              : (latestJob?.status ?? null),
        }));
      return { total: rows.length, episodes: rows.slice(0, 150) };
    },
  },
  {
    name: "estimate",
    description:
      "Estimates preparing a range of episodes with Claude Code. Costs nothing to call. Reports how many recaps and new episode summaries the session would write.",
    inputSchema: rangeSchema(),
    run: async (args) => {
      const result = await api(`/api/shows/${args.showId}/estimate`, { method: "POST", body: await rangeBody(args) });
      const episodes = result.episodes ?? [];
      return {
        recapsToWrite: episodes.filter(({ reusesSavedRecap }) => !reusesSavedRecap).length,
        alreadyWritten: episodes.filter(({ reusesSavedRecap }) => reusesSavedRecap).length,
        newEpisodeSummaries: episodes.reduce((sum, { newSummaries }) => sum + (newSummaries ?? 0), 0),
        apiCostUsd: 0,
        note: "Written by this Claude Code session on the user's plan, so there's no API cost, but it uses plan usage.",
      };
    },
  },
  {
    name: "queue_recaps",
    description:
      "Queues recaps for a range of episodes, written by this Claude Code session. Only call this after the user has confirmed the range.",
    inputSchema: rangeSchema(),
    run: async (args) => {
      const jobs = await api(`/api/shows/${args.showId}/prepare`, { method: "POST", body: await rangeBody(args) });
      return { queuedJobs: jobs.length, next: "Call next_packet to start writing." };
    },
  },
  {
    name: "next_packet",
    description:
      "Claims the next piece of writing for Claude Code and saves it to a private file. Waits up to waitSeconds for one. Returns packet: null when there's nothing to do yet.",
    inputSchema: {
      type: "object",
      properties: { waitSeconds: { type: "number", description: "Default 45, at most 60." } },
    },
    run: async ({ waitSeconds = 45 }) => {
      const result = await api("/api/packets/next", { method: "POST", body: { waitSeconds: Math.min(waitSeconds, 60) } });
      if (!result.packet) {
        return {
          packet: null,
          activeClaudeCodeJobs: result.activeJobs,
          progress: result.progress,
          hint: result.activeJobs
            ? "Jobs are still running (for example transcribing). Call next_packet again."
            : "Nothing is waiting for Claude Code.",
        };
      }
      const { packet } = result;
      return {
        packet: {
          id: packet.id,
          step: packet.step,
          kind: packet.kind,
          independentReview: packet.independent,
          show: packet.show,
          episode: packet.episode,
          file: writePacketFile(packet),
        },
        agent: packet.independent ? "recap-checker" : "recap-writer",
      };
    },
  },
  {
    name: "submit_result",
    description: "Submits the JSON output for a work packet. If it's rejected, the error says what to fix.",
    inputSchema: {
      type: "object",
      properties: { packetId: { type: "string" }, output: { description: "The JSON value matching the packet's schema." } },
      required: ["packetId", "output"],
    },
    run: async ({ packetId, output }) => {
      // Some clients pass JSON as a string, so accept both.
      let value = output;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          // Validation reports the problem.
        }
      }
      await api(`/api/packets/${encodeURIComponent(packetId)}/result`, { method: "POST", body: { output: value } });
      rmSync(packetPath(packetId), { force: true });
      return { ok: true };
    },
  },
  {
    name: "release_packet",
    description: "Puts a claimed packet back in the queue, for example when stopping early.",
    inputSchema: { type: "object", properties: { packetId: { type: "string" } }, required: ["packetId"] },
    run: async ({ packetId }) => {
      await api(`/api/packets/${encodeURIComponent(packetId)}/release`, { method: "POST", body: {} });
      rmSync(packetPath(packetId), { force: true });
      return { ok: true };
    },
  },
  {
    name: "cancel_job",
    description: "Cancels a queued or running recap job.",
    inputSchema: { type: "object", properties: { jobId: { type: "integer" } }, required: ["jobId"] },
    run: ({ jobId }) => api(`/api/jobs/${jobId}/cancel`, { method: "POST", body: {} }),
  },
];

function rangeSchema() {
  return {
    type: "object",
    properties: {
      showId: { type: "integer" },
      from: { type: "string", description: "First episode label, such as 1.5." },
      to: { type: "string", description: "Last episode label. Defaults to from." },
      mode: { type: "string", enum: ["previously-on", "recap", "further-context"], description: "Defaults to the show's saved mode." },
      tone: { type: "string", enum: ["dramatic", "documentary", "conversational", "playful"] },
      instructions: { type: "string", description: "Listener preferences, such as 'focus on the key people'." },
    },
    required: ["showId", "from"],
  };
}

// ---------- MCP over stdio (newline-delimited JSON-RPC) ----------

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const handle = async ({ id, method, params }) => {
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "podcast-recaps", version: VERSION },
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const tool = tools.find(({ name }) => name === params?.name);
    if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
    try {
      const result = await tool.run(params.arguments ?? {});
      return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (error) {
      const message = error instanceof ServiceError ? error.message : `Unexpected error: ${error?.message ?? error}`;
      return reply(id, { content: [{ type: "text", text: message }], isError: true });
    }
  }
  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return replyError(null, -32700, "Parse error");
  }
  // Notifications (no id), such as notifications/initialized, need no reply.
  handle(message).catch((error) => process.stderr.write(`podcast-recaps: ${error?.stack ?? error}\n`));
});

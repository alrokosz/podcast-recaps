import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import QRCode from "qrcode";
import { estimateBatch } from "./costs.js";
import { deleteApiKey, saveApiKey } from "./keychain.js";
import { contextEpisodes, type Episode } from "./feed.js";
import { coversFile, feedUrl } from "./feedxml.js";
import { PUBLIC_BASE_URL_KEY, parseRange } from "./public.js";
import { MAX_WAIT_MS, type Packet, type PacketQueue, SESSION_WRITER } from "./packets.js";
import { funnelCommand } from "./tailscale.js";
import { fetchShow, showDir } from "./pipeline.js";
import { describeError, resolveSettings } from "./settings.js";
import { ACTIVE_STATUSES, type JobRow, type ShowRow, type Store } from "./store.js";
import type { Worker } from "./worker.js";

export interface ApiOptions {
  store: Store;
  worker: Worker;
  /** Writing steps waiting for a Claude Code session, which the plugin claims and submits here. */
  packets?: PacketQueue;
  dataDir: string;
  hasApiKey: () => Promise<boolean>;
  /** Replaces network feed fetching, for tests. */
  fetchFeed?: typeof fetchShow;
  /** The loopback port of the public feed server, which Tailscale Funnel forwards to. */
  feedServerPort?: number;
  /** Replace Keychain, voice listing, and directory search, for tests. */
  keys?: { save: (key: string) => Promise<void>; remove: () => Promise<void> };
  listVoices?: () => Promise<{ name: string; locale: string }[]>;
  searchPodcasts?: typeof searchApplePodcasts;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 64 * 1024;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Blocks DNS rebinding (a foreign site resolving its own name to 127.0.0.1) by checking Host,
 * and cross-site requests by checking Origin. Requiring JSON also stops plain HTML form posts.
 */
const checkLocalRequest = (req: IncomingMessage): void => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) throw new HttpError(403, "This service only accepts local requests.");
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      // Treated as foreign below.
    }
    if (!LOCAL_HOSTS.has(originHost) && !LOCAL_HOSTS.has(`[${originHost}]`)) {
      throw new HttpError(403, "Cross-site requests are not allowed.");
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "Send requests as application/json.");
  }
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
};

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(json);
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const publicJob = (job: JobRow) => ({
  id: job.id,
  batchId: job.batchId,
  showId: job.showId,
  episodeGuid: job.episodeGuid,
  mode: job.settings.mode,
  settings: job.settings,
  status: job.status,
  progress: job.progress,
  error: job.error,
  estimatedCostUsd: job.estimatedCostUsd,
  costUsd: Number(job.costUsd.toFixed(4)),
  hasAudio: Boolean(job.audioPath),
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
});

/** A non-JSON response, such as the QR code or recap audio. */
class RawResponse {
  constructor(readonly write: (req: IncomingMessage, res: ServerResponse) => void) {}
}

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");
const UI_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

/** Only this page's own files, artwork from https, and local audio. No inline scripts. */
const UI_POLICY =
  "default-src 'self'; img-src 'self' https: data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const serveUiFile = (res: ServerResponse, entry: { file: string; type: string }) => {
  const body = readFileSync(join(UI_DIR, entry.file));
  res.writeHead(200, {
    "Content-Type": entry.type,
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "Content-Security-Policy": UI_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
};

/** Lists macOS voices from `say -v ?`, such as "Samantha (en_US)". */
const listMacVoices = async (): Promise<{ name: string; locale: string }[]> => {
  const { stdout } = await promisify(execFile)("say", ["-v", "?"]);
  return stdout
    .split("\n")
    .map((line) => /^(.+?)\s{2,}([a-z]{2}_[A-Z0-9]+)\s/.exec(line))
    .flatMap((match) => (match?.[1] && match[2] ? [{ name: match[1].trim(), locale: match[2] }] : []));
};

/** Searches Apple's public podcast directory. Only the search words are sent. */
const searchApplePodcasts = async (query: string) => {
  const url = `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=12&term=${encodeURIComponent(query)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new HttpError(502, `Podcast search failed (${response.status}).`);
  const { results } = (await response.json()) as {
    results: { collectionName?: string; artistName?: string; feedUrl?: string; artworkUrl100?: string; trackCount?: number }[];
  };
  return results
    .filter(({ feedUrl: url }) => url)
    .map((result) => ({
      title: result.collectionName ?? "Untitled",
      author: result.artistName ?? null,
      feedUrl: result.feedUrl as string,
      imageUrl: result.artworkUrl100 ?? null,
      episodes: result.trackCount ?? null,
    }));
};

/** Show fields for the UI. The feed token stays out of list responses. */
const publicShow = ({ feedToken: _feedToken, ...row }: ShowRow) => row;

export const createApi = (options: ApiOptions): Server => {
  const { store, worker, dataDir } = options;
  const fetchFeed = options.fetchFeed ?? fetchShow;
  const keys = options.keys ?? { save: saveApiKey, remove: deleteApiKey };
  const voices = options.listVoices ?? listMacVoices;
  const search = options.searchPodcasts ?? searchApplePodcasts;

  const jobFile = (id: number) => {
    const job = store.getJob(Number(id));
    if (!job) throw new HttpError(404, "No job with that id.");
    return job;
  };

  const requireShow = (id: number) => {
    const show = store.loadShow(id);
    const row = store.getShow(id);
    if (!show || !row) throw new HttpError(404, "No show with that id.");
    return { show, row };
  };

  /** Picks episodes by guid list, or by an inclusive range of episode labels or guids. */
  const pickEpisodes = (episodes: Episode[], body: Record<string, unknown>): Episode[] => {
    const find = (key: unknown) => episodes.find(({ guid, label }) => guid === key || label === key);
    if (Array.isArray(body.episodes)) {
      return body.episodes.map((key) => {
        const episode = find(key);
        if (!episode) throw new HttpError(400, `No episode "${String(key)}" in this show.`);
        return episode;
      });
    }
    if (body.from !== undefined) {
      const from = find(body.from);
      const to = body.to === undefined ? episodes.at(-1) : find(body.to);
      if (!from || !to) throw new HttpError(400, "Unknown episode in from/to.");
      return episodes.filter(({ index }) => index >= from.index && index <= to.index);
    }
    throw new HttpError(400, 'Choose episodes with "episodes": [...] or "from" and optional "to".');
  };

  const plan = (showId: number, body: Record<string, unknown>) => {
    const { show } = requireShow(showId);
    let settings;
    try {
      settings = resolveSettings(body.settings);
    } catch (error) {
      throw new HttpError(400, describeError(error));
    }
    // Episodes with nothing earlier in their season to recap are skipped.
    const targets = pickEpisodes(show.episodes, body).filter((episode) => contextEpisodes(show, episode).length > 0);
    if (!targets.length) throw new HttpError(400, "None of these episodes have earlier episodes to recap.");
    if (targets.length > 500) throw new HttpError(400, "Prepare at most 500 episodes at a time.");
    const estimates = estimateBatch(showDir(dataDir, show.slug), show, targets, settings);
    return { show, settings, estimates };
  };

  const requirePackets = (): PacketQueue => {
    if (!options.packets) throw new HttpError(503, "Claude Code packets aren't enabled in this service.");
    return options.packets;
  };

  /** The show and episode a packet is for, so a session can say what it's working on. */
  const packetContext = (packet: Packet) => {
    const job = store.getJob(packet.jobId);
    const show = job ? store.getShow(job.showId) : undefined;
    const episode = job ? store.loadShow(job.showId)?.episodes.find(({ guid }) => guid === job.episodeGuid) : undefined;
    return { show: show?.title ?? null, episode: episode ? `${episode.label} · ${episode.title}` : null };
  };
  const packetSummary = (packet: Packet) => ({
    id: packet.id,
    jobId: packet.jobId,
    step: packet.step,
    kind: packet.kind,
    claimed: Boolean(packet.claimedAt),
    ...packetContext(packet),
  });
  const describePacket = (packet: Packet) => ({ ...packet, ...packetContext(packet) });

  type Handler = (match: string[], body: Record<string, unknown>, query: URLSearchParams) => Promise<unknown> | unknown;
  const routes: { method: string; pattern: RegExp; handle: Handler }[] = [
    {
      method: "GET",
      pattern: /^\/api\/status$/,
      handle: async () => ({
        apiKeyConfigured: await options.hasApiKey(),
        ...worker.budget(),
        runningJobId: worker.currentJobId ?? null,
        queuedJobs: store.listJobs({ statuses: ["queued"] }).length,
        waitingForBudget: store.listJobs({ statuses: ["waiting_for_budget"] }).length,
      }),
    },
    {
      method: "PUT",
      pattern: /^\/api\/budget$/,
      handle: (_, body) => {
        const cap = body.monthlyCapUsd;
        if (cap !== null && (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0 || cap > 10_000)) {
          throw new HttpError(400, "monthlyCapUsd must be a number from 0 to 10000, or null for no cap.");
        }
        worker.setMonthlyCap(cap);
        return worker.budget();
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/shows$/,
      handle: () => store.listShows().map(publicShow),
    },
    {
      method: "POST",
      pattern: /^\/api\/shows$/,
      handle: async (_, body) => {
        const feedUrl = typeof body.feedUrl === "string" ? body.feedUrl.trim() : "";
        if (!/^https?:\/\//i.test(feedUrl)) throw new HttpError(400, "feedUrl must be an http or https URL.");
        const { show } = await fetchFeed(feedUrl).catch((error: unknown) => {
          throw new HttpError(502, describeError(error));
        });
        return publicShow(store.saveShow(feedUrl, show));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/shows\/(\d+)\/refresh$/,
      handle: async ([id]) => {
        const { row } = requireShow(Number(id));
        const { show } = await fetchFeed(row.feedUrl).catch((error: unknown) => {
          throw new HttpError(502, describeError(error));
        });
        return publicShow(store.saveShow(row.feedUrl, show));
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/shows\/(\d+)$/,
      handle: ([id]) => {
        requireShow(Number(id));
        store.cancelJobs({ showId: Number(id) });
        const running = worker.currentJobId === undefined ? undefined : store.getJob(worker.currentJobId);
        if (running?.showId === Number(id)) worker.cancel(running.id);
        store.deleteShow(Number(id));
        return { deleted: true };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/shows\/(\d+)\/episodes$/,
      handle: ([id]) => {
        const { show } = requireShow(Number(id));
        const jobs = store.listJobs({ showId: Number(id) });
        const published = store.publishedRecaps(Number(id));
        return show.episodes.map((episode) => {
          // Jobs are newest first, so the first match is the latest.
          const latest = jobs.find(({ episodeGuid }) => episodeGuid === episode.guid);
          const recap = published.get(episode.guid);
          const delivery = recap ? store.deliveredRanges(recap.id) : undefined;
          return {
            guid: episode.guid,
            label: episode.label,
            title: episode.title,
            publishedAt: episode.publishedAt.toISOString(),
            durationSeconds: episode.durationSeconds ?? null,
            latestJob: latest ? publicJob(latest) : null,
            publishedJobId: recap?.id ?? null,
            // A strong hint, not proof, that the phone has the whole spliced file.
            deliveredToPhone: Boolean(delivery?.fileSize !== undefined && coversFile(delivery.ranges, delivery.fileSize)),
          };
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/shows\/(\d+)\/estimate$/,
      handle: ([id], body) => {
        const { estimates } = plan(Number(id), body);
        return {
          totalUsd: Number(estimates.reduce((sum, { estimatedCostUsd }) => sum + estimatedCostUsd, 0).toFixed(3)),
          episodes: estimates.map(({ episode, estimatedCostUsd, newSummaries, reusesSavedRecap }) => ({
            guid: episode.guid,
            label: episode.label,
            estimatedCostUsd,
            newSummaries,
            reusesSavedRecap,
          })),
          ...worker.budget(),
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/shows\/(\d+)\/prepare$/,
      handle: async ([id], body) => {
        const { settings, estimates } = plan(Number(id), body);
        if (!(await options.hasApiKey())) throw new HttpError(409, "Set an Anthropic API key first: recaps key set");
        const jobs = store.enqueue(Number(id), estimates, settings);
        worker.kick();
        return jobs.map(publicJob);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/key$/,
      handle: async (_, body) => {
        const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        try {
          await keys.save(key);
        } catch (error) {
          throw new HttpError(400, describeError(error));
        }
        worker.kick();
        return { apiKeyConfigured: true };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/key$/,
      handle: async () => {
        await keys.remove();
        return { apiKeyConfigured: await options.hasApiKey() };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/voices$/,
      handle: () => voices(),
    },
    {
      method: "GET",
      pattern: /^\/api\/search$/,
      handle: (_, __, query) => {
        const term = (query.get("q") ?? "").trim();
        if (term.length < 2) throw new HttpError(400, "Type at least 2 characters to search.");
        return search(term.slice(0, 100));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/publishing\/check$/,
      handle: async () => {
        const base = store.getSetting(PUBLIC_BASE_URL_KEY);
        if (!base) return { reachable: false, reason: "No public URL is set." };
        try {
          const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(8000) });
          return response.ok
            ? { reachable: true }
            : { reachable: false, reason: `The public URL answered ${response.status}. Is Tailscale Funnel on?` };
        } catch {
          return { reachable: false, reason: "The public URL can't be reached. Turn on Tailscale Funnel." };
        }
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/shows\/(\d+)$/,
      handle: ([id]) => {
        const { show, row } = requireShow(Number(id));
        return {
          id: row.id,
          title: show.title,
          author: show.author ?? null,
          imageUrl: show.imageUrl ?? null,
          feedUrl: row.feedUrl,
          refreshedAt: row.refreshedAt,
          episodeCount: show.episodes.length,
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/shows\/(\d+)\/feed\/qr\.svg$/,
      handle: async ([id]) => {
        const { row } = requireShow(Number(id));
        const base = store.getSetting(PUBLIC_BASE_URL_KEY);
        if (!base) throw new HttpError(409, "Set a public URL first.");
        const svg = Buffer.from(await QRCode.toString(feedUrl(base, row.feedToken), { type: "svg", margin: 1 }));
        return new RawResponse((_req, res) => {
          res.writeHead(200, { "Content-Type": "image/svg+xml", "Content-Length": svg.length, "Cache-Control": "no-store" });
          res.end(svg);
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/jobs\/(\d+)\/text$/,
      handle: ([id]) => {
        const job = jobFile(Number(id));
        const read = (path: string | null) => (path && existsSync(path) ? readFileSync(path, "utf8") : null);
        return { text: read(job.textPath), sources: read(job.sourcesPath) };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/jobs\/(\d+)\/audio$/,
      handle: ([id]) => {
        const job = jobFile(Number(id));
        const path = job.audioPath;
        if (!path || !existsSync(path)) throw new HttpError(404, "This job has no audio.");
        return new RawResponse((req, res) => {
          const size = statSync(path).size;
          const range = parseRange(req.headers.range, size);
          if (range === "invalid") return res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
          const start = range?.start ?? 0;
          const end = range?.end ?? size - 1;
          res.writeHead(range ? 206 : 200, {
            "Content-Type": "audio/x-m4a",
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
            ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
          });
          createReadStream(path, { start, end }).on("error", () => res.destroy()).pipe(res);
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/publishing$/,
      handle: () => ({
        publicBaseUrl: store.getSetting(PUBLIC_BASE_URL_KEY) ?? null,
        feedServerPort: options.feedServerPort ?? null,
        funnelCommand: options.feedServerPort ? funnelCommand(options.feedServerPort) : null,
      }),
    },
    {
      method: "PUT",
      pattern: /^\/api\/publishing$/,
      handle: (_, body) => {
        const url = body.publicBaseUrl;
        if (url !== null && (typeof url !== "string" || !/^https:\/\/[\w.-]+(:\d+)?$/.test(url))) {
          throw new HttpError(400, "publicBaseUrl must look like https://name.example.ts.net, or null.");
        }
        store.setSetting(PUBLIC_BASE_URL_KEY, url);
        return { publicBaseUrl: url };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/shows\/(\d+)\/feed$/,
      handle: ([id]) => {
        const { row } = requireShow(Number(id));
        const base = store.getSetting(PUBLIC_BASE_URL_KEY);
        return {
          feedUrl: base ? feedUrl(base, row.feedToken) : null,
          hint: base ? "Add this in Apple Podcasts with Follow a Show by URL. Keep it private." : "Set a public URL first.",
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/shows\/(\d+)\/rotate-feed-token$/,
      handle: ([id]) => {
        requireShow(Number(id));
        const row = store.rotateFeedToken(Number(id)) as ShowRow;
        const base = store.getSetting(PUBLIC_BASE_URL_KEY);
        return { feedUrl: base ? feedUrl(base, row.feedToken) : null };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/shows\/(\d+)\/defaults$/,
      handle: ([id]) => {
        requireShow(Number(id));
        return resolveSettings(store.getShowDefaults(Number(id)));
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/shows\/(\d+)\/defaults$/,
      handle: ([id], body) => {
        requireShow(Number(id));
        let settings;
        try {
          settings = resolveSettings(body.settings);
        } catch (error) {
          throw new HttpError(400, describeError(error));
        }
        store.setShowDefaults(Number(id), settings);
        return settings;
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/jobs$/,
      handle: () => store.listJobs().slice(0, 200).map(publicJob),
    },
    {
      method: "GET",
      pattern: /^\/api\/jobs\/(\d+)$/,
      handle: ([id]) => {
        const job = store.getJob(Number(id));
        if (!job) throw new HttpError(404, "No job with that id.");
        return publicJob(job);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/jobs\/(\d+)\/cancel$/,
      handle: ([id]) => {
        const job = store.getJob(Number(id));
        if (!job) throw new HttpError(404, "No job with that id.");
        if (!ACTIVE_STATUSES.includes(job.status)) throw new HttpError(409, `This job is already ${job.status}.`);
        worker.cancel(job.id);
        return publicJob(store.getJob(job.id) as JobRow);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/batches\/([\w-]+)\/cancel$/,
      handle: ([batchId]) => ({ cancelled: worker.cancelBatch(batchId ?? "") }),
    },

    // Work packets for the Claude Code plugin. Loopback only, like everything on this server.
    {
      method: "GET",
      pattern: /^\/api\/packets$/,
      handle: () => requirePackets().list().map(packetSummary),
    },
    {
      method: "POST",
      pattern: /^\/api\/packets\/next$/,
      handle: async (_, body) => {
        const waitSeconds = body.waitSeconds ?? 0;
        if (typeof waitSeconds !== "number" || !(waitSeconds >= 0)) throw new HttpError(400, "waitSeconds must be a number of seconds.");
        const packet = await requirePackets().next(waitSeconds * 1000);
        if (packet) return { packet: describePacket(packet) };
        // Nothing to write yet: say why, so the session knows whether to wait or stop.
        const active = store.listJobs({ statuses: ["running", "queued"] }).filter(({ settings }) => settings.model === SESSION_WRITER);
        return {
          packet: null,
          activeJobs: active.length,
          progress: active.find(({ status }) => status === "running")?.progress ?? null,
          maxWaitSeconds: MAX_WAIT_MS / 1000,
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/packets\/([\w-]+)\/result$/,
      handle: ([id], body) => {
        const result = requirePackets().submit(id ?? "", body.output);
        if (!result.ok) throw new HttpError(result.status, result.error);
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/packets\/([\w-]+)\/release$/,
      handle: ([id]) => {
        if (!requirePackets().release(id ?? "")) throw new HttpError(404, "No open packet with that id.");
        return { ok: true };
      },
    },
  ];

  return createServer(async (req, res) => {
    try {
      checkLocalRequest(req);
      const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");
      const uiFile = UI_FILES[pathname];
      if (uiFile && req.method === "GET") return serveUiFile(res, uiFile);
      const matching = routes.filter(({ pattern }) => pattern.test(pathname));
      if (!matching.length) throw new HttpError(404, "Not found.");
      const route = matching.find(({ method }) => method === req.method);
      if (!route) throw new HttpError(405, "Method not allowed.");
      const body = req.method === "GET" ? {} : record(await readJson(req));
      const match = route.pattern.exec(pathname)?.slice(1) ?? [];
      const result = await route.handle(match, body, searchParams);
      if (result instanceof RawResponse) return result.write(req, res);
      send(res, 200, result);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      send(res, 500, { error: describeError(error) });
    }
  });
};

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { estimateBatch } from "./costs.js";
import { contextEpisodes, type Episode } from "./feed.js";
import { fetchShow, showDir } from "./pipeline.js";
import { describeError, resolveSettings } from "./settings.js";
import { ACTIVE_STATUSES, type JobRow, type Store } from "./store.js";
import type { Worker } from "./worker.js";

export interface ApiOptions {
  store: Store;
  worker: Worker;
  dataDir: string;
  hasApiKey: () => Promise<boolean>;
  /** Replaces network feed fetching, for tests. */
  fetchFeed?: typeof fetchShow;
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

export const createApi = (options: ApiOptions): Server => {
  const { store, worker, dataDir } = options;
  const fetchFeed = options.fetchFeed ?? fetchShow;

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

  const routes: { method: string; pattern: RegExp; handle: (match: string[], body: Record<string, unknown>) => Promise<unknown> | unknown }[] = [
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
      handle: () => store.listShows(),
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
        return store.saveShow(feedUrl, show);
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
        return store.saveShow(row.feedUrl, show);
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
        return show.episodes.map((episode) => {
          // Jobs are newest first, so the first match is the latest.
          const latest = jobs.find(({ episodeGuid }) => episodeGuid === episode.guid);
          return {
            guid: episode.guid,
            label: episode.label,
            title: episode.title,
            publishedAt: episode.publishedAt.toISOString(),
            durationSeconds: episode.durationSeconds ?? null,
            latestJob: latest ? publicJob(latest) : null,
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
  ];

  return createServer(async (req, res) => {
    try {
      checkLocalRequest(req);
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      const matching = routes.filter(({ pattern }) => pattern.test(pathname));
      if (!matching.length) throw new HttpError(404, "Not found.");
      const route = matching.find(({ method }) => method === req.method);
      if (!route) throw new HttpError(405, "Method not allowed.");
      const body = req.method === "GET" ? {} : record(await readJson(req));
      const match = route.pattern.exec(pathname)?.slice(1) ?? [];
      send(res, 200, await route.handle(match, body));
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      send(res, 500, { error: describeError(error) });
    }
  });
};

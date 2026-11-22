import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { estimateBatch } from "./costs.js";
import type { Episode } from "./feed.js";
import { buildFeed, guidFromKey, nextEpisode, type PublishedRecap } from "./feedxml.js";
import { MODES } from "./modes.js";
import { fetchShow, showDir } from "./pipeline.js";
import { describeError, resolveSettings } from "./settings.js";
import { ACTIVE_STATUSES, type ShowRow, type Store } from "./store.js";
import type { Worker } from "./worker.js";

export const PUBLIC_BASE_URL_KEY = "publicBaseUrl";

/** Feeds older than this are refreshed from the publisher in the background when Apple asks for them. */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

export interface PublicOptions {
  store: Store;
  worker: Worker;
  dataDir: string;
  hasApiKey: () => Promise<boolean>;
  /** Replaces network feed fetching, for tests. */
  fetchFeed?: typeof fetchShow;
}

const notFound = (res: ServerResponse) => res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");

const baseHeaders = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

/** Inclusive byte range, "invalid" for an unsatisfiable header, or null when there is none. */
export const parseRange = (header: string | undefined, size: number): { start: number; end: number } | "invalid" | null => {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "invalid";
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start >= size || start > end ? "invalid" : { start, end };
};

const escapeHtml = (value: string): string =>
  value.replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" })[char] ?? char);

const page = (title: string, body: string, refreshSeconds?: number): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
  body { max-width: 32rem; margin: 2.5rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.35rem; line-height: 1.3; }
  .muted { opacity: 0.7; font-size: 0.95rem; }
  button { font: inherit; font-weight: 600; width: 100%; padding: 0.9rem; border: 0; border-radius: 0.75rem;
           background: #6d28d9; color: white; margin-top: 1rem; }
  .box { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 0.75rem; padding: 1rem; }
</style>
</head>
<body>
${body}
</body>
</html>
`;

export const createPublicServer = (options: PublicOptions): Server => {
  const { store, worker, dataDir } = options;
  const fetchFeed = options.fetchFeed ?? fetchShow;
  const refreshing = new Set<number>();

  const baseUrl = (req: IncomingMessage): string =>
    (store.getSetting(PUBLIC_BASE_URL_KEY) ?? `https://${req.headers.host ?? "localhost"}`).replace(/\/$/, "");

  const refreshIfStale = (row: ShowRow) => {
    if (refreshing.has(row.id) || Date.now() - Date.parse(row.refreshedAt) < REFRESH_AFTER_MS) return;
    refreshing.add(row.id);
    fetchFeed(row.feedUrl)
      .then(({ show }) => store.saveShow(row.feedUrl, show))
      .catch(() => {
        // The saved copy keeps working, and the next request tries again.
      })
      .finally(() => refreshing.delete(row.id));
  };

  const publishedRecaps = (showId: number): Map<string, PublishedRecap> => {
    const recaps = new Map<string, PublishedRecap>();
    for (const [guid, job] of store.publishedRecaps(showId)) {
      if (!job.audioPath || !existsSync(job.audioPath)) continue;
      const sources = job.sourcesPath && existsSync(job.sourcesPath) ? readFileSync(job.sourcesPath, "utf8") : undefined;
      recaps.set(guid, { jobId: job.id, mode: job.settings.mode, fileSize: statSync(job.audioPath).size, sources });
    }
    return recaps;
  };

  const serveFeed = (req: IncomingMessage, res: ServerResponse, row: ShowRow) => {
    const show = store.loadShow(row.id);
    if (!show) return notFound(res);
    refreshIfStale(row);
    const xml = Buffer.from(buildFeed({ show, baseUrl: baseUrl(req), feedToken: row.feedToken, recaps: publishedRecaps(row.id) }));
    res.writeHead(200, {
      ...baseHeaders,
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Content-Length": xml.length,
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : xml);
  };

  const serveAudio = (req: IncomingMessage, res: ServerResponse, row: ShowRow, jobId: number) => {
    const job = store.getJob(jobId);
    if (!job || job.showId !== row.id || job.status !== "done" || !job.audioPath || !existsSync(job.audioPath)) {
      return notFound(res);
    }
    const size = statSync(job.audioPath).size;
    const range = parseRange(req.headers.range, size);
    const headers = { ...baseHeaders, "Accept-Ranges": "bytes", "Content-Type": "audio/x-m4a" };
    if (range === "invalid") {
      return res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end();
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    res.writeHead(range ? 206 : 200, {
      ...headers,
      "Content-Length": end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD") return res.end();

    const stream = createReadStream(job.audioPath, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => {
      stream.destroy();
      // Only fully sent ranges count toward "safe to close the Mac". Apple's 2-byte streaming probe is ignored.
      if (res.writableFinished && end - start > 1) store.recordDelivery(job.id, start, end, size);
    });
    stream.pipe(res);
  };

  /** Shows what Prepare next would do, or how the job is going. */
  const nextPage = async (req: IncomingMessage, res: ServerResponse, row: ShowRow, from: Episode, method: string) => {
    const show = store.loadShow(row.id);
    const next = show && nextEpisode(show, from);
    const html = (title: string, body: string, refresh?: number) => {
      const content = Buffer.from(page(title, body, refresh));
      res.writeHead(200, { ...baseHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": content.length });
      res.end(content);
    };
    if (!show || !next) return html("Nothing to prepare", "<h1>There is no later episode to prepare.</h1>");

    let settings;
    try {
      settings = resolveSettings(store.getShowDefaults(row.id));
    } catch {
      settings = resolveSettings({});
    }
    const heading = `<p class="muted">${escapeHtml(show.title)}</p><h1>${escapeHtml(next.title)}</h1>`;

    if (method === "POST") {
      if (!(await options.hasApiKey())) {
        return html("Not set up", `${heading}<p>The Mac running Podcast Recaps has no API key set, so it can't prepare episodes.</p>`);
      }
      const estimates = estimateBatch(showDir(dataDir, show.slug), show, [next], settings);
      store.enqueue(row.id, estimates, settings);
      worker.kick();
      // Redirect so a reload doesn't resubmit, and the page then shows progress.
      res.writeHead(303, { ...baseHeaders, Location: req.url ?? "/" });
      return res.end();
    }

    const latest = store.listJobs({ showId: row.id }).find(({ episodeGuid }) => episodeGuid === next.guid);
    if (latest?.status === "done" && latest.audioPath) {
      return html(
        "Ready",
        `${heading}<div class="box"><p><strong>Ready.</strong> Refresh the show in Apple Podcasts and download the episode marked "with recap".</p></div>`,
      );
    }
    if (latest && ACTIVE_STATUSES.includes(latest.status)) {
      const waiting = latest.status === "waiting_for_budget";
      return html(
        "Preparing",
        `${heading}<div class="box"><p><strong>${waiting ? "Waiting for budget" : "Preparing"}.</strong> ${escapeHtml(latest.progress ?? "Queued")}</p>
         <p class="muted">${waiting ? "Raise the monthly cap on the Mac to continue." : "This usually takes a few minutes. This page updates by itself."}</p></div>`,
        waiting ? undefined : 10,
      );
    }
    const [estimate] = estimateBatch(showDir(dataDir, show.slug), show, [next], settings);
    const cost = estimate?.reusesSavedRecap ? "free (a recap is already written)" : `about $${(estimate?.estimatedCostUsd ?? 0).toFixed(2)}`;
    const failed = latest?.status === "failed" ? `<p><strong>The last attempt failed:</strong> ${escapeHtml(latest.error ?? "unknown error")}</p>` : "";
    return html(
      "Prepare next episode",
      `${heading}${failed}<p>Add a ${escapeHtml(MODES[settings.mode].label)} recap before this episode. Estimated cost: ${escapeHtml(cost)}.</p>
       <form method="post"><button type="submit">Prepare this episode</button></form>
       <p class="muted">The Mac running Podcast Recaps needs to be awake. The episode appears in your feed when it's ready.</p>`,
    );
  };

  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const isRead = method === "GET" || method === "HEAD";

      const feed = /^\/feed\/([\w-]{20,})\.xml$/.exec(pathname);
      const audio = /^\/audio\/([\w-]{20,})\/(\d+)\.m4a$/.exec(pathname);
      const next = /^\/next\/([\w-]{20,})\/([\w-]+)$/.exec(pathname);
      const token = feed?.[1] ?? audio?.[1] ?? next?.[1];
      const row = token ? store.showByFeedToken(token) : undefined;
      if (!row) return notFound(res);

      if (feed && isRead) return serveFeed(req, res, row);
      if (audio && isRead) return serveAudio(req, res, row, Number(audio[2]));
      if (next && (method === "GET" || method === "POST")) {
        const guid = guidFromKey(next[2] ?? "");
        const from = store.loadShow(row.id)?.episodes.find((episode) => episode.guid === guid);
        if (!from) return notFound(res);
        return await nextPage(req, res, row, from, method);
      }
      notFound(res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" }).end("Something went wrong.");
      console.error(`Public server error: ${describeError(error)}`);
    }
  });
};

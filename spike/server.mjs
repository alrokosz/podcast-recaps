// Apple Podcasts feed spike: private RSS, byte-range audio, and fetch logging.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const audioDir = join(dataDir, "audio");
const manifestPath = join(dataDir, "episodes.json");
const tokenPath = join(dataDir, "token");
const logPath = join(dataDir, "fetches.jsonl");
const port = Number(process.env.PORT ?? 8787);
const publicUrl = (process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");

if (!existsSync(manifestPath)) {
  console.error("Missing test audio. Run: node spike/generate-audio.mjs");
  process.exit(1);
}
const episodes = JSON.parse(readFileSync(manifestPath, "utf8"));

if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString("base64url"), { mode: 0o600 });
const token = readFileSync(tokenPath, "utf8").trim();

const tokenMatches = (candidate) => {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const buildFeed = () => {
  const now = Date.now();
  const items = episodes
    .map((episode) => {
      const pubDate = new Date(now - (episodes.length - episode.number) * 86_400_000).toUTCString();
      return `    <item>
      <title>${episode.title ?? `Spike Episode ${episode.number}`}</title>
      <description>${episode.description ?? "Test audio for Apple Podcasts playback."}</description>
      <guid isPermaLink="false">podcast-recaps-spike-${episode.number}</guid>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${publicUrl}/audio/${token}/${episode.file}" length="${episode.bytes}" type="audio/x-m4a"/>
      <itunes:duration>${episode.durationSeconds}</itunes:duration>
      <itunes:episode>${episode.number}</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Podcast Recaps Spike (Unofficial Test)</title>
    <link>${publicUrl}</link>
    <language>en-us</language>
    <description>Private test feed.</description>
    <itunes:author>Podcast Recaps Spike</itunes:author>
    <itunes:block>Yes</itunes:block>
    <itunes:type>serial</itunes:type>
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>
`;
};

// Returns null for no range, "invalid" for an unsatisfiable range, or inclusive offsets.
const parseRange = (header, size) => {
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

const logFetch = (req, type, file, status, extra = {}) => {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      type,
      file,
      method: req.method,
      status,
      range: req.headers.range ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      forwardedFor: req.headers["x-forwarded-for"] ?? null,
      ...extra,
    })}\n`,
  );
};

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const isRead = req.method === "GET" || req.method === "HEAD";
  const notFound = () => res.writeHead(404).end();
  if (!isRead) return res.writeHead(405, { Allow: "GET, HEAD" }).end();

  const feed = /^\/feed\/([\w-]+)\.xml$/.exec(pathname);
  if (feed) {
    if (!tokenMatches(feed[1])) return notFound();
    const body = Buffer.from(buildFeed());
    logFetch(req, "feed", null, 200);
    res.writeHead(200, {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Robots-Tag": "noindex",
    });
    return req.method === "HEAD" ? res.end() : res.end(body);
  }

  const audio = /^\/audio\/([\w-]+)\/(episode-\d+\.m4a)$/.exec(pathname);
  if (!audio || !tokenMatches(audio[1])) return notFound();
  const episode = episodes.find(({ file }) => file === audio[2]);
  if (!episode) return notFound();

  const path = join(audioDir, episode.file);
  const size = statSync(path).size;
  const range = parseRange(req.headers.range, size);
  const baseHeaders = { "Accept-Ranges": "bytes", "Content-Type": "audio/x-m4a", "X-Robots-Tag": "noindex" };

  if (range === "invalid") {
    logFetch(req, "audio", episode.file, 416);
    return res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${size}` }).end();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const status = range ? 206 : 200;
  logFetch(req, "audio", episode.file, status);
  res.writeHead(status, {
    ...baseHeaders,
    "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === "HEAD") return res.end();

  const stream = createReadStream(path, { start, end });
  let bytesRead = 0;
  stream.on("data", (chunk) => {
    bytesRead += chunk.length;
  });
  stream.on("error", () => res.destroy());
  res.on("close", () => {
    stream.destroy();
    logFetch(req, "audio-end", episode.file, status, {
      bytesRead,
      bytesRequested: end - start + 1,
      completed: res.writableFinished,
    });
  });
  stream.pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Listening on 127.0.0.1:${port}`);
  console.log(`Feed: ${publicUrl}/feed/${token}.xml`);
});

import { contextEpisodes, type Episode, type Show } from "./feed.js";
import { MODES, type Mode } from "./modes.js";

export interface PublishedRecap {
  jobId: number;
  mode: Mode;
  fileSize: number;
  /** Plain-text background sources, for Further Context. */
  sources?: string;
}

export interface FeedInput {
  show: Show;
  baseUrl: string;
  feedToken: string;
  /** Finished recaps keyed by episode guid. */
  recaps: Map<string, PublishedRecap>;
}

const escapeXml = (value: string): string =>
  value.replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char] ?? char);

/** CDATA can't contain "]]>", so split it across two sections. */
const cdata = (value: string): string => `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

const escapeHtml = escapeXml;

/** URL-safe key for an episode, since publisher guids can contain any characters. */
export const episodeKey = (guid: string): string => Buffer.from(guid, "utf8").toString("base64url");

export const guidFromKey = (key: string): string => Buffer.from(key, "base64url").toString("utf8");

export const feedUrl = (baseUrl: string, feedToken: string): string => `${baseUrl}/feed/${feedToken}.xml`;

export const audioUrl = (baseUrl: string, feedToken: string, jobId: number): string =>
  `${baseUrl}/audio/${feedToken}/${jobId}.m4a`;

export const nextUrl = (baseUrl: string, feedToken: string, guid: string): string =>
  `${baseUrl}/next/${feedToken}/${episodeKey(guid)}`;

/** The episode a "Prepare next" link from `episode` would prepare, if any has earlier episodes to recap. */
export const nextEpisode = (show: Show, episode: Episode): Episode | undefined =>
  show.episodes.find((candidate) => candidate.index > episode.index && contextEpisodes(show, candidate).length > 0);

const showNotes = (input: FeedInput, episode: Episode, recap: PublishedRecap | undefined): string => {
  const parts: string[] = [];
  if (recap) {
    parts.push(
      `<p><strong>Unofficial:</strong> this copy opens with an AI-generated ${escapeHtml(MODES[recap.mode].label)} segment, followed by the original episode.</p>`,
    );
    if (recap.sources) {
      const lines = recap.sources
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/^- /, "").trim())
        .filter(Boolean);
      parts.push(`<p>Background sources:</p><ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`);
    }
  }
  const next = nextEpisode(input.show, episode);
  if (next && !input.recaps.has(next.guid)) {
    const link = nextUrl(input.baseUrl, input.feedToken, episode.guid);
    parts.push(`<p><a href="${escapeHtml(link)}">Prepare the next episode with a recap</a></p>`);
  }
  if (episode.description) parts.push("<hr/>", episode.description);
  return parts.join("\n");
};

const item = (input: FeedInput, episode: Episode): string => {
  const recap = input.recaps.get(episode.guid);
  const title = recap ? `${episode.title} (with recap)` : episode.title;
  const enclosure = recap
    ? `<enclosure url="${escapeXml(audioUrl(input.baseUrl, input.feedToken, recap.jobId))}" length="${recap.fileSize}" type="audio/x-m4a"/>`
    : `<enclosure url="${escapeXml(episode.audioUrl)}" length="0" type="audio/mpeg"/>`;
  const lines = [
    `<title>${escapeXml(title)}</title>`,
    // Stable, and distinct from the original feed's guid so the two never collide.
    `<guid isPermaLink="false">${escapeXml(`podcast-recaps:${episode.guid}`)}</guid>`,
    `<pubDate>${episode.publishedAt.toUTCString()}</pubDate>`,
    enclosure,
    `<description>${cdata(showNotes(input, episode, recap))}</description>`,
    episode.durationSeconds && !recap ? `<itunes:duration>${episode.durationSeconds}</itunes:duration>` : "",
    episode.season === undefined ? "" : `<itunes:season>${episode.season}</itunes:season>`,
    episode.episodeNumber === undefined ? "" : `<itunes:episode>${episode.episodeNumber}</itunes:episode>`,
    episode.imageUrl ? `<itunes:image href="${escapeXml(episode.imageUrl)}"/>` : "",
    "<itunes:episodeType>full</itunes:episodeType>",
  ].filter(Boolean);
  return `    <item>\n      ${lines.join("\n      ")}\n    </item>`;
};

/** A private, unlisted copy of the show's feed, with prepared episodes swapped for their spliced versions. */
export const buildFeed = (input: FeedInput): string => {
  const { show } = input;
  const items = [...show.episodes].reverse().map((episode) => item(input, episode));
  const channel = [
    `<title>${escapeXml(`${show.title} (Recaps)`)}</title>`,
    `<link>${escapeXml(show.link ?? input.baseUrl)}</link>`,
    "<language>en-us</language>",
    `<description>${cdata(
      `A private, unofficial copy of ${show.title} with AI-generated recaps before prepared episodes. Not affiliated with the show. For personal listening only.`,
    )}</description>`,
    show.author ? `<itunes:author>${escapeXml(show.author)}</itunes:author>` : "",
    show.imageUrl ? `<itunes:image href="${escapeXml(show.imageUrl)}"/>` : "",
    // Keeps the copy out of Apple's directory and search.
    "<itunes:block>Yes</itunes:block>",
    "<itunes:type>serial</itunes:type>",
    "<itunes:explicit>false</itunes:explicit>",
  ].filter(Boolean);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    ${channel.join("\n    ")}
${items.join("\n")}
  </channel>
</rss>
`;
};

/** Whether the delivered byte ranges together cover the whole file. */
export const coversFile = (ranges: [number, number][], fileSize: number): boolean => {
  let covered = -1;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start > covered + 1) return false;
    covered = Math.max(covered, end);
    if (covered >= fileSize - 1) return true;
  }
  return fileSize === 0;
};

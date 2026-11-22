import { XMLParser } from "fast-xml-parser";

export interface Episode {
  /** Position in chronological order, starting at 0. */
  index: number;
  guid: string;
  title: string;
  /** Short identifier such as "1.5" or "1.5a", taken from the title when possible. */
  label: string;
  season?: number;
  episodeNumber?: number;
  publishedAt: Date;
  audioUrl: string;
  durationSeconds?: number;
  /** Show notes, as the publisher wrote them (often HTML). */
  description?: string;
  imageUrl?: string;
}

export interface Show {
  title: string;
  slug: string;
  episodes: Episode[];
  author?: string;
  description?: string;
  imageUrl?: string;
  link?: string;
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null;

const text = (value: unknown): string | undefined => {
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || undefined;
  if (isNode(value) && "#text" in value) return text(value["#text"]);
  return undefined;
};

const integer = (value: unknown): number | undefined => {
  const parsed = Number.parseInt(text(value) ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Parses "1591", "26:31", or "1:02:03" into seconds. */
export const parseDuration = (value: unknown): number | undefined => {
  const raw = text(value);
  if (!raw || !/^\d+(:\d{1,2}){0,2}$/.test(raw)) return undefined;
  return raw.split(":").reduce((total, part) => total * 60 + Number(part), 0);
};

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "show";

const titleLabel = (title: string): string | undefined =>
  /^(\d+(?:\.\d+)?[a-z]?)\s*[-–—:]/i.exec(title)?.[1]?.toLowerCase();

export const parseFeed = (xml: string): Show => {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "item",
  });
  const doc: unknown = parser.parse(xml);
  const channel = isNode(doc) && isNode(doc.rss) ? doc.rss.channel : undefined;
  if (!isNode(channel)) throw new Error("Not an RSS podcast feed: missing <rss><channel>.");

  const showTitle = text(channel.title) ?? "Podcast";
  const items = Array.isArray(channel.item) ? channel.item.filter(isNode) : [];

  const parsed = items.flatMap((item, feedPosition) => {
    const enclosure = item.enclosure;
    const audioUrl = isNode(enclosure) ? text(enclosure["@_url"]) : undefined;
    const title = text(item.title);
    const publishedAt = new Date(text(item.pubDate) ?? "");
    if (!audioUrl || !title || Number.isNaN(publishedAt.getTime())) return [];
    return [
      {
        feedPosition,
        guid: text(item.guid) ?? audioUrl,
        title,
        season: integer(item["itunes:season"]),
        episodeNumber: integer(item["itunes:episode"]),
        publishedAt,
        audioUrl,
        durationSeconds: parseDuration(item["itunes:duration"]),
        description: text(item["content:encoded"]) ?? text(item.description) ?? text(item["itunes:summary"]),
        imageUrl: imageOf(item),
      },
    ];
  });

  // Feeds are usually newest first, so equal timestamps fall back to reverse feed order.
  parsed.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || b.feedPosition - a.feedPosition);

  const seen = new Set<string>();
  const episodes = parsed.map(({ feedPosition: _feedPosition, ...episode }, index): Episode => {
    let label = titleLabel(episode.title) ?? `ep${index + 1}`;
    if (seen.has(label)) label = `${label}-${index + 1}`;
    seen.add(label);
    return { ...episode, index, label };
  });

  return {
    title: showTitle,
    slug: slugify(showTitle),
    episodes,
    author: text(channel["itunes:author"]),
    description: text(channel.description) ?? text(channel["itunes:summary"]),
    imageUrl: imageOf(channel),
    link: typeof channel.link === "string" ? text(channel.link) : undefined,
  };
};

/** Artwork from <itunes:image href> or <image><url>. */
const imageOf = (node: Node): string | undefined => {
  const itunes = node["itunes:image"];
  const href = isNode(itunes) ? text(itunes["@_href"]) : undefined;
  if (href) return href;
  const image = node.image;
  return isNode(image) ? text(image.url) : undefined;
};

/** Finds an episode by label ("1.5") or, failing that, a unique title match. */
export const findEpisode = (show: Show, query: string): Episode => {
  const wanted = query.trim().toLowerCase();
  const byLabel = show.episodes.find(({ label }) => label === wanted);
  if (byLabel) return byLabel;

  const matches = show.episodes.filter(({ title }) => title.toLowerCase().includes(wanted));
  if (matches.length === 1 && matches[0]) return matches[0];
  const options = (matches.length ? matches : show.episodes.slice(0, 10)).map(({ label, title }) => `  ${label}: ${title}`);
  throw new Error(
    `${matches.length ? "Several episodes match" : "No episode matches"} "${query}". Try one of:\n${options.join("\n")}`,
  );
};

export interface ContextOptions {
  /** Skip short items such as trailers and announcements. */
  minSeconds?: number;
}

/**
 * Earlier episodes a recap may draw from. Never includes the target or anything after it.
 * When the feed uses seasons, context stays within the target's season.
 */
export const contextEpisodes = (show: Show, target: Episode, { minSeconds = 300 }: ContextOptions = {}): Episode[] =>
  show.episodes.filter(
    (episode) =>
      episode.index < target.index &&
      (target.season === undefined || episode.season === target.season) &&
      (episode.durationSeconds === undefined || episode.durationSeconds >= minSeconds),
  );

/** "1.5- Cavaliers and Roundheads" becomes "Cavaliers and Roundheads". */
export const episodeName = (episode: Episode): string => {
  const stripped = episode.title.replace(/^\s*\d+(?:\.\d+)?[a-z]?\s*[-–—:]\s*/i, "").trim();
  return stripped || episode.title;
};

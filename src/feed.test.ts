import assert from "node:assert/strict";
import { test } from "node:test";
import { contextEpisodes, episodeName, findEpisode, parseDuration, parseFeed } from "./feed.js";

const item = (title: string, date: string, extra = "") => `
  <item>
    <title><![CDATA[${title}]]></title>
    <guid isPermaLink="false">${title}</guid>
    <pubDate>${date}</pubDate>
    <enclosure url="https://example.com/${encodeURIComponent(title)}.mp3?a=1&amp;b=2" length="1" type="audio/mpeg"/>
    ${extra}
  </item>`;

// Newest first, like real feeds, with two items sharing a timestamp.
const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
  <title>Revolutions!</title>
  ${item("2.1- Next Season", "Mon, 06 Jan 2014 00:00:00 +0000", "<itunes:season>2</itunes:season><itunes:duration>25:00</itunes:duration>")}
  ${item("1.5- Cavaliers and Roundheads", "Sun, 13 Oct 2013 21:30:00 +0000", "<itunes:season>1</itunes:season><itunes:duration>26:31</itunes:duration>")}
  ${item("1.5a- Supplemental- The Armies", "Sun, 13 Oct 2013 19:00:00 +0000", "<itunes:season>1</itunes:season><itunes:duration>12:51</itunes:duration>")}
  ${item("1.4a- Tour Announcement", "Mon, 07 Oct 2013 00:40:00 +0000", "<itunes:season>1</itunes:season><itunes:duration>2:00</itunes:duration>")}
  ${item("1.4- The Long Parliament", "Mon, 07 Oct 2013 00:33:56 +0000", "<itunes:season>1</itunes:season><itunes:duration>1555</itunes:duration>")}
  ${item("1.6- Same Time A", "Mon, 21 Oct 2013 00:00:00 +0000", "<itunes:season>1</itunes:season>")}
  ${item("1.6b- Same Time B", "Mon, 21 Oct 2013 00:00:00 +0000", "<itunes:season>1</itunes:season>")}
</channel></rss>`;

test("parses and orders episodes chronologically", () => {
  const show = parseFeed(xml);
  assert.equal(show.slug, "revolutions");
  assert.deepEqual(
    show.episodes.map(({ label }) => label),
    ["1.4", "1.4a", "1.5a", "1.5", "1.6b", "1.6", "2.1"],
  );
  assert.equal(show.episodes[0]?.audioUrl, "https://example.com/1.4-%20The%20Long%20Parliament.mp3?a=1&b=2");
  assert.equal(show.episodes[3]?.durationSeconds, 1591);
});

test("context includes only earlier, same-season, full-length episodes", () => {
  const show = parseFeed(xml);
  const target = findEpisode(show, "1.5");
  assert.deepEqual(
    contextEpisodes(show, target).map(({ label }) => label),
    ["1.4", "1.5a"],
  );
  assert.deepEqual(contextEpisodes(show, findEpisode(show, "2.1")), []);
});

test("finds episodes by label or unique title, and rejects ambiguity", () => {
  const show = parseFeed(xml);
  assert.equal(findEpisode(show, "1.5A").title, "1.5a- Supplemental- The Armies");
  assert.equal(findEpisode(show, "roundheads").label, "1.5");
  assert.throws(() => findEpisode(show, "Same Time"), /Several episodes match/);
  assert.throws(() => findEpisode(show, "missing"), /No episode matches/);
});

test("parses durations and episode names", () => {
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("bad"), undefined);
  assert.equal(episodeName(parseFeed(xml).episodes[3]!), "Cavaliers and Roundheads");
});

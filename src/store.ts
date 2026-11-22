import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Episode, Show } from "./feed.js";
import type { UsageRecord } from "./llm.js";
import type { RecapSettings } from "./pipeline.js";

/** Bump and add a step to MIGRATIONS when the schema changes. */
const MIGRATIONS = [
  `create table shows (
     id integer primary key,
     feed_url text not null unique,
     title text not null,
     slug text not null unique,
     added_at text not null,
     refreshed_at text not null
   );
   create table episodes (
     id integer primary key,
     show_id integer not null references shows(id) on delete cascade,
     guid text not null,
     idx integer not null,
     label text not null,
     title text not null,
     season integer,
     episode_number integer,
     published_at text not null,
     audio_url text not null,
     duration_seconds integer,
     unique (show_id, guid)
   );
   create table jobs (
     id integer primary key,
     batch_id text not null,
     show_id integer not null references shows(id) on delete cascade,
     episode_guid text not null,
     episode_idx integer not null,
     settings text not null,
     status text not null,
     estimated_cost_usd real not null,
     cost_usd real not null default 0,
     progress text,
     error text,
     text_path text,
     audio_path text,
     sources_path text,
     created_at text not null,
     started_at text,
     finished_at text
   );
   create index jobs_queue on jobs (status, created_at, episode_idx);
   create table usage (
     id integer primary key,
     job_id integer references jobs(id) on delete set null,
     at text not null,
     step text not null,
     model text not null,
     input_tokens integer not null,
     output_tokens integer not null,
     web_searches integer not null,
     cost_usd real not null
   );
   create index usage_at on usage (at);
   create table settings (key text primary key, value text not null);`,
  // Publishing: show metadata for the cloned feed, a private token per feed, per-show default
  // settings for Prepare next, and byte ranges delivered to the phone.
  `alter table shows add column author text;
   alter table shows add column description text;
   alter table shows add column image_url text;
   alter table shows add column link text;
   alter table shows add column feed_token text;
   alter table shows add column default_settings text;
   update shows set feed_token = lower(hex(randomblob(32)));
   create unique index shows_feed_token on shows (feed_token);
   alter table episodes add column description text;
   alter table episodes add column image_url text;
   create table deliveries (
     id integer primary key,
     job_id integer not null references jobs(id) on delete cascade,
     at text not null,
     start_byte integer not null,
     end_byte integer not null,
     file_size integer not null
   );
   create index deliveries_job on deliveries (job_id);`,
];

/** A long random token, so feed and audio URLs can't be guessed. */
const newToken = (): string => randomBytes(32).toString("base64url");

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "waiting_for_budget";

export const ACTIVE_STATUSES: JobStatus[] = ["queued", "running", "waiting_for_budget"];

export interface ShowRow {
  id: number;
  feedUrl: string;
  title: string;
  slug: string;
  addedAt: string;
  refreshedAt: string;
  /** Secret part of the private feed URL. Never shown in logs. */
  feedToken: string;
}

export interface JobRow {
  id: number;
  batchId: string;
  showId: number;
  episodeGuid: string;
  episodeIdx: number;
  settings: RecapSettings;
  status: JobStatus;
  estimatedCostUsd: number;
  costUsd: number;
  progress: string | null;
  error: string | null;
  textPath: string | null;
  audioPath: string | null;
  sourcesPath: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

type Row = Record<string, SQLInputValue>;

const toShow = (row: Row): ShowRow => ({
  id: Number(row.id),
  feedUrl: String(row.feed_url),
  title: String(row.title),
  slug: String(row.slug),
  addedAt: String(row.added_at),
  refreshedAt: String(row.refreshed_at),
  feedToken: String(row.feed_token),
});

const optionalNumber = (value: SQLInputValue | undefined): number | undefined => (value == null ? undefined : Number(value));
const optionalText = (value: SQLInputValue | undefined): string | null => (value == null ? null : String(value));

const toEpisode = (row: Row): Episode => ({
  index: Number(row.idx),
  guid: String(row.guid),
  title: String(row.title),
  label: String(row.label),
  season: optionalNumber(row.season),
  episodeNumber: optionalNumber(row.episode_number),
  publishedAt: new Date(String(row.published_at)),
  audioUrl: String(row.audio_url),
  durationSeconds: optionalNumber(row.duration_seconds),
  description: optionalText(row.description) ?? undefined,
  imageUrl: optionalText(row.image_url) ?? undefined,
});

const toJob = (row: Row): JobRow => ({
  id: Number(row.id),
  batchId: String(row.batch_id),
  showId: Number(row.show_id),
  episodeGuid: String(row.episode_guid),
  episodeIdx: Number(row.episode_idx),
  settings: JSON.parse(String(row.settings)) as RecapSettings,
  status: String(row.status) as JobStatus,
  estimatedCostUsd: Number(row.estimated_cost_usd),
  costUsd: Number(row.cost_usd),
  progress: optionalText(row.progress),
  error: optionalText(row.error),
  textPath: optionalText(row.text_path),
  audioPath: optionalText(row.audio_path),
  sourcesPath: optionalText(row.sources_path),
  createdAt: String(row.created_at),
  startedAt: optionalText(row.started_at),
  finishedAt: optionalText(row.finished_at),
});

/** First moment of the current calendar month, in UTC. */
export const monthStart = (now: Date): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = Number((this.db.prepare("pragma user_version").get() as Row).user_version);
    for (let next = version; next < MIGRATIONS.length; next++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[next] ?? "");
        this.db.exec(`pragma user_version = ${next + 1}`);
      });
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("begin");
    try {
      const result = work();
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  // Shows and episodes

  /** Adds a show, or refreshes its title and episodes if the feed is already saved. */
  saveShow(feedUrl: string, show: Show, now = new Date()): ShowRow {
    return this.transaction(() => {
      const at = now.toISOString();
      const existing = this.db.prepare("select * from shows where feed_url = ?").get(feedUrl) as Row | undefined;
      let id: number;
      const metadata = [show.title, show.author ?? null, show.description ?? null, show.imageUrl ?? null, show.link ?? null];
      if (existing) {
        id = Number(existing.id);
        this.db
          .prepare(
            "update shows set title = ?, author = ?, description = ?, image_url = ?, link = ?, refreshed_at = ? where id = ?",
          )
          .run(...metadata, at, id);
      } else {
        const slug = this.uniqueSlug(show.slug);
        const result = this.db
          .prepare(
            `insert into shows (feed_url, title, author, description, image_url, link, slug, added_at, refreshed_at, feed_token)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(feedUrl, ...metadata, slug, at, at, newToken());
        id = Number(result.lastInsertRowid);
      }
      const upsert = this.db.prepare(
        `insert into episodes (show_id, guid, idx, label, title, season, episode_number, published_at, audio_url,
                               duration_seconds, description, image_url)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (show_id, guid) do update set
           idx = excluded.idx, label = excluded.label, title = excluded.title, season = excluded.season,
           episode_number = excluded.episode_number, published_at = excluded.published_at,
           audio_url = excluded.audio_url, duration_seconds = excluded.duration_seconds,
           description = excluded.description, image_url = excluded.image_url`,
      );
      for (const episode of show.episodes) {
        upsert.run(
          id,
          episode.guid,
          episode.index,
          episode.label,
          episode.title,
          episode.season ?? null,
          episode.episodeNumber ?? null,
          episode.publishedAt.toISOString(),
          episode.audioUrl,
          episode.durationSeconds ?? null,
          episode.description ?? null,
          episode.imageUrl ?? null,
        );
      }
      return this.getShow(id) as ShowRow;
    });
  }

  private uniqueSlug(slug: string): string {
    const taken = (candidate: string) => this.db.prepare("select 1 from shows where slug = ?").get(candidate);
    let candidate = slug;
    for (let n = 2; taken(candidate); n++) candidate = `${slug}-${n}`;
    return candidate;
  }

  getShow(id: number): ShowRow | undefined {
    const row = this.db.prepare("select * from shows where id = ?").get(id) as Row | undefined;
    return row ? toShow(row) : undefined;
  }

  listShows(): ShowRow[] {
    return (this.db.prepare("select * from shows order by title").all() as Row[]).map(toShow);
  }

  deleteShow(id: number): void {
    this.db.prepare("delete from shows where id = ?").run(id);
  }

  /** The show with its episodes in chronological order, ready for the pipeline. */
  loadShow(id: number): Show | undefined {
    const row = this.db.prepare("select * from shows where id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const episodes = (this.db.prepare("select * from episodes where show_id = ? order by idx").all(id) as Row[]).map(
      toEpisode,
    );
    return {
      title: String(row.title),
      slug: String(row.slug),
      episodes,
      author: optionalText(row.author) ?? undefined,
      description: optionalText(row.description) ?? undefined,
      imageUrl: optionalText(row.image_url) ?? undefined,
      link: optionalText(row.link) ?? undefined,
    };
  }

  /** Looks up a show by its private feed token, comparing in constant time. */
  showByFeedToken(token: string): ShowRow | undefined {
    const wanted = Buffer.from(token);
    return this.listShows().find(({ feedToken }) => {
      const actual = Buffer.from(feedToken);
      return actual.length === wanted.length && timingSafeEqual(actual, wanted);
    });
  }

  /** Issues a new feed token, which stops the old feed URL from working. */
  rotateFeedToken(showId: number): ShowRow | undefined {
    this.db.prepare("update shows set feed_token = ? where id = ?").run(newToken(), showId);
    return this.getShow(showId);
  }

  /** Settings that Prepare next uses for this show. */
  getShowDefaults(showId: number): unknown {
    const row = this.db.prepare("select default_settings from shows where id = ?").get(showId) as Row | undefined;
    return row?.default_settings == null ? undefined : JSON.parse(String(row.default_settings));
  }

  setShowDefaults(showId: number, settings: RecapSettings): void {
    this.db.prepare("update shows set default_settings = ? where id = ?").run(JSON.stringify(settings), showId);
  }

  /** The newest finished recap with audio for each episode, keyed by episode guid. */
  publishedRecaps(showId: number): Map<string, JobRow> {
    const rows = this.db
      .prepare(
        "select * from jobs where show_id = ? and status = 'done' and audio_path is not null order by finished_at, id",
      )
      .all(showId) as Row[];
    // Later rows overwrite earlier ones, so each episode keeps its newest recap.
    return new Map(rows.map((row) => [String(row.episode_guid), toJob(row)]));
  }

  // Deliveries

  recordDelivery(jobId: number, startByte: number, endByte: number, fileSize: number, now = new Date()): void {
    this.db
      .prepare("insert into deliveries (job_id, at, start_byte, end_byte, file_size) values (?, ?, ?, ?, ?)")
      .run(jobId, now.toISOString(), startByte, endByte, fileSize);
  }

  /** Byte ranges fully sent for a job, as inclusive [start, end] pairs. */
  deliveredRanges(jobId: number): { ranges: [number, number][]; fileSize: number | undefined } {
    const rows = this.db
      .prepare("select start_byte, end_byte, file_size from deliveries where job_id = ? order by id")
      .all(jobId) as Row[];
    return {
      ranges: rows.map((row) => [Number(row.start_byte), Number(row.end_byte)]),
      fileSize: rows.length ? Number(rows.at(-1)?.file_size) : undefined,
    };
  }

  // Jobs

  /**
   * Queues one job per episode. An episode that already has an active job with the same
   * settings keeps that job, so repeated "Prepare" requests never pay twice.
   */
  enqueue(showId: number, episodes: { episode: Episode; estimatedCostUsd: number }[], settings: RecapSettings, now = new Date()): JobRow[] {
    return this.transaction(() => {
      const batchId = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const serialized = JSON.stringify(settings);
      const active = this.db.prepare(
        `select * from jobs where show_id = ? and episode_guid = ? and settings = ? and status in (${ACTIVE_STATUSES.map(() => "?").join(", ")})`,
      );
      const insert = this.db.prepare(
        `insert into jobs (batch_id, show_id, episode_guid, episode_idx, settings, status, estimated_cost_usd, created_at)
         values (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      );
      return [...episodes]
        .sort((a, b) => a.episode.index - b.episode.index)
        .map(({ episode, estimatedCostUsd }) => {
          const existing = active.get(showId, episode.guid, serialized, ...ACTIVE_STATUSES) as Row | undefined;
          if (existing) return toJob(existing);
          const result = insert.run(batchId, showId, episode.guid, episode.index, serialized, estimatedCostUsd, now.toISOString());
          return this.getJob(Number(result.lastInsertRowid)) as JobRow;
        });
    });
  }

  getJob(id: number): JobRow | undefined {
    const row = this.db.prepare("select * from jobs where id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : undefined;
  }

  listJobs(filter: { showId?: number; statuses?: JobStatus[] } = {}): JobRow[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.showId !== undefined) {
      clauses.push("show_id = ?");
      params.push(filter.showId);
    }
    if (filter.statuses?.length) {
      clauses.push(`status in (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    return (this.db.prepare(`select * from jobs ${where} order by id desc`).all(...params) as Row[]).map(toJob);
  }

  /** Oldest batch first, and within a batch, earliest episode first, so each recap can use earlier summaries. */
  nextQueuedJob(): JobRow | undefined {
    const row = this.db
      .prepare("select * from jobs where status = 'queued' order by created_at, episode_idx, id limit 1")
      .get() as Row | undefined;
    return row ? toJob(row) : undefined;
  }

  updateJob(id: number, changes: Partial<Omit<JobRow, "id" | "settings">>): void {
    const columns: Record<string, string> = {
      status: "status",
      progress: "progress",
      error: "error",
      costUsd: "cost_usd",
      textPath: "text_path",
      audioPath: "audio_path",
      sourcesPath: "sources_path",
      startedAt: "started_at",
      finishedAt: "finished_at",
    };
    const entries = Object.entries(changes).filter(([key]) => key in columns);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${columns[key]} = ?`).join(", ");
    const values = entries.map(([, value]) => (value === undefined ? null : (value as SQLInputValue)));
    this.db.prepare(`update jobs set ${assignments} where id = ?`).run(...values, id);
  }

  /** After a crash or restart, interrupted jobs go back in the queue. */
  requeueInterrupted(): number {
    const result = this.db
      .prepare("update jobs set status = 'queued', progress = 'Resuming after a restart' where status = 'running'")
      .run();
    return Number(result.changes);
  }

  /** Jobs held back by the spending cap go back in the queue, for example after the cap is raised. */
  releaseBudgetHolds(): number {
    return Number(this.db.prepare("update jobs set status = 'queued' where status = 'waiting_for_budget'").run().changes);
  }

  cancelJobs(filter: { id?: number; batchId?: string; showId?: number }): number {
    const clauses = ["status in ('queued', 'waiting_for_budget')"];
    const params: SQLInputValue[] = [];
    if (filter.id !== undefined) {
      clauses.push("id = ?");
      params.push(filter.id);
    }
    if (filter.batchId !== undefined) {
      clauses.push("batch_id = ?");
      params.push(filter.batchId);
    }
    if (filter.showId !== undefined) {
      clauses.push("show_id = ?");
      params.push(filter.showId);
    }
    const sql = `update jobs set status = 'cancelled', finished_at = ? where ${clauses.join(" and ")}`;
    return Number(this.db.prepare(sql).run(new Date().toISOString(), ...params).changes);
  }

  // Spending

  recordUsage(jobId: number | null, record: UsageRecord): void {
    this.db
      .prepare(
        `insert into usage (job_id, at, step, model, input_tokens, output_tokens, web_searches, cost_usd)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, record.at, record.step, record.model, record.inputTokens, record.outputTokens, record.webSearches, record.estimatedCostUsd);
    if (jobId !== null) {
      this.db.prepare("update jobs set cost_usd = cost_usd + ? where id = ?").run(record.estimatedCostUsd, jobId);
    }
  }

  spentSince(since: string): number {
    const row = this.db.prepare("select coalesce(sum(cost_usd), 0) as total from usage where at >= ?").get(since) as Row;
    return Number(row.total);
  }

  // Settings

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("select value from settings where key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) this.db.prepare("delete from settings where key = ?").run(key);
    else this.db.prepare("insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);
  }
}

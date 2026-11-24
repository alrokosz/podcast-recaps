import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { findEpisode } from "./feed.js";
import { deleteApiKey, findApiKey, saveApiKey } from "./keychain.js";
import { Llm } from "./llm.js";
import { MODES, TONES } from "./modes.js";
import { fetchShow, prepareRecap, showDir } from "./pipeline.js";
import { createPublicServer, PUBLIC_BASE_URL_KEY } from "./public.js";
import { createApi } from "./server.js";
import { detectTailscaleUrl, funnelCommand } from "./tailscale.js";
import { describeError, resolveSettings } from "./settings.js";
import { Store } from "./store.js";
import { Worker } from "./worker.js";

const DEFAULT_PORT = 8786;
/** Fixed, so the one-time Tailscale Funnel command never needs to change. */
const FEED_PORT = 8787;

/** Where shows, the database, and cached files live. */
const dataDir = (): string => resolve(process.env.RECAPS_HOME ?? join(homedir(), ".podcast-recaps"));

const USAGE = `Usage:
  recaps make --feed <rss-url> --episode <label-or-title> [options]   Prepare one episode now
  recaps make --feed <rss-url> --list                                  List a feed's episodes
  recaps serve [--port ${DEFAULT_PORT}]                                       Run the local service
  recaps key set | status | delete                                     Manage the Anthropic API key

Options for make:
  --mode <name>          ${Object.keys(MODES).join(", ")} (default: previously-on)
  --tone <name>          ${Object.keys(TONES).join(", ")} (default: the mode's own tone)
  --instructions <text>  Listener preferences, such as "focus on the key people"
  --model <id>           claude-opus-5-5 (default) or claude-haiku-5-5
  --effort <level>       low (default), medium, or high
  --voice <name>         macOS voice for narration (see: say -v '?')
  --rate <wpm>           Narration speed in words per minute (default: the voice's own, about 175)
  --pause <seconds>      Silence between the recap and the episode (default: 1.2)
  --script-only          Stop after writing and checking the recap text
  --regenerate           Write a new recap even if a passing one is saved

Data is stored in ${dataDir()} (set RECAPS_HOME to change it).`;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const numberOption = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));

const make = async (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      feed: { type: "string" },
      episode: { type: "string" },
      mode: { type: "string" },
      tone: { type: "string" },
      instructions: { type: "string" },
      model: { type: "string", default: process.env.RECAPS_MODEL },
      effort: { type: "string" },
      voice: { type: "string" },
      rate: { type: "string" },
      pause: { type: "string" },
      "script-only": { type: "boolean", default: false },
      regenerate: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
  });
  if (!values.feed) return fail(USAGE);

  // Check settings before fetching anything, so typos fail fast.
  let settings;
  try {
    settings = resolveSettings({
      mode: values.mode,
      tone: values.tone,
      instructions: values.instructions,
      model: values.model,
      effort: values.effort,
      voice: values.voice,
      wordsPerMinute: numberOption(values.rate),
      pauseSeconds: numberOption(values.pause),
    });
  } catch (error) {
    return fail(describeError(error));
  }

  const { show, xml } = await fetchShow(values.feed);
  if (values.list) {
    for (const episode of show.episodes) console.log(`${episode.label.padEnd(8)} ${episode.title}`);
    return;
  }
  if (!values.episode) return fail(USAGE);
  const apiKey = await findApiKey();
  if (!apiKey) return fail("No Anthropic API key found. Run: recaps key set");

  const workDir = showDir(dataDir(), show.slug);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "feed.xml"), xml);
  const llm = new Llm(settings.model, settings.effort, { apiKey: apiKey.key, usageLogPath: join(workDir, "usage.jsonl") });
  const result = await prepareRecap({
    llm,
    show,
    target: findEpisode(show, values.episode),
    workDir,
    settings,
    regenerate: values.regenerate,
    scriptOnly: values["script-only"],
    log: (message) => console.log(`• ${message}`),
  });
  console.log(`\n${result.spoken}\n`);
  if (result.audioPath) console.log(`Saved: ${result.audioPath}`);
  console.log(`Estimated Claude cost this run: $${llm.totalCost.toFixed(3)}`);
};

const serve = async (args: string[]) => {
  const { values } = parseArgs({ args, options: { port: { type: "string", default: String(DEFAULT_PORT) } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return fail("--port must be from 1024 to 65535.");

  const feedPort = FEED_PORT;
  const store = new Store(join(dataDir(), "recaps.db"));
  const getApiKey = async () => (await findApiKey())?.key;
  const hasApiKey = async () => Boolean(await getApiKey());
  const worker = new Worker(store, { dataDir: dataDir(), getApiKey });
  const api = createApi({ store, worker, dataDir: dataDir(), hasApiKey, feedServerPort: feedPort });
  const feeds = createPublicServer({ store, worker, dataDir: dataDir(), hasApiKey });

  if (!store.getSetting(PUBLIC_BASE_URL_KEY)) {
    const detected = await detectTailscaleUrl();
    if (detected) store.setSetting(PUBLIC_BASE_URL_KEY, detected);
  }

  // Both bind to loopback. Tailscale Funnel forwards only to the feed server, so the local API
  // is never reachable from the internet.
  api.listen(port, "127.0.0.1", () => {
    console.log(`Podcast Recaps is running. Open http://127.0.0.1:${port} in your browser. (Data: ${dataDir()})`);
    worker.start();
  });
  feeds.listen(feedPort, "127.0.0.1", () => {
    const base = store.getSetting(PUBLIC_BASE_URL_KEY);
    console.log(`Feed server on http://127.0.0.1:${feedPort}, published as ${base ?? "(no public URL set yet)"}`);
    console.log(`To make feeds reachable from your phone, run once: ${funnelCommand(feedPort)}`);
  });
  const shutdown = () => {
    console.log("Stopping. Any running job resumes next time.");
    api.close();
    feeds.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

/** Reads a line without echoing it when typed at a terminal, or all of stdin when piped. */
const readSecret = async (prompt: string): Promise<string> => {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    let input = "";
    for await (const chunk of stdin) input += String(chunk);
    return input.trim();
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolveSecret, reject) => {
    let secret = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolveSecret(secret.trim());
          return;
        }
        secret = char === "\u007f" ? secret.slice(0, -1) : secret + char;
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    stdin.on("data", onData);
  });
};

const key = async ([action]: string[]) => {
  if (action === "set") {
    await saveApiKey(await readSecret("Paste your Anthropic API key (input is hidden): "));
    return console.log("Saved to the macOS Keychain.");
  }
  if (action === "delete") {
    await deleteApiKey();
    return console.log("Removed from the macOS Keychain.");
  }
  if (action === "status" || action === undefined) {
    const found = await findApiKey();
    if (!found) return console.log("No API key found. Run: recaps key set");
    return console.log(
      found.source === "keychain"
        ? "Using the key saved in the macOS Keychain."
        : "Using ANTHROPIC_API_KEY from the environment (for example .env.local).",
    );
  }
  fail(USAGE);
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "serve") return serve(rest);
  if (command === "key") return key(rest);
  if (command === "make") return make(rest);
  if (command === "help" || command === "--help" || command === "-h") return console.log(USAGE);
  // Without a command, behave like `make`, as earlier versions did.
  return make(process.argv.slice(2));
};

main().catch((error: unknown) => fail(describeError(error)));

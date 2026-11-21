import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const SERVICE = "podcast-recaps";
const ACCOUNT = "anthropic-api-key";

/** Anthropic keys are URL-safe tokens, which also keeps them safe to send to `security -i`. */
export const looksLikeApiKey = (key: string): boolean => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);

/** Sends commands on stdin, so the key never appears in the process list. */
const securityInteractive = (command: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(stderr.trim() || `security exited ${code}`))));
    child.stdin.end(`${command}\n`);
  });

export const saveApiKey = async (key: string): Promise<void> => {
  if (!looksLikeApiKey(key)) throw new Error("That doesn't look like an Anthropic API key (it should start with sk-ant-).");
  await securityInteractive(`add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${key}`);
};

export const readKeychainApiKey = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};

export const deleteApiKey = async (): Promise<void> => {
  try {
    await run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
  } catch {
    // Already absent.
  }
};

export type KeySource = "keychain" | "environment";

/** Prefers Keychain. Falls back to ANTHROPIC_API_KEY, which development loads from .env.local. */
export const findApiKey = async (): Promise<{ key: string; source: KeySource } | undefined> => {
  const stored = await readKeychainApiKey();
  if (stored) return { key: stored, source: "keychain" };
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  return env ? { key: env, source: "environment" } : undefined;
};

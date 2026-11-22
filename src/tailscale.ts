import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The CLI is on PATH with Homebrew, and inside the app bundle with the standalone app. */
const CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** This Mac's Tailscale HTTPS address, such as https://my-mac.tail1234.ts.net, if Tailscale is running. */
export const detectTailscaleUrl = async (): Promise<string | undefined> => {
  for (const command of CANDIDATES) {
    if (command.startsWith("/") && !existsSync(command)) continue;
    try {
      const { stdout } = await run(command, ["status", "--json"], { timeout: 5000 });
      const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
      if (name) return `https://${name}`;
    } catch {
      // Try the next location.
    }
  }
  return undefined;
};

/** The command a user runs once to publish the feed server through Tailscale Funnel. */
export const funnelCommand = (port: number): string => `tailscale funnel --bg --https=443 http://127.0.0.1:${port}`;

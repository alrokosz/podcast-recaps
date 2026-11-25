---
name: setup
description: Install and start the Podcast Recaps service on this Mac, and check transcription and the Tailscale public link.
disable-model-invocation: true
---

# Set up Podcast Recaps

The plugin talks to a small service on this Mac. The service does transcription, narration, splicing, and serves the private feed. Walk the user through setup, checking each step before moving on. Explain what each command does before running it, and let the user approve it.

1. **Already running?** Call the recaps `status` tool. If it works, skip to step 5.
2. **Requirements:** macOS, and Node.js 22 or later (`node --version`). If Node is missing or old, tell the user how to install it (for example from nodejs.org) and stop.
3. **Install.** Ask where to put it (default `~/podcast-recaps`). If it's not already there, run `git clone https://github.com/alrokosz/podcast-recaps.git <dir>`, then `npm install` in it. Then build transcription following the README's "Transcription (one time)" section. It needs `cmake` and takes a few minutes. The model download is about 190 MB.
4. **Start the service.** Recommend the user run `npm start` in `<dir>` in a separate Terminal window and keep it open, so it outlives this session. Then call `status` again to confirm. The web UI is at http://127.0.0.1:8786.
5. **Public link for iPhone.** Look at the status result and the web UI. If the public link is off, explain that the iPhone reaches the feed through Tailscale Funnel. The user installs Tailscale and signs in, then runs the Funnel command shown in the web UI's setup panel. Don't run `tailscale` commands yourself unless the user asks you to. Turning on a public link is their decision.
6. **No API key is needed** for the plugin. Recaps are written by this Claude Code session through `/recaps:prepare`. An API key, saved in the web UI, is optional and only needed for unattended Prepare next from the iPhone.
7. Finish with the next steps: `/recaps:add <show>`, then `/recaps:prepare <show> <first>-<last>`.

---
name: add
description: Add a podcast to Podcast Recaps by name or RSS feed URL and get its private feed URL for Apple Podcasts.
argument-hint: "[show name or RSS feed URL]"
disable-model-invocation: true
---

# Add a podcast

The user typed: `$ARGUMENTS`

1. If it's an http(s) URL, call the recaps `add_show` tool with it. Otherwise call `search_podcasts` with the name. Show up to 5 matches (title, author, episode count) and ask the user which one with AskUserQuestion, then call `add_show` with its feed URL. With no arguments, ask what show to add.
2. Adding a show is free. It only reads the public feed.
3. Tell the user:
   - The private feed URL, and that it must stay private.
   - How to follow it on iPhone: scan the QR code in the web UI (the `qrCodeAndSettings` address), or copy the URL, then in Apple Podcasts go to Library, ⋯, Follow a Show by URL.
   - That the phone needs the public link (Tailscale Funnel) on. `/recaps:setup` checks this.
   - The next step: `/recaps:prepare <show> <first>-<last>`.

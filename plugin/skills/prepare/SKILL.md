---
name: prepare
description: Write spoiler-safe recaps for a range of podcast episodes with this Claude Code session, or finish recaps already waiting (such as ones queued from the iPhone with Prepare next).
argument-hint: "[show] [first episode]-[last episode] [mode]"
disable-model-invocation: true
---

# Prepare podcast recaps with Claude Code

The user typed: `$ARGUMENTS`

You coordinate. Fresh subagents do the writing, one work packet each, so you never read transcripts or packets yourself. This keeps your context small even for a whole season.

## 1. Check the service

Call the recaps `status` tool. If the service isn't running, tell the user to run `/recaps:setup` (or to start the service if it's installed), then stop.

## 2. Queue new recaps (only if the user asked for some)

If the arguments name a show and episodes:

1. Find the show among `status` shows by name. If it isn't there, suggest `/recaps:add <show>` and stop. If the episode labels are unclear, use `list_episodes` with a query.
2. Call `estimate` with the show, `from`, `to`, and a mode only if the user named one (`previously-on`, `recap`, or `further-context`). Otherwise the show's saved settings apply.
3. Tell the user what it will do: how many recaps, how many earlier episodes need a first-time summary, that there's no API cost but it uses their Claude plan, and that it runs in episode order and takes a few minutes per episode. The first episode of a season is skipped because nothing comes before it.
4. Ask the user to confirm with AskUserQuestion. Never queue without a yes. Writing a whole season can use a lot of plan usage.
5. On yes, call `queue_recaps` with the same arguments.

With no arguments, skip to step 3 and finish whatever is waiting. If nothing is waiting, explain how to use the command, for example `/recaps:prepare Revolutions 1.7-1.12`, and stop.

## 3. Work through the packets

Repeat until done:

1. Call `next_packet` (default wait).
2. If it returns a packet, run the subagent it names, using the Agent tool:
   - `recap-checker` for spoiler checks (`independentReview: true`). This must be a separate agent from the writer.
   - `recap-writer` for everything else.
   Give it only: `Complete the Podcast Recaps work packet in <file>. Packet id: <id>.` Then wait for its one-line reply.
3. After each reply, print one short progress line, such as `✓ 1.7: summarized 1.6` or `✓ 1.7: spoiler check passed`.
4. If it returns `packet: null` and Claude Code jobs are still active, the service is downloading or transcribing. Call `next_packet` again. Mention progress at most once per few calls.
5. If it returns `packet: null` and no jobs are active, you're done.

Stopping early: if a subagent fails twice on the same packet, or you hit a usage limit, call `release_packet` for any packet you claimed and haven't submitted. Tell the user they can run `/recaps:prepare` again later to pick up where it stopped. Never submit output you wrote yourself in place of a subagent.

## 4. Finish

Call `status` once more and summarize in a few lines: which episodes are ready, and anything that failed with its reason. Remind the user to download the episodes in Apple Podcasts before closing their Mac. Downloaded episodes play without it.

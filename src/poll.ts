// The polling tick, shared by both schedulers.
//
// It is called from two places: the Cron Trigger in index.ts, and the Ticker Durable Object's
// alarm (ticker.ts). Having both armed is deliberate and safe — claimPollSlot is an atomic claim
// on a shared interval, so whichever fires first takes the tick and the other is refused. That is
// what lets us add a second scheduler without any risk of double-sending a DM.

import { claimPollSlot } from "./db";
import { buildRuntime } from "./runtime";
import { pollComments } from "./poller/commentPoll";
import { pollMessages } from "./poller/messagePoll";
import type { Env } from "./types";

/**
 * Run comment + message polls, honoring the caller's poll interval (>= cron granularity).
 * claimPollSlot is an atomic claim, not a plain check-then-act read/write — see its doc comment
 * in db.ts for why that distinction matters: it's what stops an overlapping cron tick or a
 * /admin/poll call racing the cron from both polling at once and double-sending a real DM.
 */
export async function runPoll(env: Env, interval: number): Promise<void> {
  const claimed = await claimPollSlot(env.DB, interval);
  if (!claimed) return; // not due yet, or another invocation already claimed this slot

  const rt = await buildRuntime(env);
  if (!rt) return;

  // Isolated so one poll can never starve the other. pollComments used to run first with no
  // guard, which meant a throw there silently skipped the message poll for that whole tick.
  try {
    await pollComments(rt, env.DB);
  } catch (e) {
    console.warn(`[chatmany] pollComments failed: ${e instanceof Error ? e.message : e}`);
  }
  try {
    await pollMessages(rt, env.DB);
  } catch (e) {
    console.warn(`[chatmany] pollMessages failed: ${e instanceof Error ? e.message : e}`);
  }
}

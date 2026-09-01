// A self-rescheduling clock, standing in for the Cron Trigger.
//
// WHY THIS EXISTS
// Cloudflare accepted our two Cron Triggers, lists them under GET /schedules, and reports them on
// every deploy — and then never invokes scheduled(). No error, no failed invocation, nothing in
// the tail: the handler is simply never called. That was confirmed here on 2026-09-01 by watching
// kv.last_poll_ts sit unchanged for 200s (three ticks' worth) while a manual run of the very same
// handler polled, matched a comment and delivered a DM in 22s. It is a known platform-side fault
// with a long tail of identical reports, and it cannot be cleared from our side: redeploying,
// re-registering the triggers, and renaming the Worker all leave it stuck.
//
// Durable Object alarms are a different subsystem from the cron scheduler, so this keeps the whole
// thing inside Cloudflare with no external pinger, no third party, and no token in anybody's URL.
// SQLite-backed Durable Objects and their alarms are available on the Workers Free plan.
//
// The cron config in wrangler.toml is deliberately LEFT IN PLACE. If Cloudflare's scheduler comes
// back, both fire and nothing breaks: claimPollSlot is an atomic claim on a shared interval, so the
// second one to arrive is refused the tick. Two schedulers cannot double-send a DM.

import { runPoll } from "./poll";
import { pollIntervalSeconds } from "./runtime";
import type { Env } from "./types";

/** How far ahead each alarm schedules the next one. Cloudflare's own cron floor is 60s. */
const TICK_MS = 60_000;

/**
 * The first alarm fires almost immediately rather than a minute out, so arming the ticker gives
 * visible feedback (a poll runs, last_poll_ts moves) instead of a silent minute of nothing.
 */
const FIRST_TICK_MS = 1_000;

export class Ticker {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  /**
   * Arm the ticker. Idempotent: an alarm that is already pending is left alone, so repeated calls
   * never shorten the interval or stack up. Returns when the next tick is due.
   */
  async fetch(): Promise<Response> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + FIRST_TICK_MS);
    }
    const next = await this.state.storage.getAlarm();
    return Response.json({
      armed: true,
      was_already_armed: existing !== null,
      next_tick_at: next,
      tick_seconds: TICK_MS / 1000,
    });
  }

  async alarm(): Promise<void> {
    // Re-arm BEFORE doing any work.
    //
    // This ordering is the whole reliability story. An exception thrown by the poll — a bad token,
    // an Instagram outage, a malformed campaign — must not be able to stop the clock. Scheduling
    // the next alarm first means the worst a broken tick can do is skip itself; the ticker is still
    // running a minute later and recovers on its own. Re-arming last would turn any single failure
    // into a permanent, silent outage, which is exactly the failure mode we are here to replace.
    await this.state.storage.setAlarm(Date.now() + TICK_MS);

    const interval = pollIntervalSeconds(this.env);
    if (interval === null) return; // MODE=webhook with reconciliation off: nothing to poll.

    try {
      await runPoll(this.env, interval);
    } catch (e) {
      console.warn(`[chatmany] ticker poll failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** The single ticker instance. One clock per deployment, addressed by a fixed name. */
export function tickerStub(env: Env): DurableObjectStub {
  return env.TICKER.get(env.TICKER.idFromName("poll-ticker"));
}

// The Ticker replaces a Cron Trigger that Cloudflare registers and then never invokes. Since it is
// now the only thing driving the funnel, the property that matters is not "it polls" but "it keeps
// its own clock running no matter what the poll does". A ticker that stops re-arming is the exact
// silent, permanent outage we adopted it to escape.
//
// The poll is faked with a plain function rather than vi.fn(): vitest attributes an error thrown
// inside a vi.fn() to the test itself, even when the code under test catches it — which is
// precisely the behaviour under test here, so the mock would report a failure for working code.
// The rest of this suite fakes with plain objects (FakeClient, fakeD1) for the same reason.

import { describe, it, expect, beforeEach, vi } from "vitest";

let pollBehaviour: () => Promise<void> = async () => {};
let pollCalls = 0;

vi.mock("../src/poll", () => ({
  runPoll: async () => {
    pollCalls++;
    await pollBehaviour();
  },
}));

import { Ticker } from "../src/ticker";
import type { Env } from "../src/types";

/** Minimal stand-in for the alarm half of DurableObjectState.storage. */
function fakeState() {
  let alarm: number | null = null;
  const calls: string[] = [];
  return {
    calls,
    storage: {
      async getAlarm() {
        return alarm;
      },
      async setAlarm(at: number) {
        alarm = at;
        calls.push("setAlarm");
      },
    },
    get alarmAt() {
      return alarm;
    },
  };
}

const env = { MODE: "polling", POLL_INTERVAL_SECONDS: "60" } as unknown as Env;

function makeTicker(state: ReturnType<typeof fakeState>, e: Env = env) {
  return new Ticker(state as unknown as DurableObjectState, e);
}

beforeEach(() => {
  pollCalls = 0;
  pollBehaviour = async () => {};
});

describe("Ticker: arming", () => {
  it("arms itself when no alarm is pending", async () => {
    const st = fakeState();
    const body = (await (await makeTicker(st).fetch()).json()) as {
      armed: boolean;
      was_already_armed: boolean;
    };
    expect(body.armed).toBe(true);
    expect(body.was_already_armed).toBe(false);
    expect(st.alarmAt).toBeGreaterThan(0);
  });

  it("is idempotent — re-arming leaves the pending alarm untouched", async () => {
    // Arming on every reconnect must not push the next tick further away, or repeated arming
    // could starve the poll indefinitely.
    const st = fakeState();
    const t = makeTicker(st);
    await t.fetch();
    const first = st.alarmAt;
    const again = (await (await t.fetch()).json()) as { was_already_armed: boolean };
    expect(st.alarmAt).toBe(first);
    expect(again.was_already_armed).toBe(true);
  });
});

describe("Ticker: the clock survives a broken poll", () => {
  it("re-arms BEFORE polling, so a thrown poll cannot stop the clock", async () => {
    const st = fakeState();
    pollBehaviour = async () => {
      // At the moment the poll runs, the next alarm must already be scheduled.
      expect(st.alarmAt).not.toBeNull();
      st.calls.push("poll");
      throw new Error("Instagram is down");
    };
    await makeTicker(st).alarm();
    expect(st.calls).toEqual(["setAlarm", "poll"]);
    expect(st.alarmAt).toBeGreaterThan(Date.now());
  });

  it("swallows the poll's error rather than failing the alarm", async () => {
    const st = fakeState();
    pollBehaviour = async () => {
      throw new Error("token expired");
    };
    await expect(makeTicker(st).alarm()).resolves.toBeUndefined();
    expect(st.alarmAt).toBeGreaterThan(Date.now());
  });

  it("still re-arms when polling is switched off entirely", async () => {
    // MODE=webhook with reconciliation "off" means there is nothing to poll — but the ticker must
    // keep ticking, or flipping that var back on would leave a Worker that never polls again.
    const st = fakeState();
    const off = { MODE: "webhook", WEBHOOK_RECONCILE_SECONDS: "off" } as unknown as Env;
    await makeTicker(st, off).alarm();
    expect(st.alarmAt).toBeGreaterThan(Date.now());
    expect(pollCalls).toBe(0);
  });

  it("ticks about once a minute", async () => {
    const st = fakeState();
    const before = Date.now();
    await makeTicker(st).alarm();
    expect(pollCalls).toBe(1);
    const gap = (st.alarmAt as number) - before;
    expect(gap).toBeGreaterThanOrEqual(59_000);
    expect(gap).toBeLessThanOrEqual(61_000);
  });
});

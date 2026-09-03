// Regressions for the 2026-09-03 outage: two people commented, neither received a DM, and every
// health signal read fine. Two separate defects, both reproduced here.
//
// 1. BOOSTING SPLITS THE COMMENT THREAD. Instagram serves a boosted post from a COPY of the media,
//    with its own id. A comment left on the ad lives on the copy's comments edge and never appears
//    on the organic post's. The poller only ever fetched `campaign.media_id`, so everybody the ad
//    reached was invisible — measured on the live account: the organic thread's newest comment was
//    a day old while the ad's copy held the two comments that "did not work".
//
// 2. EVERY REFUSAL WAS TREATED AS RETRYABLE. Instagram will not open a DM from a comment older than
//    7 days, and says so with a plain 4xx. The comment was therefore left unprocessed, re-read on
//    the next poll, refused again — once a minute, forever, with nothing recorded and nothing shown.

import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import { InstagramApiError } from "../src/api/client";
import { campaignMediaIds, validateCampaign, ConfigError } from "../src/config";
import { pollComments } from "../src/poller/commentPoll";
import { eventCountsByType, isCommentProcessed, upsertCampaign } from "../src/db";
import type { Campaign, NormalizedComment } from "../src/types";
import type { Runtime } from "../src/runtime";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

const fastQueue = () => new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 });
const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1",
    name: "Test",
    media_id: "organic1",
    keywords: ["manychat"],
    exclude: [],
    public_reply: { enabled: true, texts: ["check your DMs"] },
    reward: { type: "link", value: "https://x.com/g" },
    copy: { opening: "tap 👇", opening_button: "Send it", delivery: "here you go {reward}" },
    ...over,
  };
}

function comment(over: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    kind: "comment",
    comment_id: "cm1",
    igsid: "user1",
    username: "guilherme",
    text: "Manychat",
    media_id: "organic1",
    timestamp: NOW,
    ...over,
  };
}

async function harness() {
  const db = await makeTestDb();
  const client = new FakeClient();
  const engine = new Engine(db, client as unknown as never, fastQueue());
  return { db, client, engine };
}

describe("campaignMediaIds", () => {
  it("is just the organic post when nothing was boosted", () => {
    expect(campaignMediaIds(campaign())).toEqual(["organic1"]);
  });

  it("includes every boosted copy, organic first", () => {
    expect(campaignMediaIds(campaign({ ad_media_ids: ["ad1", "ad2"] }))).toEqual(["organic1", "ad1", "ad2"]);
  });

  it("drops blanks, duplicates, and the organic id pasted in twice", () => {
    const c = validateCampaign({ ...campaign(), ad_media_ids: ["  ad1 ", "ad1", "organic1", "  "] });
    expect(campaignMediaIds(c)).toEqual(["organic1", "ad1"]);
  });

  it("rejects a non-string list rather than guessing", () => {
    expect(() => validateCampaign({ ...campaign(), ad_media_ids: [42] })).toThrow(ConfigError);
  });
});

describe("a comment left on the boosted copy", () => {
  it("triggers the campaign that owns the organic post", async () => {
    const { db, client, engine } = await harness();
    const c = campaign({ ad_media_ids: ["adcopy1"] });
    await upsertCampaign(db, c);

    await engine.handleComment(comment({ media_id: "adcopy1" }), [c]);

    expect(client.calls.privateReply).toHaveLength(1);
    expect((await eventCountsByType(db, "c1", 0)).opening_sent).toBe(1);
  });

  it("is invisible without the copy's id — the bug, pinned", async () => {
    const { client, engine } = await harness();
    const c = campaign(); // no ad_media_ids
    await engine.handleComment(comment({ media_id: "adcopy1" }), [c]);
    expect(client.calls.privateReply).toHaveLength(0);
  });

  it("still ignores media belonging to no campaign", async () => {
    const { client, engine } = await harness();
    const c = campaign({ ad_media_ids: ["adcopy1"] });
    await engine.handleComment(comment({ media_id: "someone_elses_post" }), [c]);
    expect(client.calls.privateReply).toHaveLength(0);
  });

  it("is fetched by the poller alongside the organic post", async () => {
    const db = await makeTestDb();
    await upsertCampaign(db, campaign({ ad_media_ids: ["adcopy1", "adcopy2"] }));

    const fetched: string[] = [];
    const rt = {
      client: { getComments: async (id: string) => (fetched.push(id), []) },
      engine: { handleComment: async () => {} },
    } as unknown as Runtime;

    await pollComments(rt, db);
    expect(fetched).toEqual(["organic1", "adcopy1", "adcopy2"]);
  });

  it("fetches media shared by two campaigns only once", async () => {
    const db = await makeTestDb();
    await upsertCampaign(db, campaign({ campaign_id: "c1", ad_media_ids: ["shared"] }));
    await upsertCampaign(db, campaign({ campaign_id: "c2", media_id: "organic2", ad_media_ids: ["shared"] }));

    const fetched: string[] = [];
    const rt = {
      client: { getComments: async (id: string) => (fetched.push(id), []) },
      engine: { handleComment: async () => {} },
    } as unknown as Runtime;

    await pollComments(rt, db);
    expect(fetched).toEqual(["organic1", "shared", "organic2"]);
  });
});

describe("a comment past the 7-day private-reply window", () => {
  it("is not attempted at all, and is consumed so it stops being re-read", async () => {
    const { db, client, engine } = await harness();
    const c = campaign();
    const old = comment({ timestamp: NOW - 8 * DAY });

    await engine.handleComment(old, [c]);

    expect(client.calls.privateReply).toHaveLength(0);
    expect(client.calls.reply).toHaveLength(0); // no public reply promising a DM that cannot be sent
    expect(await isCommentProcessed(db, old.comment_id)).toBe(true);
  });

  it("is recorded as a lead we could not answer, not dropped in silence", async () => {
    const { db, engine } = await harness();
    await engine.handleComment(comment({ timestamp: NOW - 8 * DAY }), [campaign()]);
    expect((await eventCountsByType(db, "c1", 0)).opening_failed).toBe(1);
  });

  it("still answers a comment just inside the window", async () => {
    const { client, engine } = await harness();
    await engine.handleComment(comment({ timestamp: NOW - 6 * DAY }), [campaign()]);
    expect(client.calls.privateReply).toHaveLength(1);
  });

  it("logs nothing for an old comment that never matched a keyword", async () => {
    const { db, engine } = await harness();
    const old = comment({ text: "nice video", timestamp: NOW - 8 * DAY });
    await engine.handleComment(old, [campaign()]);
    expect((await eventCountsByType(db, "c1", 0)).opening_failed).toBe(0);
    expect(await isCommentProcessed(db, old.comment_id)).toBe(true);
  });
});

describe("how a send failure is classified", () => {
  it("a final refusal consumes the comment and records the miss", async () => {
    const { db, client, engine } = await harness();
    const c = campaign();
    client.privateReplyWithButtons = async () => {
      throw new InstagramApiError("the comment is too old get a reply", 400, 10903);
    };

    await engine.handleComment(comment(), [c]);

    expect(await isCommentProcessed(db, "cm1")).toBe(true);
    expect((await eventCountsByType(db, "c1", 0)).opening_failed).toBe(1);
    expect((await eventCountsByType(db, "c1", 0)).opening_sent).toBe(0);
  });

  it("a throttle or a server fault is still retried, so nobody is written off early", async () => {
    const { db, client, engine } = await harness();
    const c = campaign();
    client.failNext.privateReply = 1; // FakeClient throws a 500

    await engine.handleComment(comment(), [c]);

    expect(await isCommentProcessed(db, "cm1")).toBe(false);
    expect((await eventCountsByType(db, "c1", 0)).opening_failed).toBe(0);

    await engine.handleComment(comment(), [c]); // next poll re-reads the same comment
    expect(client.calls.privateReply).toHaveLength(1);
    expect(await isCommentProcessed(db, "cm1")).toBe(true);
  });
});

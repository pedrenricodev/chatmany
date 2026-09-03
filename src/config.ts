// Config loading + validation (Section 7). A campaign is authored in the UI (campaigns table)
// or imported from config.json. Both funnel through validateCampaign so the engine can trust
// the shape. Validation fails loudly on missing media_id / keywords.

import type { AppConfig, Campaign } from "./types";

export class ConfigError extends Error {}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Validate + normalize one campaign object. Throws ConfigError on any invalid field. */
export function validateCampaign(input: unknown, index = 0): Campaign {
  const where = `campaigns[${index}]`;
  if (typeof input !== "object" || input === null) {
    throw new ConfigError(`${where} must be an object`);
  }
  const c = input as Record<string, unknown>;

  if (!isNonEmptyString(c.campaign_id)) {
    throw new ConfigError(`${where}.campaign_id is required`);
  }
  if (!isNonEmptyString(c.media_id)) {
    throw new ConfigError(`${where}.media_id is required`);
  }
  if (!Array.isArray(c.keywords) || c.keywords.length === 0 || !c.keywords.every(isNonEmptyString)) {
    throw new ConfigError(`${where}.keywords must be a non-empty array of strings`);
  }
  if (c.exclude !== undefined && (!Array.isArray(c.exclude) || !c.exclude.every(isNonEmptyString))) {
    throw new ConfigError(`${where}.exclude must be an array of strings`);
  }
  // Strings are required, but blank ones are not an error: this field is pasted in by hand, one id
  // per line, and a stray empty line must not take the whole campaign off the air. Blanks are
  // dropped in normalizeAdMediaIds; only a wrong TYPE is refused.
  if (
    c.ad_media_ids !== undefined &&
    (!Array.isArray(c.ad_media_ids) || !c.ad_media_ids.every((v) => typeof v === "string"))
  ) {
    throw new ConfigError(`${where}.ad_media_ids must be an array of strings`);
  }

  const reward = c.reward as Record<string, unknown> | undefined;
  if (
    !reward ||
    !["link", "code", "text"].includes(reward.type as string) ||
    !isNonEmptyString(reward.value)
  ) {
    throw new ConfigError(`${where}.reward must be { type: link|code|text, value: string }`);
  }

  const copy = c.copy as Record<string, unknown> | undefined;
  if (!copy || !isNonEmptyString(copy.opening) || !isNonEmptyString(copy.delivery)) {
    throw new ConfigError(`${where}.copy.opening and copy.delivery are required`);
  }

  if (c.public_reply !== undefined) {
    const pr = c.public_reply as Record<string, unknown>;
    if (typeof pr.enabled !== "boolean") {
      throw new ConfigError(`${where}.public_reply.enabled must be a boolean`);
    }
    if (pr.enabled && (!Array.isArray(pr.texts) || pr.texts.length === 0 || !pr.texts.every(isNonEmptyString))) {
      throw new ConfigError(`${where}.public_reply.texts must be a non-empty array when enabled`);
    }
  }

  // Reflect only known fields; ignore extras so the schema can evolve.
  return {
    campaign_id: c.campaign_id,
    name: typeof c.name === "string" ? c.name : undefined,
    media_id: c.media_id,
    ad_media_ids: normalizeAdMediaIds(c.ad_media_ids as string[] | undefined, c.media_id),
    keywords: c.keywords as string[],
    exclude: (c.exclude as string[] | undefined) ?? [],
    public_reply: c.public_reply as Campaign["public_reply"],
    like_comment: Boolean(c.like_comment),
    check_follow: Boolean(c.check_follow),
    verify_follow_count: Boolean(c.verify_follow_count),
    ask_email: Boolean(c.ask_email),
    reward: { type: reward.type as Campaign["reward"]["type"], value: reward.value as string },
    // `copy` used to be cast wholesale, which meant a non-string optional field (from
    // /config/import, or a row written straight into the campaigns table) reached the send path
    // and threw. Drop anything that isn't a usable string so it falls back to the built-in default
    // instead. Deliberately normalizing rather than rejecting: a throw here makes
    // getActiveCampaigns skip the row, which silently takes the whole campaign off the air —
    // a far worse outcome than one label reverting to its default.
    copy: {
      opening: copy.opening,
      opening_button: optionalString(copy.opening_button),
      follow_gate: optionalString(copy.follow_gate),
      follow_button: optionalString(copy.follow_button),
      email_ask: optionalString(copy.email_ask),
      delivery: copy.delivery,
    },
  };
}

/**
 * Trim, drop blanks, drop duplicates, and drop the organic id if it was pasted in as well.
 * The poller unions these with `media_id`, so a duplicate would only mean fetching one thread
 * twice per tick.
 */
function normalizeAdMediaIds(input: string[] | undefined, mediaId: string): string[] {
  if (!input) return [];
  const seen = new Set<string>([mediaId.trim()]);
  const out: string[] = [];
  for (const raw of input) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Every media this campaign watches: the organic post plus any boosted copies.
 *
 * Boosting is why this is a list. Instagram serves an ad from a COPY of the post, and a comment
 * left on that copy lives only on the copy's comments edge — the organic post's edge never shows
 * it. Measured on 2026-09-03: two commenters were invisible to the poller for exactly this reason
 * while the organic thread looked idle and healthy.
 */
export function campaignMediaIds(campaign: Campaign): string[] {
  return campaign.ad_media_ids?.length ? [campaign.media_id, ...campaign.ad_media_ids] : [campaign.media_id];
}

/** Keep a copy field only if it is a non-empty string; anything else falls back to the default. */
function optionalString(v: unknown): string | undefined {
  return isNonEmptyString(v) ? v : undefined;
}

/** Validate a full config payload (Section 7). */
export function validateConfig(input: unknown): AppConfig {
  if (typeof input !== "object" || input === null) {
    throw new ConfigError("config must be an object");
  }
  const cfg = input as Record<string, unknown>;
  if (!Array.isArray(cfg.campaigns) || cfg.campaigns.length === 0) {
    throw new ConfigError("config.campaigns must be a non-empty array");
  }
  const campaigns = cfg.campaigns.map((c, i) => validateCampaign(c, i));

  // Enforce unique campaign_ids.
  const ids = new Set<string>();
  for (const c of campaigns) {
    if (ids.has(c.campaign_id)) throw new ConfigError(`duplicate campaign_id: ${c.campaign_id}`);
    ids.add(c.campaign_id);
  }

  const mode = cfg.mode === "webhook" ? "webhook" : "polling";
  const interval =
    typeof cfg.poll_interval_seconds === "number" && cfg.poll_interval_seconds > 0
      ? cfg.poll_interval_seconds
      : 90;

  return { mode, poll_interval_seconds: interval, campaigns };
}

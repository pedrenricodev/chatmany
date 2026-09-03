// JSON API for the chatmany web UI (Section 7A). All routes here are owner-gated by the caller
// (index.ts) via the OWNER_TOKEN. The UI is a pure config editor + monitor over the same tables
// the engine uses — no new funnel behavior.

import { validateCampaign } from "../config";
import {
  kvGet,
  kvSet,
  deleteCampaign,
  eventCountsByType,
  getAllCampaigns,
  getAuth,
  listConversations,
  now,
  setCampaignActive,
  setCampaignArchived,
  upsertCampaign,
} from "../db";
import { buildRuntime } from "../runtime";
import { tickerStub } from "../ticker";
import { getPollAgeSeconds, getPollError } from "../poller/messagePoll";
import { getCommentPollError } from "../poller/commentPoll";
import type { Env } from "../types";
import { json } from "./http";

export async function handleApi(env: Env, req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // Connection status + connected profile (drives the preview + settings screen).
  if (path === "/api/status" && method === "GET") return statusResponse(env);

  // Live account media for the builder picker + preview.
  if (path === "/api/media" && method === "GET") return mediaResponse(env);

  // Campaigns.
  if (path === "/api/campaigns" && method === "GET") return campaignsList(env, url);
  if (path === "/api/campaigns" && method === "POST") return campaignSave(env, req);
  if (path === "/api/campaigns/status" && method === "POST") return campaignStatus(env, req);
  if (path === "/api/campaigns/archive" && method === "POST") return campaignArchive(env, req);
  if (path === "/api/campaigns/delete" && method === "POST") return campaignDelete(env, req);

  // Dashboard + contacts.
  if (path === "/api/dashboard" && method === "GET") return dashboard(env, url);
  if (path === "/api/contacts" && method === "GET") return contacts(env, url);
  if (path === "/api/contacts/export" && method === "GET") return contactsCsv(env, url);

  return json({ error: "not found" }, 404);
}

async function statusResponse(env: Env): Promise<Response> {
  const auth = await getAuth(env.DB);
  if (!auth) return json({ connected: false });

  // Opening the dashboard arms the polling clock. The ticker re-arms itself forever after, so this
  // only ever matters once — but "once" is easy to miss, and missing it means the funnel silently
  // never runs. Doing it here makes the recovery for a stopped clock "open the dashboard", which
  // needs no command and no token pasted anywhere. Arming is idempotent (a pending alarm is left
  // alone) and non-fatal: a failure here must not take down the status endpoint the dashboard
  // depends on.
  try {
    await tickerStub(env).fetch("https://ticker/arm");
  } catch (e) {
    console.warn(`[chatmany] could not arm the ticker: ${e instanceof Error ? e.message : e}`);
  }
  await ensureWebhookSubscription(env);
  // Poll health belongs HERE, not only on /auth/status: this is the endpoint the dashboard calls.
  // The signal added after the 2026-08-09 stall went onto /auth/status, which nothing in the UI
  // ever requests — so the one thing built to make a frozen poller visible was itself invisible.
  const pollAge = await getPollAgeSeconds(env.DB);
  const pollError = await getPollError(env.DB);
  const commentPollError = await getCommentPollError(env.DB);
  return json({
    connected: true,
    username: auth.username,
    account_type: auth.account_type,
    profile_picture_url: auth.profile_picture_url,
    ig_user_id: auth.ig_user_id,
    expires_at: auth.expires_at,
    expires_in_days: Math.max(0, Math.round((auth.expires_at - now()) / 86400)),
    token_expired: auth.expires_at <= now(),
    // A healthy message poll refreshes its cursor every tick, so anything past a few minutes means
    // the poller is not completing. null means it has never run.
    poll_age_seconds: pollAge,
    poll_healthy: pollAge !== null && pollAge < 600 && !commentPollError,
    poll_error: pollError,
    comment_poll_error: commentPollError,
  });
}


/**
 * Subscribe the connected account to this app's webhooks, once.
 *
 * Configuring the callback URL in the Meta dashboard subscribes the APP; this subscribes the
 * ACCOUNT, and an event is delivered only when both are in place. handleCallback already does it
 * on connect — but an account connected BEFORE the callback URL existed never got a delivery, and
 * nothing about that state looks wrong from the outside: the funnel still works, just at poll speed
 * instead of instantly. Doing it here means opening the dashboard repairs it, with no reconnect.
 *
 * Guarded by a kv flag so this costs one Graph call ever, not one per status poll. Non-fatal: the
 * poll is the safety net, so failing to subscribe must never break the dashboard.
 */
const WEBHOOK_SUB_KEY = "webhook_subscribed_at";

async function ensureWebhookSubscription(env: Env): Promise<void> {
  try {
    if (await kvGet(env.DB, WEBHOOK_SUB_KEY)) return;
    const rt = await buildRuntime(env);
    if (!rt) return;
    await rt.client.subscribeToWebhooks();
    await kvSet(env.DB, WEBHOOK_SUB_KEY, String(now()));
    console.log("[chatmany] account subscribed to webhooks");
  } catch (e) {
    console.warn(`[chatmany] webhook subscribe failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function mediaResponse(env: Env): Promise<Response> {
  const rt = await buildRuntime(env);
  if (!rt) return json({ error: "not connected" }, 400);
  try {
    const media = await rt.client.getMedia(30);
    return json({ media });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

async function campaignsList(env: Env, url: URL): Promise<Response> {
  const archived = url.searchParams.get("archived") === "1";
  const items = await getAllCampaigns(env.DB, { archived });
  return json({
    campaigns: items.map((i) => ({ ...i.campaign, active: i.active, archived: i.archived, updated_at: i.updated_at })),
  });
}

async function campaignSave(env: Env, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const payload = body as { campaign?: unknown; active?: boolean };
  let campaign;
  try {
    campaign = validateCampaign(payload.campaign);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  await upsertCampaign(env.DB, campaign, payload.active ?? true);
  return json({ ok: true, campaign_id: campaign.campaign_id });
}

async function campaignStatus(env: Env, req: Request): Promise<Response> {
  const body = (await safeJson(req)) as { campaign_id?: string; active?: boolean };
  if (!body.campaign_id) return json({ error: "campaign_id required" }, 400);
  await setCampaignActive(env.DB, body.campaign_id, Boolean(body.active));
  return json({ ok: true });
}

async function campaignArchive(env: Env, req: Request): Promise<Response> {
  const body = (await safeJson(req)) as { campaign_id?: string; archived?: boolean };
  if (!body.campaign_id) return json({ error: "campaign_id required" }, 400);
  await setCampaignArchived(env.DB, body.campaign_id, Boolean(body.archived));
  return json({ ok: true });
}

async function campaignDelete(env: Env, req: Request): Promise<Response> {
  const body = (await safeJson(req)) as { campaign_id?: string };
  if (!body.campaign_id) return json({ error: "campaign_id required" }, 400);
  await deleteCampaign(env.DB, body.campaign_id);
  return json({ ok: true });
}

async function dashboard(env: Env, url: URL): Promise<Response> {
  const campaignId = url.searchParams.get("campaign_id");
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 30));
  const since = now() - days * 86400;
  const counts = await eventCountsByType(env.DB, campaignId, since);

  const comments = counts.comment_matched;
  const pct = (n: number) => (comments > 0 ? Math.round((n / comments) * 100) : 0);

  return json({
    campaign_id: campaignId,
    days,
    cards: {
      comments,
      sends: counts.opening_sent,
      clicks: counts.button_clicked,
      ctr: counts.opening_sent > 0 ? Math.round((counts.button_clicked / counts.opening_sent) * 100) : 0,
      follows: counts.follow_confirmed,
      emails: counts.email_captured,
      delivered: counts.delivered,
      // Leads Instagram refused to let us answer (a comment past the 7-day private-reply window,
      // a second private reply to one comment). Surfaced because the alternative is what happened
      // on 2026-09-03: the funnel read healthy while people who commented got nothing.
      failed: counts.opening_failed,
    },
    funnel: [
      { label: "Comentou", value: comments, pct: 100 },
      { label: "Tocou no botão", value: counts.button_clicked, pct: pct(counts.button_clicked) },
      { label: "Seguiu", value: counts.follow_confirmed, pct: pct(counts.follow_confirmed) },
      { label: "Deu o e-mail", value: counts.email_captured, pct: pct(counts.email_captured) },
      { label: "Recebeu o link", value: counts.delivered, pct: pct(counts.delivered) },
    ],
  });
}

const STATE_LABEL: Record<string, string> = {
  NEW: "abrindo",
  AWAITING_TAP: "DM enviado",
  AWAITING_FOLLOW: "esperando seguir",
  AWAITING_EMAIL: "esperando e-mail",
  DELIVER: "entregando",
  DONE: "entregue",
};

async function contacts(env: Env, url: URL): Promise<Response> {
  const campaignId = url.searchParams.get("campaign_id");
  const rows = await listConversations(env.DB, campaignId);
  return json({
    contacts: rows.map((r) => ({
      igsid: r.igsid,
      username: r.username,
      campaign_id: r.campaign_id,
      state: r.state,
      status_label: STATE_LABEL[r.state] ?? r.state,
      followed: r.followed === 1,
      email: r.email,
      updated_at: r.updated_at,
    })),
  });
}

async function contactsCsv(env: Env, url: URL): Promise<Response> {
  const campaignId = url.searchParams.get("campaign_id");
  const rows = await listConversations(env.DB, campaignId);
  const header = ["usuario", "igsid", "automacao", "status", "seguiu", "email", "atualizado_em"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csv(r.username ?? ""),
        csv(r.igsid),
        csv(r.campaign_id),
        csv(STATE_LABEL[r.state] ?? r.state),
        r.followed === 1 ? "sim" : "nao",
        csv(r.email ?? ""),
        new Date(r.updated_at * 1000).toISOString(),
      ].join(","),
    );
  }
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contatos.csv"`,
    },
  });
}

function csv(v: string): string {
  // Neutralize spreadsheet formulas before quoting. Excel, Sheets and Numbers all evaluate a cell
  // whose first character is = + - or @, so a contact who types `=cmd|'/c calc'!A1@x.com` as their
  // email becomes a live formula in the owner's own export. A leading apostrophe forces the cell to
  // be read as text; Excel and Sheets both hide it in the displayed value.
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

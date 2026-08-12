/**
 * Instagram Graph API client (Instagram Login flavour).
 *
 * Three calls matter:
 *
 *   privateReply()  one DM in response to a comment. Meta allows exactly ONE
 *                   per comment, ever, within 7 days. There is no retry.
 *   publicReply()   a normal comment reply. This is the only channel guaranteed
 *                   to be visible, so it doubles as the "check your Message
 *                   Requests" safety net.
 *   sendDm()        a normal DM, valid only inside the 24-hour window opened by
 *                   the user's own reply.
 */

import config from "./config.js";
import * as tenants from "./tenants.js";

async function post(url, payload, token = "") {
  const bearer = token || config.IG_TOKEN;

  // Never use WhatsApp token as Instagram token
  if (bearer && config.WHATSAPP_TOKEN && bearer === config.WHATSAPP_TOKEN) {
    console.error("Instagram API error: IG_TOKEN matches WHATSAPP_TOKEN — refusing to call Meta with invalid credentials.");
    return [false, "401 OAuthException code 190 (IG_TOKEN matches WHATSAPP_TOKEN)"];
  }

  if (!bearer || bearer.startsWith("TOK_")) {
    console.warn("Instagram API error: IG_TOKEN missing or invalid placeholder.");
    return [false, "Instagram token missing (IG_TOKEN not configured)"];
  }

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (r.status >= 400) {
      const text = await r.text();
      let errDetail = `${r.status} ${text.slice(0, 200)}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) {
          const e = parsed.error;
          errDetail = `${r.status} [${e.type || "OAuthException"}:${e.code || r.status}] ${e.message || text}`;
          console.error("Instagram API call failed:");
          console.error(`  status: ${r.status}`);
          console.error(`  code: ${e.code || "unknown"}`);
          console.error(`  type: ${e.type || "unknown"}`);
          console.error(`  message: ${e.message || "none"}`);
          if (e.fbtrace_id) console.error(`  fbtrace_id: ${e.fbtrace_id}`);
        } else {
          console.error(`Instagram API call failed ${r.status}: ${text.slice(0, 200)}`);
        }
      } catch {
        console.error(`Instagram API call failed ${r.status}: ${text.slice(0, 200)}`);
      }
      return [false, errDetail];
    }
    return [true, ""];
  } catch (err) {
    console.error("Instagram request network error:", err?.message || err);
    return [false, String(err?.message || err)];
  }
}

export function creds(tenantId) {
  if (tenantId) {
    const t = tenants.get(tenantId);
    if (t && t.ig_token && !t.ig_token.startsWith("TOK_") && (t.ig_token !== config.WHATSAPP_TOKEN || !config.WHATSAPP_TOKEN)) {
      return [t.ig_user_id || config.IG_USER_ID, t.ig_token];
    }
  }
  return [config.IG_USER_ID, config.IG_TOKEN];
}

async function privateReply(commentId, text, tenantId = null) {
  const [igId, token] = creds(tenantId);
  if (!token) {
    return [false, "Instagram token missing (IG_TOKEN not configured)"];
  }

  return post(
    `${config.IG_GRAPH}/${igId}/messages`,
    { recipient: { comment_id: commentId }, message: { text: text.slice(0, 1000) } },
    token,
  );
}

/** Reply under the comment. Also nudges the reel's engagement. */
async function publicReply(commentId, text, tenantId = null) {
  const [, token] = creds(tenantId);
  if (!token) {
    return [false, "Instagram token missing (IG_TOKEN not configured)"];
  }

  return post(
    `${config.IG_GRAPH}/${commentId}/replies`,
    { message: text.slice(0, 300) },
    token,
  );
}

/** Standard DM. Only valid inside the 24-hour window. */
async function sendDm(igUserId, text, tenantId = null) {
  const [igId, token] = creds(tenantId);
  if (!token) {
    return [false, "Instagram token missing (IG_TOKEN not configured)"];
  }
  return post(
    `${config.IG_GRAPH}/${igId}/messages`,
    { recipient: { id: igUserId }, message: { text: text.slice(0, 1000) } },
    token,
  );
}

export default { creds, privateReply, publicReply, sendDm };

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
  if (!bearer) {
    console.warn("IG token missing — dry run:", url, JSON.stringify(payload));
    return [true, "dry run"];
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
      const body = await r.text();
      console.error(`Instagram call failed ${r.status}: ${body}`);
      return [false, `${r.status} ${body.slice(0, 200)}`];
    }
    return [true, ""];
  } catch (err) {
    console.error("Instagram request failed:", err?.message || err);
    return [false, String(err?.message || err)];
  }
}

function creds(tenantId) {
  if (tenantId) {
    const t = tenants.get(tenantId);
    if (t && t.ig_token && !t.ig_token.startsWith("TOK_")) {
      return [t.ig_user_id || config.IG_USER_ID, t.ig_token];
    }
    if (t && t.ig_user_id) {
      return [t.ig_user_id, config.IG_TOKEN];
    }
  }
  return [config.IG_USER_ID, config.IG_TOKEN];
}

async function privateReply(commentId, text, tenantId = null) {
  const [igId, token] = creds(tenantId);
  const [ok, err] = await post(
    `${config.GRAPH}/${igId}/messages`,
    { recipient: { comment_id: commentId }, message: { text: text.slice(0, 1000) } },
    token,
  );
  if (ok) return [true, ""];
  console.log(`Private reply endpoint 1 failed (${err}); trying /{commentId}/private_replies...`);
  return post(
    `${config.GRAPH}/${commentId}/private_replies`,
    { message: text.slice(0, 1000) },
    token,
  );
}

/** Reply under the comment. Also nudges the reel's engagement. */
async function publicReply(commentId, text, tenantId = null) {
  const [, token] = creds(tenantId);
  return post(`${config.IG_GRAPH}/${commentId}/replies`,
              { message: text.slice(0, 300) }, token);
}

/** Standard DM. Only valid inside the 24-hour window. */
async function sendDm(igUserId, text, tenantId = null) {
  const [igId, token] = creds(tenantId);
  return post(
    `${config.IG_GRAPH}/${igId}/messages`,
    { recipient: { id: igUserId }, message: { text: text.slice(0, 1000) } },
    token,
  );
}

export default { privateReply, publicReply, sendDm };

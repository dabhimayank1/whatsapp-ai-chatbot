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
  const bearer = (token || config.IG_TOKEN || "").trim().replace(/^["']|["']$/g, "");

  if (!bearer || bearer.startsWith("TOK_")) {
    console.warn("Instagram API error: IG_TOKEN missing or invalid placeholder.");
    return [false, "Instagram token missing (IG_TOKEN not configured)"];
  }

  let effectiveUrl = url;
  if (bearer.startsWith("EAA")) {
    effectiveUrl = "https://graph.facebook.com/v21.0/me/messages";
  }

  const separator = effectiveUrl.includes("?") ? "&" : "?";
  const targetUrl = `${effectiveUrl}${separator}access_token=${encodeURIComponent(bearer)}`;

  try {
    const r = await fetch(targetUrl, {
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
          errDetail = `${r.status} [${e.type || "OAuthException"}:${e.code || r.status}] ${e.message || text} (len=${bearer.length}, start=${bearer.slice(0, 10)})`;
        }
      } catch {
        // text was not json
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
  if (config.IG_TOKEN && !config.IG_TOKEN.startsWith("TOK_")) {
    return [config.IG_USER_ID || "me", config.IG_TOKEN];
  }
  if (tenantId) {
    const t = tenants.get(tenantId);
    if (t && t.ig_token && !t.ig_token.startsWith("TOK_")) {
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

  // 1. Try graph.instagram.com/v21.0/me/messages
  let [ok, err] = await post(
    `${config.IG_GRAPH}/me/messages`,
    { recipient: { comment_id: commentId }, message: { text: text.slice(0, 1000) } },
    token,
  );

  // 2. Try graph.facebook.com/v21.0/me/messages
  if (!ok) {
    [ok, err] = await post(
      `https://graph.facebook.com/v21.0/me/messages`,
      { recipient: { comment_id: commentId }, message: { text: text.slice(0, 1000) } },
      token,
    );
  }

  // 3. Try igId endpoint
  if (!ok && igId && igId !== "me") {
    [ok, err] = await post(
      `${config.IG_GRAPH}/${igId}/messages`,
      { recipient: { comment_id: commentId }, message: { text: text.slice(0, 1000) } },
      token,
    );
  }
  return [ok, err];
}

/** Reply under the comment. Also nudges the reel's engagement. */
async function publicReply(commentId, text, tenantId = null) {
  const [, token] = creds(tenantId);
  if (!token) {
    return [false, "Instagram token missing (IG_TOKEN not configured)"];
  }

  let [ok, err] = await post(
    `${config.IG_GRAPH}/${commentId}/replies`,
    { message: text.slice(0, 300) },
    token,
  );
  if (!ok) {
    // Fallback to Graph Facebook endpoint if Graph Instagram endpoint rejected comment reply
    [ok, err] = await post(
      `https://graph.facebook.com/v21.0/${commentId}/replies`,
      { message: text.slice(0, 300) },
      token,
    );
  }
  return [ok, err];
}

/** Standard DM. Only valid inside the 24-hour window. */
async function sendDm(igUserId, text, tenantId = null) {
  const [igId, token] = creds(tenantId);
  if (!token) {
    return [false, "Instagram token missing (IG_TOKEN not configured)"];
  }
  let [ok, err] = await post(
    `${config.IG_GRAPH}/me/messages`,
    { recipient: { id: igUserId }, message: { text: text.slice(0, 1000) } },
    token,
  );
  if (!ok && igId && igId !== "me") {
    [ok, err] = await post(
      `${config.IG_GRAPH}/${igId}/messages`,
      { recipient: { id: igUserId }, message: { text: text.slice(0, 1000) } },
      token,
    );
  }
  return [ok, err];
}

export async function refreshInstagramToken(currentToken) {
  if (!currentToken || currentToken.startsWith("TOK_")) return [false, "no token"];
  try {
    // 1. Try Instagram Graph API refresh endpoint (for Instagram Login tokens)
    const urlIg = `${config.IG_GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(currentToken)}`;
    const r1 = await fetch(urlIg, { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (r1.ok) {
      const data1 = await r1.json();
      if (data1.access_token) {
        console.log("Instagram Long-Lived Token Refreshed via ig_refresh_token!");
        return [true, data1.access_token];
      }
    }

    // 2. Try Facebook Graph API exchange endpoint if APP_ID & APP_SECRET are present
    const appId = process.env.META_APP_ID || "1773979650614005";
    const appSecret = config.META_APP_SECRET;
    if (appId && appSecret) {
      const urlFb = `${config.GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${encodeURIComponent(currentToken)}`;
      const r2 = await fetch(urlFb, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (r2.ok) {
        const data2 = await r2.json();
        if (data2.access_token) {
          console.log("Instagram Token Refreshed via fb_exchange_token!");
          return [true, data2.access_token];
        }
      }
    }
    return [false, "Token refresh response did not contain access_token"];
  } catch (err) {
    console.error("Error refreshing IG token:", err?.message || err);
    return [false, String(err?.message || err)];
  }
}

export default { creds, privateReply, publicReply, sendDm, refreshInstagramToken };

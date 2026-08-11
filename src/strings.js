/** Python `str.format`-style placeholder filling, used for campaign copy.
 *
 * Unknown placeholders are left untouched rather than throwing, so a client
 * who types `{whatsapp}` into their DM copy in the portal gets a harmless
 * literal instead of a 500 in the webhook.
 */
export function fmt(template, ctx = {}) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(ctx, key) ? String(ctx[key] ?? "") : whole,
  );
}

/** Match Python's urllib.parse.quote(): `/` stays literal, `!'()*` do not. */
export function quote(s) {
  return encodeURIComponent(String(s))
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, "/");
}

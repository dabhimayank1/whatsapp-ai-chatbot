/**
 * Shared test scaffolding: a check/section reporter and a cookie-aware HTTP
 * client, standing in for Flask's `app.test_client()`.
 */

import { once } from "node:events";

export function reporter(width = 68) {
  const fails = [];
  let n = 0;
  return {
    check(label, cond, extra = "") {
      n += 1;
      console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}` + (extra ? `   ${extra}` : ""));
      if (!cond) fails.push(label);
    },
    section(title) {
      console.log(`\n${title}\n` + "-".repeat(width));
    },
    finish() {
      console.log("\n" + "=".repeat(width));
      console.log(`  ${n - fails.length}/${n} checks passed`);
      if (fails.length) console.log("  FAILED: " + fails.join("; "));
      console.log("=".repeat(width));
      return fails.length ? 1 : 0;
    },
  };
}

/** Boot an express app on an ephemeral port and return a client bound to it. */
export async function serve(app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return new TestClient(`http://127.0.0.1:${port}`, server);
}

class TestClient {
  constructor(base, server) {
    this.base = base;
    this.server = server;
    this.cookies = new Map();
  }

  #cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  #absorb(res) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method, path, { json, form, headers = {} } = {}) {
    const h = { ...headers };
    const jar = this.#cookieHeader();
    if (jar) h.cookie = jar;
    let body;
    if (json !== undefined) {
      h["content-type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      h["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + path, {
      method, headers: h, body, redirect: "manual",
    });
    this.#absorb(res);
    return res;
  }

  get(path, opts) { return this.request("GET", path, opts); }
  post(path, opts) { return this.request("POST", path, opts); }

  async getJson(path, opts) {
    return (await this.get(path, opts)).json();
  }

  close() {
    this.server.close();
  }
}

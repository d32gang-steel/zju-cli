// Minimal cookie-aware HTTP client built on Node's global fetch (Node >= 20).
// No third-party dependencies.

import { debug, logRequest, logResponse, peekBody } from './debug.js';

export class CookieJar {
  constructor() {
    /** @type {Map<string, {name:string,value:string,domain:string,path:string,expires:number|null}>} */
    this.cookies = new Map();
  }

  static key(c) {
    return `${c.domain}|${c.path}|${c.name}`;
  }

  add(cookie) {
    const now = Date.now();
    if (cookie.expires !== null && cookie.expires <= now) {
      this.cookies.delete(CookieJar.key(cookie));
      return;
    }
    this.cookies.set(CookieJar.key(cookie), cookie);
  }

  /** Parse every Set-Cookie header from a fetch Response. */
  addFromResponse(url, res) {
    const u = new URL(url);
    let list = [];
    if (typeof res.headers.getSetCookie === 'function') {
      list = res.headers.getSetCookie();
    } else {
      const raw = res.headers.get('set-cookie');
      if (raw) list = splitSetCookie(raw);
    }
    for (const line of list) {
      const c = parseSetCookie(line, u.hostname);
      if (c) this.add(c);
    }
  }

  headerFor(url) {
    const u = new URL(url);
    const now = Date.now();
    const out = [];
    for (const [k, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) {
        this.cookies.delete(k);
        continue;
      }
      const host = u.hostname;
      const domainOk =
        host === c.domain || host.endsWith('.' + c.domain.replace(/^\./, ''));
      if (!domainOk) continue;
      const path = u.pathname || '/';
      if (!path.startsWith(c.path)) continue;
      out.push(`${c.name}=${c.value}`);
    }
    return out.join('; ');
  }

  toJSON() {
    return [...this.cookies.values()];
  }

  static fromJSON(arr) {
    const jar = new CookieJar();
    for (const c of arr ?? []) jar.add(c);
    return jar;
  }
}

function splitSetCookie(raw) {
  // Split on commas that start a new `name=` pair, not on the comma in Expires.
  return raw.split(/,(?=\s*[^;,=\s]+=)/);
}

function parseSetCookie(line, defaultDomain) {
  const parts = line.split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  const cookie = {
    name,
    value,
    domain: defaultDomain,
    path: '/',
    expires: null,
  };
  for (const p of parts) {
    const [rawK, ...rest] = p.split('=');
    const k = rawK.trim().toLowerCase();
    const v = rest.join('=').trim();
    if (k === 'domain' && v) cookie.domain = v.replace(/^\./, '').toLowerCase();
    else if (k === 'path' && v) cookie.path = v;
    else if (k === 'max-age') {
      const s = Number(v);
      if (Number.isFinite(s)) cookie.expires = Date.now() + s * 1000;
    } else if (k === 'expires') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) cookie.expires = t;
    }
  }
  return cookie;
}

/**
 * fetch() with manual redirect handling and a cookie jar.
 * Returns the final Response plus the redirect chain.
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    jar,
    maxRedirects = 20,
    follow = true,
    timeoutMs = 30000,
    signal,
  } = opts;

  let current = new URL(url);
  let currentMethod = method.toUpperCase();
  let currentBody = body;
  const history = [];

  for (let i = 0; i <= maxRedirects; i++) {
    const h = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers };
    if (jar) {
      const cookie = jar.headerFor(current.toString());
      if (cookie) h.cookie = cookie;
    }
    logRequest(currentMethod, current.toString(), h);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    let res;
    try {
      res = await fetch(current, {
        method: currentMethod,
        headers: h,
        body: currentBody,
        redirect: 'manual',
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (jar) jar.addFromResponse(current.toString(), res);

    if (debug.enabled) {
      const declared = Number(res.headers.get('content-length') ?? 0);
      const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
      const bodyText = await peekBody(res, totalBytes ?? 0);
      logResponse(currentMethod, current.toString(), res.status, res.headers, bodyText, totalBytes);
      const location = res.headers.get('location');
      if (location) process.stderr.write(`[http] ↪ ${location}\n`);
    }

    const loc = res.headers.get('location');
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status) && loc;
    if (!isRedirect || !follow) {
      return { res, url: current.toString(), history };
    }

    history.push({ url: current.toString(), status: res.status, location: loc });
    const next = new URL(loc, current);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
      currentMethod = 'GET';
      currentBody = undefined;
      delete headers['content-type'];
      delete headers['Content-Type'];
      delete headers['content-length'];
      delete headers['Content-Length'];
    }
    current = next;
  }
  throw new Error(`Too many redirects (>${maxRedirects})`);
}

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Decode a body as UTF-8 text (the site is UTF-8; GBK responses are not expected). */
export async function text(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('utf8');
}

// Cookie-aware HTTP with legacy charset decoding (the site is GB2312).

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export class CookieJar {
  constructor() { this.map = new Map(); }
  static key(c) { return `${c.domain}|${c.path}|${c.name}`; }
  add(c) {
    if (c.expires && c.expires <= Date.now()) { this.map.delete(CookieJar.key(c)); return; }
    this.map.set(CookieJar.key(c), c);
  }
  addFromResponse(url, res) {
    const host = new URL(url).hostname;
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of list) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, path: '/', expires: null };
      for (const a of attrs) {
        const [k, ...v] = a.split('=');
        const key = k.trim().toLowerCase();
        const val = v.join('=').trim();
        if (key === 'domain' && val) c.domain = val.replace(/^\./, '');
        else if (key === 'path' && val) c.path = val;
        else if (key === 'max-age') c.expires = Date.now() + Number(val) * 1000;
        else if (key === 'expires') c.expires = Date.parse(val) || null;
      }
      this.add(c);
    }
  }
  headerFor(url) {
    const u = new URL(url);
    const out = [];
    for (const [k, c] of this.map) {
      if (c.expires && c.expires <= Date.now()) { this.map.delete(k); continue; }
      if (!(u.hostname === c.domain || u.hostname.endsWith('.' + c.domain))) continue;
      if (!u.pathname.startsWith(c.path)) continue;
      out.push(`${c.name}=${c.value}`);
    }
    return out.join('; ');
  }
  toJSON() { return [...this.map.values()]; }
  static fromJSON(arr) {
    const jar = new CookieJar();
    for (const c of arr ?? []) jar.add(c);
    return jar;
  }
}

export function decodeBody(buf, contentType = '') {
  const cs = /charset=([\w-]+)/i.exec(contentType)?.[1];
  for (const enc of [cs, 'gb18030', 'utf-8']) {
    if (!enc) continue;
    try { return new TextDecoder(enc).decode(buf); } catch {}
  }
  return buf.toString('utf8');
}

export async function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body, jar, follow = true, maxRedirects = 10, timeoutMs = 20000 } = opts;
  let current = new URL(url);
  let currentMethod = method.toUpperCase();
  let currentBody = body;

  for (let i = 0; i <= maxRedirects; i++) {
    const h = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers };
    if (jar) { const c = jar.headerFor(current.toString()); if (c) h.cookie = c; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, { method: currentMethod, headers: h, body: currentBody, redirect: 'manual', signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (jar) jar.addFromResponse(current.toString(), res);

    const loc = res.headers.get('location');
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status) && loc;
    if (!isRedirect || !follow) return { res, url: current.toString() };
    current = new URL(loc, current);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
      currentMethod = 'GET';
      currentBody = undefined;
    }
  }
  throw new Error('too many redirects');
}

export async function readBuffer(res) {
  return Buffer.from(await res.arrayBuffer());
}

export async function readText(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  return decodeBody(buf, res.headers.get('content-type') ?? '');
}

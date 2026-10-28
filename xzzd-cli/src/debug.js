// Debug tracing for HTTP traffic.
//
// Everything goes to stderr so the stdout JSON contract stays machine-readable.
// Secrets are masked: cookie values, Set-Cookie values, Authorization, form
// password fields, and one-shot query params (ticket/execution/code/state).

const TEXT_RE = /json|text|xml|javascript|x-www-form-urlencoded/i;
const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'x-session-id']);
const SECRET_PARAMS = new Set(['ticket', 'execution', 'code', 'state', 'session_code', 'password', '_csrf', 'authcode']);

export const debug = { enabled: false, full: false, maxBytes: 4096 };

export function configureDebug(flags = {}) {
  // XD_* is canonical; ZJU_* kept for scripts written before the rename.
  const pick = (name) => process.env[`XD_${name}`] ?? process.env[`ZJU_${name}`];
  debug.enabled = Boolean(flags.debug || pick('DEBUG') === '1' || pick('DEBUG') === 'true');
  debug.full = Boolean(flags['debug-full'] || pick('DEBUG_FULL') === '1');
  const max = Number(flags['debug-max'] || pick('DEBUG_MAX'));
  if (Number.isFinite(max) && max > 0) debug.maxBytes = max;
}

export function maskCookieString(value) {
  return String(value)
    .split(/;\s*/)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return part;
      return `${part.slice(0, eq)}=<${part.length - eq - 1}B>`;
    })
    .join('; ');
}

export function redactHeader(name, value) {
  const key = String(name).toLowerCase();
  if (!SECRET_HEADERS.has(key)) return String(value);
  if (key === 'cookie') return maskCookieString(value);
  return `<redacted ${String(value).length}B>`;
}

export function redactUrl(input) {
  try {
    const url = new URL(String(input));
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_PARAMS.has(key.toLowerCase())) {
        const len = (url.searchParams.get(key) ?? '').length;
        url.searchParams.set(key, `<${len}B>`);
      }
    }
    return url.toString();
  } catch {
    return String(input);
  }
}

export function redactBody(body, contentType = '') {
  const text = String(body);
  if (!/x-www-form-urlencoded/i.test(contentType)) return text;
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const key = decodeURIComponent(pair.slice(0, eq));
      return /password|authcode|csrf|token/i.test(key) ? `${key}=<redacted>` : pair;
    })
    .join('&');
}

function headerLines(headers) {
  const out = [];
  for (const [k, v] of headers) out.push(`       ${k}: ${redactHeader(k, v)}`);
  const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const c of setCookies) out.push(`       set-cookie: ${maskCookieString(c)}`);
  return out;
}

export function logRequest(method, url, headers = {}) {
  if (!debug.enabled) return;
  const lines = [`[http] → ${method} ${redactUrl(url)}`];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`       ${k}: ${redactHeader(k, Array.isArray(v) ? v.join('; ') : v)}`);
  }
  process.stderr.write(lines.join('\n') + '\n');
}

export function logResponse(method, url, status, headers, bodyText, totalBytes) {
  if (!debug.enabled) return;
  const ct = headers.get?.('content-type') ?? '';
  const size = totalBytes ?? (bodyText != null ? Buffer.byteLength(bodyText) : null);
  const lines = [
    `[http] ← ${status} ${method} ${redactUrl(url)}${size != null ? ` (${size}B${ct ? `, ${ct.split(';')[0]}` : ''})` : ''}`,
  ];
  lines.push(...headerLines(headers));

  if (bodyText != null) {
    let shown = bodyText;
    let truncated = false;
    if (!debug.full && shown.length > debug.maxBytes) {
      shown = shown.slice(0, debug.maxBytes);
      truncated = true;
    }
    lines.push(`       body: ${shown}`);
    if (truncated) lines.push(`       ... truncated (${bodyText.length} chars total, use --debug-full)`);
  } else if (size != null) {
    lines.push(`       body: <${TEXT_RE.test(ct) ? 'skipped' : 'binary'}, ${size}B>`);
  }
  process.stderr.write(lines.join('\n') + '\n');
}

/** Read a clone of the response body when it looks textual and not huge. */
export async function peekBody(res, totalBytes) {
  const ct = res.headers.get('content-type') ?? '';
  if (!TEXT_RE.test(ct)) return null;
  if (!debug.full && totalBytes > 2_000_000) return null;
  try {
    return await res.clone().text();
  } catch {
    return null;
  }
}

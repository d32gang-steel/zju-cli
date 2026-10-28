// ZJU unified authentication (zjuam CAS 5) client.
//
// Flow observed on 2026-10:
//   courses.zju.edu.cn/user/index
//     -> identity.zju.edu.cn/auth/realms/xdc/protocol/cas/login   (Keycloak broker)
//     -> identity.zju.edu.cn/auth/realms/xdc/broker/cas-client/login
//     -> zjuam.zju.edu.cn/cas/login?service=<keycloak endpoint>
//   POST username/password -> 302 -> keycloak -> courses.zju.edu.cn (session cookie)
//
// The password field is NOT standard PKCS#1: the university ships a modified
// RSA helper (js/login/security.js) that does textbook RSA over zero-padded,
// little-endian chunks of reverse(password), hex-encoded and space-separated.
// Verified byte-for-byte against that script on 2026-10.

import { request, text } from './http.js';

export const CAS_BASE = 'https://zjuam.zju.edu.cn/cas';
export const ENTRY = 'https://courses.zju.edu.cn/user/index';

export class AuthError extends Error {
  constructor(message, { code = 'AUTH_ERR', hint, detail } = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * Encrypt the password exactly like zjuam's js/login/login.js + security.js:
 * reverse the string, split into `chunkSize`-byte chunks (little-endian,
 * zero-padded), apply raw RSA to each chunk, join hex blocks with a space.
 */
export function encryptPassword(password, modulusHex, exponentHex) {
  // security.js packs UTF-16 code units two at a time into 16-bit digits and
  // overflows for non-ASCII input, so the site itself only works with ASCII.
  if (/[^\x00-\x7f]/.test(password)) {
    throw new AuthError('密码含非 ASCII 字符，浙大前端加密逻辑不支持', {
      code: 'NON_ASCII_PASSWORD',
      hint: '请用浏览器登录后执行 `xdc login --cookie "<Cookie>"`',
    });
  }
  const n = BigInt('0x' + modulusHex);
  const e = BigInt('0x' + exponentHex);
  // security.js: chunkSize = 2 * (numberOf16BitDigits(modulus) - 1) bytes.
  const digits = Math.ceil(modulusHex.length / 4);
  const chunkSize = Math.max(1, 2 * (digits - 1));

  const reversed = password.split('').reverse().join('');
  const blocks = [];
  for (let i = 0; i < reversed.length; i += chunkSize) {
    const chunk = reversed.slice(i, i + chunkSize);
    let m = 0n;
    for (let j = 0; j < chunk.length; j++) {
      m += BigInt(chunk.charCodeAt(j)) << BigInt(8 * j);
    }
    // security.js emits 4 hex chars per 16-bit digit (zero padded).
    const hex = modPow(m, e, n).toString(16);
    blocks.push(hex.padStart(Math.ceil(hex.length / 4) * 4, '0'));
  }
  return blocks.join(' ');
}

export async function getPubKey(jar) {
  const { res, url } = await request(`${CAS_BASE}/v2/getPubKey`, {
    jar,
    headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' },
  });
  if (!res.ok) throw new AuthError(`获取 CAS 公钥失败 (HTTP ${res.status})`, { code: 'PUBKEY' });
  const j = JSON.parse(await text(res));
  if (!j.modulus || !j.exponent) {
    throw new AuthError('CAS 公钥响应异常', { code: 'PUBKEY', detail: JSON.stringify(j).slice(0, 200) });
  }
  return j;
}

function parseHiddenInputs(html) {
  const out = {};
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = /\bname\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (!name) continue;
    const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '';
    const type = /\btype\s*=\s*"([^"]*)"/i.exec(tag)?.[1]?.toLowerCase();
    if (type === 'hidden') out[name] = value;
  }
  return out;
}

function formAction(html) {
  const m = /<form\b[^>]*\bid\s*=\s*"fm1"[^>]*>/i.exec(html) ?? /<form\b[^>]*>/i.exec(html);
  if (!m) return null;
  return /\baction\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? null;
}

function pageError(html) {
  const err = /id\s*=\s*"errormsg"[^>]*>([\s\S]*?)<\/(?:div|span)>/i.exec(html)?.[1];
  const msg = /id\s*=\s*"msg"[^>]*value\s*=\s*"([^"]*)"/i.exec(html)?.[1];
  const clean = (s) => (s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return clean(err) || clean(msg) || null;
}

async function captchaRequired(jar) {
  // The login page always renders the captcha node; JS asks this endpoint
  // whether it should be shown.
  const { res } = await request(`${CAS_BASE}/v2/getKaptchaStatus`, {
    jar,
    headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' },
  });
  if (!res.ok) return false;
  const body = (await text(res)).trim();
  return body === 'true';
}

/**
 * Log in with username/password.
 * @returns {{ok:true, jar:CookieJar, finalUrl:string, history:any[]}}
 */
export async function passwordLogin({ username, password, jar, log = () => {} }) {
  log('→ 请求入口页，跟随 SSO 跳转…');
  let { res, url, history } = await request(ENTRY, { jar });
  let html = await text(res);

  // Some accounts may already have a live session.
  if (new URL(url).hostname === 'courses.zju.edu.cn' && res.status === 200) {
    return { ok: true, jar, finalUrl: url, history, alreadyLoggedIn: true };
  }

  if (!url.startsWith('https://zjuam.zju.edu.cn/cas/login')) {
    throw new AuthError(`未到达 CAS 登录页，停在 ${url}`, {
      code: 'NO_CAS',
      hint: '可能需要人工登录/二次验证，请改用 --cookie 方式导入浏览器会话',
      detail: html.slice(0, 300),
    });
  }

  const action = formAction(html);
  const hidden = parseHiddenInputs(html);
  if (!action || !hidden.execution) {
    throw new AuthError('CAS 登录页结构变化：未找到 form action / execution', {
      code: 'CAS_FORM',
      detail: html.slice(0, 500),
    });
  }
  if (await captchaRequired(jar)) {
    throw new AuthError('CAS 要求验证码，无法自动登录', {
      code: 'CAPTCHA',
      hint: '请在浏览器登录后执行 `xdc login --cookie <值>` 导入会话',
    });
  }

  log('→ 获取公钥并加密口令（反转 + RSA PKCS#1 v1.5）…');
  const { modulus, exponent } = await getPubKey(jar);

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(hidden)) form.set(k, v);
  form.set('username', username);
  form.set('password', encryptPassword(password, modulus, exponent));
  form.set('_eventId', 'submit');

  const postUrl = new URL(action, url).toString();
  log('→ 提交登录表单…');
  ({ res, url, history } = await request(postUrl, {
    method: 'POST',
    jar,
    body: form.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://zjuam.zju.edu.cn',
      referer: url,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  }));
  html = await text(res);

  const host = new URL(url).hostname;
  if (host === 'courses.zju.edu.cn' && res.status === 200) {
    return { ok: true, jar, finalUrl: url, history };
  }

  const err = pageError(html);
  if (err) {
    throw new AuthError(err, {
      code: 'BAD_CREDENTIALS',
      hint: /验证码/.test(err) ? '需要验证码：请用浏览器登录后导入 cookie' : '请检查学号/密码',
    });
  }
  if (url.startsWith('https://zjuam.zju.edu.cn/cas/login')) {
    throw new AuthError('仍停留在 CAS 登录页（凭据被拒绝或触发了二次验证）', {
      code: 'LOGIN_REJECTED',
      hint: '若账号已开启二次验证，请用浏览器登录后导入 cookie',
      detail: html.slice(0, 300),
    });
  }
  if (new URL(url).hostname === 'identity.zju.edu.cn') {
    throw new AuthError('登录后停留在统一身份认证页（可能需要二次验证/确认）', {
      code: 'MFA_REQUIRED',
      hint: '请用浏览器完成登录后导入 cookie',
      detail: url,
    });
  }
  throw new AuthError(`登录未完成，停止在 ${url} (HTTP ${res.status})`, {
    code: 'INCOMPLETE',
    detail: html.slice(0, 300),
  });
}

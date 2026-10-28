// Login scheme reverse-engineered from the login page's inline JS:
//   password = md5( md5(plain + '@zju$#') + timestamp )
//   oldpass  = md5(plain)
// Both are submitted together with the page's timestamp hidden field.

import crypto from 'node:crypto';
import { request, readText } from './http.js';

export const SALT = '@zju$#';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

export function loginHashes(password, timestamp) {
  return {
    password: md5(md5(password + SALT) + timestamp),
    oldpass: md5(password),
  };
}

export function extractTimestamp(html) {
  const m = /name=["']timestamp["'][^>]*value=["'](\d+)["']/i.exec(html) ?? /value=["'](\d+)["'][^>]*name=["']timestamp["']/i.exec(html);
  return m?.[1] ?? null;
}

export function looksLoggedIn(html) {
  return !/name=["']timestamp["']/i.test(html) && !/Use Student ID as UserName/i.test(html);
}

export function loginError(html) {
  if (/Login Error/i.test(html)) return 'Login Error. Try Again';
  return null;
}

async function fetchLoginPage(base, cid, jar) {
  const url = `${base}/course/course.php?cid=${cid}`;
  const { res } = await request(url, { jar });
  return { url, html: await readText(res), status: res.status };
}

/**
 * Log in and return the cookie jar. Throws {code:'BAD_CREDENTIALS'} on refusal.
 */
export async function login({ base, cid, username, password, jar, log = () => {} }) {
  log('→ 获取登录页（含一次性 timestamp）');
  let page = await fetchLoginPage(base, cid, jar);

  if (looksLoggedIn(page.html)) return { ok: true, already: true };

  const timestamp = extractTimestamp(page.html);
  if (!timestamp) {
    throw Object.assign(new Error('登录页结构变化：找不到 timestamp 字段'), { code: 'LOGIN_PAGE' });
  }

  const { password: hash, oldpass } = loginHashes(password, timestamp);
  const form = new URLSearchParams({
    username,
    password: hash,
    oldpass,
    timestamp,
    tzoffset: String(-new Date().getTimezoneOffset()),
    access: '1',
    mathdisp: '0',
    graphdisp: '0',
    isok: '1',
  });

  log('→ 提交 md5 哈希登录表单');
  const { res } = await request(page.url, {
    method: 'POST',
    jar,
    body: form.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: page.url,
      origin: new URL(base).origin,
    },
  });
  const html = await readText(res);

  if (loginError(html)) {
    throw Object.assign(new Error('用户名或密码错误'), {
      code: 'BAD_CREDENTIALS',
      hint: '此系统使用单独的课程账号（学号 + 该平台密码），不是统一身份认证密码',
    });
  }
  if (!looksLoggedIn(html)) {
    throw Object.assign(new Error('登录未生效：仍停留在登录页'), {
      code: 'LOGIN_FAILED',
      hint: '可能触发了验证码或账号被限制；先用浏览器确认能登录',
    });
  }
  return { ok: true };
}

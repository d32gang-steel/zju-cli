// Session persistence: a cookie jar on disk, 0600, plus small metadata.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CookieJar } from './http.js';

export function configDir() {
  if (process.env.XD_CONFIG_DIR) return process.env.XD_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'xdc-cli');
}

export function sessionPath() {
  return path.join(configDir(), 'session.json');
}

export function loadSession() {
  try {
    const raw = fs.readFileSync(sessionPath(), 'utf8');
    const data = JSON.parse(raw);
    return {
      jar: CookieJar.fromJSON(data.cookies ?? []),
      username: data.username ?? null,
      savedAt: data.saved_at ?? null,
      baseUrl: data.base_url ?? null,
      meta: data.meta ?? {},
    };
  } catch {
    return null;
  }
}

export function saveSession({ jar, username, baseUrl, meta = {} }) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    saved_at: new Date().toISOString(),
    username: username ?? null,
    base_url: baseUrl ?? null,
    meta,
    cookies: jar.toJSON(),
  };
  const file = sessionPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

export function clearSession() {
  try {
    fs.unlinkSync(sessionPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Import a browser `Cookie:` header value (`a=1; b=2`) into a jar.
 * Accepts an optional `Cookie:` prefix and newlines.
 */
export function jarFromCookieString(str, domain = 'courses.zju.edu.cn') {
  const jar = new CookieJar();
  const cleaned = String(str)
    .replace(/^\s*cookie\s*:\s*/i, '')
    .replace(/\r?\n/g, ';');
  for (const part of cleaned.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    jar.add({ name, value, domain, path: '/', expires: null });
  }
  if (!jar.cookies.size) throw new Error('cookie 字符串为空或格式不正确');
  return jar;
}

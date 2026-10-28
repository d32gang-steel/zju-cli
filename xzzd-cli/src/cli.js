// Command-line surface. Designed so that both humans (tables) and agents
// (stable JSON on stdout, errors as JSON on stderr) can drive it.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { CookieJar } from './http.js';
import { passwordLogin, AuthError } from './cas.js';
import {
  Api,
  ApiError,
  DEFAULT_BASE,
  normAssignment,
  normAssignmentDetail,
  normMaterial,
  normNotification,
  normRollcall,
  normTodo,
} from './api.js';
import { configureDebug } from './debug.js';
import { checkPlatform } from './health.js';
import {
  compareCourses,
  deriveTerms,
  matchesSemester,
  parseSemesterLabel,
  pickCurrentSemesterKeys,
  semesterOrder,
} from './terms.js';
import {
  clearSession,
  jarFromCookieString,
  loadSession,
  saveSession,
  sessionPath,
} from './session.js';

const VERSION = '0.1.0';

const EXIT = { OK: 0, ERROR: 1, AUTH: 2, NOT_FOUND: 3, NETWORK: 4, USAGE: 5 };

/** XD_* is canonical; ZJU_* still works for scripts written before the rename. */
const env = (name) => process.env[`XD_${name}`] ?? process.env[`ZJU_${name}`];

const VALUE_FLAGS = new Set([
  'username', 'password', 'cookie', 'cookie-file', 'course', 'semester',
  'limit', 'base', 'query', 'header', 'json-body', 'form', 'download', 'debug-max',
  'page', 'page-size', 'fields', 'days', 'interval', 'exec', 'text',
]);
const BOOL_FLAGS = new Set([
  'json', 'pretty', 'raw', 'full', 'all', 'help', 'version', 'force',
  'verbose', 'compact', 'active', 'debug', 'debug-full', 'current', 'pending',
  'all', 'detail', 'once', 'yes',
]);

// ---------------------------------------------------------------- argv ----

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
      if (VALUE_FLAGS.has(key)) {
        const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (val === undefined) throw usageError(`--${key} 需要一个值`);
        flags[key] = flags[key] === undefined ? val : [].concat(flags[key], val);
      } else if (BOOL_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        throw usageError(`未知参数 --${key}`);
      }
    } else if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function usageError(message) {
  const e = new Error(message);
  e.code = 'USAGE';
  e.exitCode = EXIT.USAGE;
  return e;
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// --------------------------------------------------------------- output ----

const useJson = (flags) => Boolean(flags.json || flags.compact || !process.stdout.isTTY);

const print = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');

/**
 * Single output path. JSON mode prints one envelope; TTY mode prints
 * optional `lines`, then an optional table, else pretty JSON.
 */
function render(data, flags, opts = {}) {
  const { count, errors, table, lines, ...meta } = opts;
  if (useJson(flags)) {
    const payload = { ok: true };
    if (count !== undefined) payload.count = count;
    Object.assign(payload, meta);
    if (errors?.length) payload.errors = errors;
    payload.data = projectFields(data, flags.fields);
    print(JSON.stringify(payload, null, flags.compact ? 0 : 2));
    return;
  }
  if (lines?.length) print(lines.join('\n'));
  if (table) print(renderTable(table.headers, table.rows));
  if (!lines?.length && !table) print(JSON.stringify(data, null, 2));
}

/** `--fields id,name` trims JSON payloads (tables are unaffected). */
function projectFields(data, fields) {
  if (!fields) return data;
  const keys = String(fields).split(',').map((k) => k.trim()).filter(Boolean);
  if (!keys.length) return data;
  const pickFrom = (obj) =>
    keys.reduce((acc, k) => {
      if (obj && Object.prototype.hasOwnProperty.call(obj, k)) acc[k] = obj[k];
      return acc;
    }, {});
  if (Array.isArray(data)) return data.map((v) => (v && typeof v === 'object' ? pickFrom(v) : v));
  if (data && typeof data === 'object') return pickFrom(data);
  return data;
}

function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff)
        ? 2
        : 1;
  }
  return w;
}

function clip(s, max) {
  const str = String(s ?? '');
  if (strWidth(str) <= max) return str;
  let out = '';
  for (const ch of str) {
    if (strWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + '…';
}

function pad(s, w) {
  const str = clip(s, w);
  return str + ' '.repeat(Math.max(0, w - strWidth(str)));
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(strWidth(h), ...rows.map((r) => strWidth(r[i] ?? ''))),
  );
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------- login ----

async function readSecret(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw usageError('非交互环境请用 XD_PASSWORD 环境变量或 --password 传入口令');
  }
  return await new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          return reject(new Error('已取消'));
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf) {
            buf = buf.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        buf += ch;
        process.stderr.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function readLine(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw usageError('非交互环境请用 --username 或 XD_USERNAME');
  process.stderr.write(prompt);
  return await new Promise((resolve, reject) => {
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const cleanup = () => {
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          return resolve(buf);
        }
        if (ch === '\u0003') {
          cleanup();
          return reject(new Error('已取消'));
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// /api/profile is the student-facing "me" endpoint; /api/user is 403 for students.
const IDENTITY_PATHS = ['/api/profile', '/api/user', '/api/me', '/api/session'];

function pickUser(raw) {
  const u = raw?.user ?? raw?.data?.user ?? raw?.data ?? raw;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  if (u.id == null && u.name == null && u.username == null && u.user_no == null) return null;
  const dept = u.department ?? u.org;
  return {
    id: u.id ?? u.user_id ?? null,
    name: u.name ?? u.display_name ?? u.real_name ?? null,
    username: u.user_no ?? u.username ?? u.account ?? u.login ?? null,
    email: u.email ?? null,
    role: u.role ?? u.identity ?? null,
    department: typeof dept === 'string' ? dept : (dept?.name ?? null),
    klass: u.klass ?? null,
    raw,
  };
}

/**
 * Identity probing is best-effort: some deployments 403 `/api/user` while the
 * rest of the API works. A 401 (or network failure) is fatal, 403/404 is not.
 */
async function resolveIdentity(api) {
  const tried = [];
  for (const path of IDENTITY_PATHS) {
    try {
      const me = pickUser(await api.getJson(path));
      if (me) return { me, path, tried };
      tried.push({ path, status: 200, note: 'no user fields' });
    } catch (e) {
      tried.push({
        path,
        status: e.status ?? 0,
        code: e.code,
        ...(e.body ? { body: String(e.body).replace(/\s+/g, ' ').slice(0, 160) } : {}),
      });
      if (e.code === 'AUTH_REQUIRED' || e.code === 'NETWORK') {
        return { me: null, tried, fatal: e };
      }
    }
  }
  return { me: null, tried };
}

/** Real business endpoint: proves the session works even if /api/user is blocked. */
async function sessionHealth(api) {
  try {
    const r = await api.call('GET', '/api/my-courses');
    const list = r.json?.courses ?? r.json?.data?.courses;
    return { ok: true, status: r.status, courses: Array.isArray(list) ? list.length : null };
  } catch (e) {
    return { ok: false, status: e.status ?? null, code: e.code, message: e.message };
  }
}

const withoutRaw = ({ raw, ...rest }) => rest;

function loginWarnings(health, identity) {
  const warnings = [];
  if (!health.ok) {
    warnings.push({
      code: 'API_CHECK_FAILED',
      message: `登录已通过 SSO，但 /api/my-courses 返回 ${health.status ?? health.code}: ${health.message ?? ''}`,
      hint: '会话已保存；如果其它命令也报 403，请把 `xdc doctor --json` 的输出反馈给开发者',
    });
  }
  if (!identity?.me) {
    warnings.push({
      code: 'IDENTITY_UNAVAILABLE',
      message: `未能从 ${IDENTITY_PATHS.join(' / ')} 解析出用户身份`,
      probes: identity?.tried ?? [],
    });
  }
  return warnings;
}

async function cmdLogin(flags) {
  const base = flags.base || env('BASE') || DEFAULT_BASE;
  const verbose = (m) => flags.verbose && process.stderr.write(`[login] ${m}\n`);

  let cookieInput = flags.cookie || env('COOKIE');
  if (!cookieInput && flags['cookie-file']) {
    cookieInput = fs.readFileSync(flags['cookie-file'], 'utf8');
  }

  if (cookieInput) {
    const jar = jarFromCookieString(cookieInput);
    const api = new Api({ baseUrl: base, jar, verbose: Boolean(flags.verbose) });
    const health = await sessionHealth(api);
    if (!health.ok) {
      throw new ApiError(`Cookie 无效或已过期（${health.status ?? health.code}）`, {
        code: health.code ?? 'COOKIE_INVALID',
        status: health.status ?? 0,
        hint: '在浏览器已登录时，从 DevTools → Network 的 /api/ 请求里重新复制整条 Cookie',
        body: health.message,
      });
    }
    const identity = await resolveIdentity(api);
    saveSessionOrThrow({ jar, username: identity.me?.username, baseUrl: base, meta: { method: 'cookie' } });
    const warnings = loginWarnings(health, identity);
    render(
      {
        authenticated: true,
        method: 'cookie',
        session_file: sessionPath(),
        identity: identity.me ? withoutRaw(identity.me) : null,
        api_health: health,
        warnings: warnings.length ? warnings : undefined,
      },
      flags,
      {
        lines: [
          `✓ 已登录（Cookie 导入）${identity.me?.name ? ` · ${identity.me.name}` : ''}`,
          `会话已保存: ${sessionPath()}`,
          health.ok ? `API 可用（/api/my-courses ${health.status}）` : `⚠ API 返回 ${health.status ?? health.code}`,
        ],
      },
    );
    return;
  }

  if (!flags.force) {
    const existing = loadSession();
    if (existing?.jar?.cookies?.size) {
      const api = new Api({ baseUrl: existing.baseUrl || base, jar: existing.jar, verbose: Boolean(flags.verbose) });
      const health = await sessionHealth(api);
      if (health.ok) {
        const identity = await resolveIdentity(api);
        saveSessionOrThrow({ jar: existing.jar, username: identity.me?.username, baseUrl: base, meta: existing.meta });
        render(
          {
            authenticated: true,
            method: 'existing_session',
            session_file: sessionPath(),
            identity: identity.me ? withoutRaw(identity.me) : null,
          },
          flags,
          { lines: [`✓ 已有有效会话${identity.me?.name ? ` · ${identity.me.name}` : ''}（加 --force 可强制重登）`] },
        );
        return;
      }
      verbose(`本地会话不可用（${health.status ?? health.code}），重新登录`);
    }
  }

  const username = flags.username || env('USERNAME') || (await readLine('学号/用户名: '));
  const password = flags.password || env('PASSWORD') || (await readSecret('密码: '));
  if (!username || !password) throw usageError('需要用户名和密码');

  const jar = new CookieJar();
  const r = await passwordLogin({ username, password, jar, log: verbose });
  const api = new Api({ baseUrl: base, jar, verbose: Boolean(flags.verbose) });

  // Persist first: SSO already succeeded, a flaky follow-up check must not
  // discard a perfectly good session.
  saveSessionOrThrow({
    jar,
    username,
    baseUrl: base,
    meta: { method: 'cas', final_url: r.finalUrl },
  });

  const health = await sessionHealth(api);
  if (!health.ok && health.code === 'AUTH_REQUIRED') {
    clearSession();
    throw new ApiError('SSO 通过，但 API 仍认为未登录（会话 Cookie 未被接受）', {
      code: 'SESSION_NOT_ACCEPTED',
      status: 401,
      hint: '请用 `xdc login --cookie "<浏览器 Cookie>"` 导入会话，并反馈该问题',
    });
  }

  const identity = await resolveIdentity(api);
  const warnings = loginWarnings(health, identity);

  render(
    {
      authenticated: true,
      method: r.alreadyLoggedIn ? 'existing_session' : 'cas',
      final_url: r.finalUrl,
      session_file: sessionPath(),
      identity: identity.me ? withoutRaw(identity.me) : null,
      api_health: health,
      warnings: warnings.length ? warnings : undefined,
    },
    flags,
    {
      lines: [
        `✓ 登录成功${identity.me?.name ? ` · ${identity.me.name}` : ''}`,
        `会话已保存: ${sessionPath()}`,
        health.ok
          ? `API 可用（/api/my-courses ${health.status}）`
          : `⚠ 登录成功，但 /api/my-courses 返回 ${health.status ?? health.code}: ${health.message ?? ''}`,
      ],
    },
  );
}

function saveSessionOrThrow(args) {
  try {
    return saveSession(args);
  } catch (e) {
    throw new ApiError(`无法写入会话文件（${e.code ?? 'ERROR'}）`, {
      code: 'CONFIG_ERROR',
      hint: '把 XD_CONFIG_DIR 指到一个可写目录，例如 XD_CONFIG_DIR=~/.config/xd-cli',
    });
  }
}

function authRequired() {
  const e = new ApiError('未登录', {
    code: 'AUTH_REQUIRED',
    hint: '运行 `xdc login`，或 `xdc login --cookie "<浏览器 Cookie>"`',
  });
  e.exitCode = EXIT.AUTH;
  return e;
}

function getApi(flags) {
  const session = loadSession();
  if (!session?.jar?.cookies?.size) throw authRequired();
  const baseUrl = flags.base || session.baseUrl || DEFAULT_BASE;

  // Agents can export XD_USERNAME/XD_PASSWORD (or use --username/--password)
  // and the session will refresh itself when the 1h TronClass cookie expires.
  const onAuthRequired = async () => {
    const username = flags.username || env('USERNAME') || session.username;
    const password = flags.password || env('PASSWORD');
    if (!username || !password) return null;
    const jar = new CookieJar();
    await passwordLogin({ username, password, jar });
    saveSession({ jar, username, baseUrl, meta: { method: 'cas-auto' } });
    if (flags.verbose) process.stderr.write('[auth] 会话已过期，已自动重新登录\n');
    return jar;
  };

  return new Api({ baseUrl, jar: session.jar, onAuthRequired, verbose: Boolean(flags.verbose) });
}

// ------------------------------------------------------------- commands ----

function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function filterCourses(courses, flags) {
  let out = courses;
  const sem = flags.semester;
  if (flags.current || String(sem ?? '').toLowerCase() === 'current') {
    const keys = pickCurrentSemesterKeys(courses);
    out = out.filter((c) => keys.has(c.semester_key));
  } else if (sem) {
    out = out.filter((c) => matchesSemester(c, sem));
  }
  if (flags.active) {
    out = out.filter((c) => !c.status || !/closed|ended|archived/i.test(String(c.status)));
  }
  return out;
}

function buildCourseView(courses, { page, pages, pageSize, total, currentKeys, flags }) {
  const cols = process.stdout.columns || 100;
  const nameW = Math.max(18, Math.min(46, cols - 40));
  const lines = [];
  if (!courses.length) {
    lines.push(page > 1 ? `第 ${page} 页没有内容（共 ${pages} 页）` : '（没有匹配的课程）');
    return lines;
  }
  lines.push(`  ${pad('ID', 6)}  ${pad('课程', nameW)}  ${pad('教师', 12)}  ${pad('院系', 16)}`);

  let lastKey = Symbol('none');
  let firstGroup = true;
  for (const c of courses) {
    if (c.semester_key !== lastKey) {
      lastKey = c.semester_key;
      if (!firstGroup) lines.push('');
      firstGroup = false;
      const mark = c.semester_key && currentKeys?.has(c.semester_key) ? '  ← 当前' : '';
      lines.push(`▌ ${c.semester ?? '未分学期'}${mark}`);
    }
    lines.push(
      `  ${pad(c.id, 6)}  ${pad(c.name ?? '', nameW)}  ${pad(clip(c.instructor ?? '', 12), 12)}  ${clip(c.department ?? '', 16)}`,
    );
  }

  lines.push('');
  const summary = [`共 ${total} 门`];
  if (pageSize && pages > 1) summary.push(`第 ${page}/${pages} 页 · 每页 ${pageSize}`);
  lines.push(summary.join(' · '));
  if (pageSize && page < pages) {
    const parts = ['xdc', 'courses'];
    if (flags.current) parts.push('--current');
    if (flags.semester && !flags.current) parts.push(`--semester ${flags.semester}`);
    parts.push(`--page-size ${pageSize}`, `--page ${page + 1}`);
    lines.push(`下一页: ${parts.join(' ')}`);
  }
  return lines;
}

async function cmdCourses(flags) {
  const api = getApi(flags);
  const all = await api.myCourses();
  const courses = filterCourses(all, flags).sort(compareCourses);

  const asJson = useJson(flags);
  const pageSize = Number(flags['page-size'] ?? (asJson ? 0 : 20)) || 0;
  const page = Math.max(1, Number(flags.page ?? 1) || 1);
  const total = courses.length;
  const pages = pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const view = pageSize ? courses.slice((page - 1) * pageSize, page * pageSize) : courses;

  const extra = { count: view.length, total };
  if (pageSize) {
    Object.assign(extra, { page, page_size: pageSize, pages, has_next: page < pages });
  }

  render(view, flags, {
    ...extra,
    lines: asJson
      ? undefined
      : buildCourseView(view, {
          page,
          pages,
          pageSize,
          total,
          currentKeys: pickCurrentSemesterKeys(all),
          flags,
        }),
  });
}

async function resolveCourses(api, flags) {
  const all = await api.myCourses();
  if (flags.course) {
    const ids = new Set(asList(flags.course).map(String));
    const picked = all.filter((c) => ids.has(String(c.id)));
    if (picked.length) return picked;
    return asList(flags.course).map((id) => ({ id: Number(id), name: null }));
  }
  return filterCourses(all, flags);
}

async function cmdAssignments(flags) {
  const api = getApi(flags);
  const courses = await resolveCourses(api, flags);
  const out = [];
  const errors = [];

  await mapLimit(courses, 3, async (course) => {
    try {
      const acts = await api.homeworkActivities(course.id);
      for (const a of acts) out.push({ ...normAssignment(a, course), _raw: a });
    } catch (e) {
      if (e.code === 'AUTH_REQUIRED') throw e;
      errors.push({ course_id: course.id, course: course.name, code: e.code, message: e.message });
    }
  });

  const pool = flags.pending ? out.filter((a) => a.submitted !== true) : out;
  pool.sort((x, y) => {
    const a = x.due_at ? Date.parse(x.due_at) : Infinity;
    const b = y.due_at ? Date.parse(y.due_at) : Infinity;
    return a - b;
  });

  const limit = flags.limit ? Number(flags.limit) : 0;
  const trimmed = limit > 0 ? pool.slice(0, limit) : pool;
  // Keep the untrimmed raw payload out of JSON unless --full is set.
  const data = trimmed.map((item) =>
    flags.full || flags.raw ? item._raw ?? item : (({ _raw, ...rest }) => rest)(item),
  );

  render(data, flags, {
    count: data.length,
    errors: errors.length ? errors : undefined,
    table: {
      headers: ['ID', '课程', '作业', '截止', '剩余', '状态'],
      rows: trimmed.map((a) => [
        a.id,
        clip(a.course ?? a.course_id ?? '', 14),
        clip(a.title ?? '', 34),
        fmtLocal(a.due_at) || '—',
        a.due_in ?? '',
        a.submitted === true ? '已提交' : a.overdue ? '已逾期' : (a.status ?? ''),
      ]),
    },
  });
}

async function cmdAssignment(flags, positional) {
  const [courseId, activityId] = positional;
  if (!courseId || !activityId) {
    throw usageError('用法: xdc assignment <courseId> <activityId>');
  }
  const api = getApi(flags);
  const raw = await api.homeworkDetail(courseId, activityId);
  const activity = raw?.homework_activity ?? raw?.activity ?? raw;

  let course = { id: Number(courseId), name: null };
  try {
    const all = await api.myCourses();
    course = all.find((c) => String(c.id) === String(courseId)) ?? course;
  } catch {}

  if (flags.full || flags.raw) {
    render(raw, flags);
    return;
  }

  const detail = normAssignmentDetail(activity, course);
  const downloaded = [];
  if (flags.download) {
    const dir = path.resolve(String(flags.download));
    for (const f of detail.attachments) {
      if (!f.downloadable) continue;
      try {
        const url = await api.uploadUrl(f.id);
        const r = await api.downloadFile(url, path.join(dir, safeFileName(f.name, `file-${f.id}`)));
        downloaded.push({ name: f.name, path: r.path, size: r.size });
      } catch (e) {
        downloaded.push({ name: f.name, error: e.code ?? 'ERROR' });
      }
    }
    detail.downloaded = downloaded;
  }

  render(detail, flags, {
    lines: [
      `#${detail.id} ${detail.title ?? ''}`,
      `课程: ${detail.course ?? courseId}   截止: ${fmtLocal(detail.due_at) || '无'}   ${detail.due_in ?? ''}`,
      detail.submitted === true
        ? `状态: 已提交${detail.score != null ? `   得分: ${detail.score}` : ''}`
        : `状态: ${detail.is_closed ? '已截止未提交' : '未提交'}`,
      detail.allow_retract !== null ? `可撤回/重交: ${detail.allow_retract ? '是' : '否'}` : '',
      '',
      detail.description ?? '（无文字要求）',
      detail.attachments.length ? '' : null,
    ].filter((v) => v !== null),
    table: detail.attachments.length
      ? {
          headers: ['附件 ID', '文件名', '大小'],
          rows: detail.attachments.map((f) => [f.id, clip(f.name ?? '', 50), f.size ?? '']),
        }
      : undefined,
  });
}

async function cmdSubmit(flags, positional) {
  const [courseId, activityId] = positional;
  if (!courseId || !activityId) {
    throw usageError('用法: xdc submit <courseId> <activityId> --text "..." [--yes]');
  }
  if (flags.text === undefined) {
    throw usageError('目前只支持 --text 文本提交；附件上传接口尚未验证');
  }
  const api = getApi(flags);
  const raw = await api.homeworkDetail(courseId, activityId);
  const activity = raw?.homework_activity ?? raw?.activity ?? raw;
  const endpoint = `/api/courses/${courseId}/homework-activities/${activityId}/submissions`;
  const payload = { content: String(flags.text) };

  if (activity?.is_closed) {
    throw new ApiError('该作业已截止，平台可能拒绝提交', {
      code: 'HOMEWORK_CLOSED',
      hint: '确认是否有补交/重交开关；或到网页端查看',
    });
  }

  if (!flags.yes) {
    render(
      {
        dry_run: true,
        method: 'POST',
        endpoint,
        payload,
        note: '这是写操作：确认无误后加 --yes 才会真正提交；该接口在学在浙大上未经真机验证',
      },
      flags,
      {
        lines: [
          '（dry-run）将执行：',
          `POST ${endpoint}`,
          `body: ${JSON.stringify(payload)}`,
          '',
          '加 --yes 才会真正提交。该写接口未在学在浙大上验证，若 404 请用网页端提交。',
        ],
      },
    );
    return;
  }

  const r = await api.call('POST', endpoint, { json: payload });
  render({ submitted: true, status: r.status, response: r.json ?? r.text }, flags, {
    lines: [`已提交（HTTP ${r.status}）`],
  });
}

async function cmdCourse(flags, positional) {
  const id = positional[0] || flags.course;
  if (!id) throw usageError('用法: xdc course <courseId>');
  const api = getApi(flags);
  const detail = await api.courseDetail(id);
  let modules = [];
  try {
    modules = await api.courseModules(id);
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') throw e;
  }
  const data = {
    ...detail,
    module_count: modules.length,
    modules: flags.full || flags.raw ? modules : modules.map((m) => m?.name ?? m?.title ?? m),
  };
  render(data, flags, {
    lines: [
      `${detail.name ?? ''}  (id=${detail.id})`,
      detail.instructor ? `教师: ${detail.instructor}` : '',
      detail.semester ? `学期: ${detail.semester}` : '',
    ].filter(Boolean),
    table: modules.length
      ? {
          headers: ['#', '章节'],
          rows: modules.map((m, i) => [i + 1, m?.name ?? m?.title ?? JSON.stringify(m).slice(0, 60)]),
        }
      : undefined,
  });
}

async function cmdTodos(flags) {
  const api = getApi(flags);
  let todos = (await api.todos()).map(normTodo);
  if (flags.limit) todos = todos.slice(0, Number(flags.limit));
  render(todos, flags, {
    count: todos.length,
    table: {
      headers: ['ID', '标题', '课程', '截止', '剩余'],
      rows: todos.map((t) => [
        t.id,
        clip(t.title ?? '', 38),
        clip(t.course ?? t.course_id ?? '', 16),
        fmtLocal(t.due_at) || '—',
        t.due_in ?? '',
      ]),
    },
  });
}

async function cmdSemesters(flags) {
  const api = getApi(flags);
  let apiList = [];
  try {
    apiList = await api.mySemesters();
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED' || e.code === 'NETWORK') throw e;
  }
  const courses = await api.myCourses();

  let data;
  if (apiList.length) {
    // 秋/冬 are half-semesters of 秋冬, 春/夏 of 春夏 — keep them separate.
    data = apiList
      .map((s) => {
        const parsed = parseSemesterLabel(s.name);
        const key = parsed?.key ?? null;
        return {
          key,
          id: s.id,
          name: s.name,
          real_name: s.real_name,
          academic_year: parsed?.academic_year ?? null,
          term: parsed?.term ?? null,
          half: parsed?.half ?? null,
          count: courses.filter((c) => c.semester_id === s.id || (key && c.semester_key === key)).length,
          current: Boolean(s.active),
          source: 'api',
        };
      })
      .sort((a, b) => (Number(b.sort ?? 0) || semesterOrder(b.key)) - (Number(a.sort ?? 0) || semesterOrder(a.key)));
  } else {
    data = deriveTerms(courses);
  }

  render(data, flags, {
    count: data.length,
    table: {
      headers: ['KEY', '学期', '门数', '当前'],
      rows: data.map((t) => [t.key ?? t.id ?? '', t.name ?? '', t.count ?? '', t.current ? '✓' : '']),
    },
  });
}

async function cmdGrades(flags, positional) {
  const id = positional[0] || flags.course;
  if (!id) throw usageError('用法: xdc grades <courseId>');
  const api = getApi(flags);
  render(await api.grades(id), flags);
}

async function cmdAnnouncements(flags) {
  if (!flags.course && !flags.all) {
    throw usageError('用法: xdc announcements --course <courseId> 或 --all');
  }
  const api = getApi(flags);
  const map = (a, course) => ({
    id: a.id ?? null,
    title: a.title ?? a.name ?? null,
    course_id: a.course_id ?? course?.id ?? null,
    course: course?.name ?? a.course_name ?? null,
    author: a.author ?? a.created_by ?? null,
    created_at: toIsoLike(a.created_at ?? a.published_at),
    ...(flags.full || flags.raw ? { content: a.content ?? a.body ?? null } : {}),
  });

  let data;
  if (flags.course) {
    data = (await api.announcements(flags.course)).map((a) =>
      map(a, { id: Number(flags.course), name: null }),
    );
  } else if (flags.all) {
    const courses = await api.myCourses();
    const errors = [];
    data = [];
    await mapLimit(courses, 3, async (course) => {
      try {
        const list = await api.announcements(course.id);
        for (const a of list) data.push(map(a, course));
      } catch (e) {
        if (e.code === 'AUTH_REQUIRED') throw e;
        errors.push({ course_id: course.id, code: e.code, message: e.message });
      }
    });
    data.sort((x, y) => Date.parse(y.created_at ?? 0) - Date.parse(x.created_at ?? 0));
    render(data, flags, {
      count: data.length,
      errors: errors.length ? errors : undefined,
      table: {
        headers: ['ID', '课程', '标题', '时间'],
        rows: data.map((a) => [
          a.id,
          clip(a.course ?? a.course_id ?? '', 14),
          clip(a.title ?? '', 38),
          fmtLocal(a.created_at) || '',
        ]),
      },
    });
    return;
  } else {
    throw usageError('用法: xdc announcements --course <courseId> 或 --all');
  }

  render(data, flags, {
    count: data.length,
    table: {
      headers: ['ID', '标题', '时间'],
      rows: data.map((a) => [a.id, clip(a.title ?? '', 46), fmtLocal(a.created_at) || '']),
    },
  });
}

function toIsoLike(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

async function cmdNotifications(flags) {
  const api = getApi(flags);
  let list = (await api.notifications()).map(normNotification);
  if (flags.limit) list = list.slice(0, Number(flags.limit));
  render(list, flags, {
    count: list.length,
    table: {
      headers: ['ID', '标题', '课程', '已读', '时间'],
      rows: list.map((n) => [
        n.id,
        clip(n.title ?? '', 38),
        clip(n.course ?? n.course_id ?? '', 14),
        n.read ? '✓' : '',
        fmtLocal(n.created_at) || '',
      ]),
    },
  });
}

function safeFileName(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || fallback).slice(0, 120);
}

async function cmdMaterials(flags, positional) {
  const id = positional[0] || flags.course;
  if (!id) throw usageError('用法: xdc materials <courseId> [--download <dir>]');
  const api = getApi(flags);
  const list = (await api.courseMaterials(id)).map(normMaterial);

  const downloaded = [];
  const failed = [];
  if (flags.download) {
    const dir = path.resolve(String(flags.download));
    for (const m of list) {
      const sub = path.join(dir, safeFileName(m.title ?? `material-${m.id}`));
      for (const f of m.files) {
        if (!f.downloadable) {
          failed.push({ id: f.id, name: f.name, reason: 'not_downloadable' });
          continue;
        }
        try {
          const url = await api.uploadUrl(f.id);
          const dest = path.join(sub, safeFileName(f.name, `file-${f.id}`));
          const r = await api.downloadFile(url, dest);
          downloaded.push({ name: f.name, path: r.path, size: r.size });
        } catch (e) {
          failed.push({ id: f.id, name: f.name, reason: e.code ?? 'ERROR', message: e.message });
        }
      }
    }
  }

  const data = {
    course_id: Number(id),
    materials: list,
    downloaded,
    ...(failed.length ? { failed } : {}),
  };
  render(data, flags, {
    count: list.length,
    table: {
      headers: ['ID', '标题', '类型', '文件'],
      rows: list.map((m) => [
        m.id,
        clip(m.title ?? '', 40),
        m.type ?? '',
        m.files.map((f) => f.name).join(', ') || (m.link ? '外链' : '—'),
      ]),
    },
    lines: flags.download
      ? [`已下载 ${downloaded.length} 个文件到 ${path.resolve(String(flags.download))}`]
      : undefined,
  });
}

const ROLLCALL_SOURCE_LABEL = {
  qr: '扫码',
  number: '数字',
  radar: '雷达',
  import_rollcall: '导入',
};

const ROLLCALL_STATUS_LABEL = {
  absent: '缺勤',
  present: '出勤',
  on_call_fine: '正常',
  late: '迟到',
  leave: '请假',
  on_leave: '请假',
};

async function cmdRollcall(flags) {
  if (!flags.course && !flags.all) {
    throw usageError('用法: xdc rollcall --course <courseId>，或 --all 汇总全部课程');
  }
  const api = getApi(flags);
  const me = await api.getJson('/api/profile');
  const courses = await resolveCourses(api, flags);

  const sessions = [];
  const errors = [];
  await mapLimit(courses, 4, async (course) => {
    try {
      for (const rc of await api.moduleRollcalls(course.id)) sessions.push({ rc, course });
    } catch (e) {
      if (e.code === 'AUTH_REQUIRED' || e.code === 'NETWORK') throw e;
      errors.push({ course_id: course.id, code: e.code, message: e.message });
    }
  });

  sessions.sort(
    (x, y) => Date.parse(y.rc.rollcall_time ?? 0) - Date.parse(x.rc.rollcall_time ?? 0),
  );
  const limited = flags.limit ? sessions.slice(0, Number(flags.limit)) : sessions;

  // Per-session detail costs one request each; only do it when it is cheap
  // (single course) or explicitly requested.
  const withDetail = Boolean(flags.detail) || Boolean(flags.course);
  const items = [];
  for (const { rc, course } of limited) {
    let detail = rc;
    if (withDetail) {
      try {
        detail = await api.rollcallDetail(rc.id);
      } catch (e) {
        if (e.code === 'AUTH_REQUIRED' || e.code === 'NETWORK') throw e;
        errors.push({ rollcall_id: rc.id, code: e.code, message: e.message });
      }
    }
    items.push(normRollcall(detail, course, me.id));
  }

  const byStatus = {};
  for (const it of items) byStatus[it.my_status ?? 'unknown'] = (byStatus[it.my_status ?? 'unknown'] ?? 0) + 1;
  const data = { count: items.length, ...(withDetail ? { by_status: byStatus } : {}), rollcalls: items };

  render(
    data,
    flags,
    {
      count: items.length,
      errors: errors.length ? errors : undefined,
      table: items.length
        ? {
            headers: ['时间', '课程', '类型', '本人'],
            rows: items.map((r) => [
              fmtLocal(r.time) || '',
              clip(r.course ?? r.course_id ?? '', 18),
              ROLLCALL_SOURCE_LABEL[r.source] ?? r.source ?? r.type ?? '',
              r.my_status ? (ROLLCALL_STATUS_LABEL[r.my_status] ?? r.my_status) : '未取明细',
            ]),
          }
        : undefined,
      lines: items.length
        ? [
            `共 ${items.length} 次点名`,
            withDetail
              ? `本人状态: ${Object.entries(byStatus).map(([k, v]) => `${ROLLCALL_STATUS_LABEL[k] ?? k} ${v}`).join(' · ')}`
              : '本人状态: 未取明细（加 --detail 逐条查询）',
          ]
        : [
            '没有查到点名记录',
            '这门课可能从未点过名；学生端数据源是 `modules/rollcalls`（教师统计接口对学生 403）',
          ],
    },
  );
}

async function cmdWhoami(flags) {
  const api = getApi(flags);
  const identity = await resolveIdentity(api);
  if (!identity.me) {
    const health = await sessionHealth(api);
    render({ identity: null, api_health: health, probes: identity.tried }, flags, {
      lines: [
        '未能解析身份（接口不可用），但会话可能仍然有效',
        `API 健康检查: ${health.ok ? `ok (${health.status})` : `${health.status ?? health.code} ${health.message ?? ''}`}`,
      ],
    });
    return;
  }
  const me = identity.me;
  render(flags.full || flags.raw ? me : withoutRaw(me), flags, {
    lines: [`${me.name ?? '?'}${me.username ? ` (${me.username})` : ''}`],
  });
}

async function cmdApi(flags, positional) {
  const api = getApi(flags);
  const [methodArg, path] = positional;
  if (!methodArg || !path) {
    throw usageError('用法: xdc api <METHOD> <PATH> [--query k=v] [--json-body "<json>"]');
  }
  const method = methodArg.toUpperCase();

  const query = {};
  for (const q of asList(flags.query)) {
    const idx = q.indexOf('=');
    if (idx < 0) query[q] = '';
    else query[q.slice(0, idx)] = q.slice(idx + 1);
  }

  const headers = {};
  for (const h of asList(flags.header)) {
    const idx = h.indexOf(':');
    if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  let json;
  if (flags['json-body'] !== undefined) {
    let body = flags['json-body'];
    if (body.startsWith('@')) body = fs.readFileSync(body.slice(1), 'utf8');
    try {
      json = JSON.parse(body);
    } catch {
      throw usageError('--json-body 需要合法 JSON');
    }
  }

  const form = {};
  for (const f of asList(flags.form)) {
    const idx = f.indexOf('=');
    if (idx > 0) form[f.slice(0, idx)] = f.slice(idx + 1);
  }

  const r = await api.call(method, path, {
    query: Object.keys(query).length ? query : undefined,
    json,
    form: Object.keys(form).length ? form : undefined,
    headers,
  });
  const body = r.json !== undefined ? r.json : r.text;
  render({ status: r.status, path, body }, flags);
}

async function cmdDiscover(flags) {
  const api = getApi(flags);
  const courses = await api.myCourses();
  const cid = flags.course || courses[0]?.id;
  const candidates = [
    '/api/profile',
    '/api/my-courses',
    '/api/my-semesters',
    '/api/my-academic-years',
    '/api/todos',
    '/api/alert/messages',
    '/api/bulletins/latest',
    `/api/courses/${cid}`,
    `/api/courses/${cid}/modules`,
    `/api/courses/${cid}/activities`,
    `/api/courses/${cid}/homework-activities`,
    `/api/courses/${cid}/bulletins`,
    `/api/courses/${cid}/exam-scores`,
    `/api/courses/${cid}/exam-list`,
    `/api/course/${cid}/students_rollcalls`,
  ];


  const results = [];
  for (const path of candidates) {
    const row = { path, status: null, ok: false, keys: [], count: null };
    try {
      const r = await api.call('GET', path, { query: { page: 1, page_size: 5 } });
      row.status = r.status;
      row.ok = true;
      if (r.json && typeof r.json === 'object') {
        row.keys = Object.keys(r.json).slice(0, 12);
        const arr = Object.values(r.json).find(Array.isArray);
        if (arr) row.count = arr.length;
      }
    } catch (e) {
      row.status = e.status ?? null;
      row.error = e.code;
    }
    results.push(row);
  }
  render(results, flags, {
    lines: [`探测课程 id=${cid}`],
    table: {
      headers: ['端点', '结果', '顶层字段', '条数'],
      rows: results.map((r) => [
        r.path,
        r.ok ? `200` : (r.error ?? String(r.status)),
        r.keys.join(','),
        r.count ?? '',
      ]),
    },
  });
}

async function cmdDdl(flags) {
  const api = getApi(flags);
  const all = await api.myCourses();
  let courses;
  if (flags.course) {
    const ids = new Set(asList(flags.course).map(String));
    courses = all.filter((c) => ids.has(String(c.id)));
  } else if (flags.all) {
    courses = all;
  } else {
    // Default to the current term(s): old pending homework is just noise.
    courses = filterCourses(all, { current: true, semester: flags.semester });
  }

  const pending = [];
  const errors = [];
  await mapLimit(courses, 4, async (course) => {
    try {
      for (const raw of await api.homeworkActivities(course.id)) {
        const a = normAssignment(raw, course);
        if (a.submitted === true) continue;
        if (flags.days) {
          if (!a.due_at) continue;
          const limit = Date.now() + Number(flags.days) * 86400000;
          if (Date.parse(a.due_at) > limit) continue;
        }
        pending.push(a);
      }
    } catch (e) {
      if (e.code === 'AUTH_REQUIRED' || e.code === 'NETWORK') throw e;
      errors.push({ course_id: course.id, code: e.code, message: e.message });
    }
  });

  pending.sort((x, y) => {
    const a = x.due_at ? Date.parse(x.due_at) : Infinity;
    const b = y.due_at ? Date.parse(y.due_at) : Infinity;
    return a - b;
  });
  const data = flags.limit ? pending.slice(0, Number(flags.limit)) : pending;

  render(data, flags, {
    count: data.length,
    total: pending.length,
    errors: errors.length ? errors : undefined,
    table: data.length
      ? {
          headers: ['截止', '剩余', '课程', '作业'],
          rows: data.map((a) => [
            fmtLocal(a.due_at) || '无截止',
            a.due_in ?? '',
            clip(a.course ?? a.course_id ?? '', 16),
            clip(a.title ?? '', 38),
          ]),
        }
      : undefined,
    lines: data.length
      ? [`${data.length} 个未提交作业`]
      : ['没有未提交的作业 🎉'],
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdWatch(flags) {
  if (!flags.course && !flags.all && !flags.current) flags.current = true;
  const interval = Math.max(10, Number(flags.interval ?? 60)) * 1000;
  const json = useJson(flags);
  const seen = new Set();

  const scan = async () => {
    const api = getApi(flags);
    const all = await api.myCourses();
    const courses = flags.course
      ? all.filter((c) => asList(flags.course).map(String).includes(String(c.id)))
      : filterCourses(all, flags);

    const events = [];
    for (const course of courses) {
      let list = [];
      try {
        list = await api.moduleRollcalls(course.id);
      } catch (e) {
        if (e.code === 'AUTH_REQUIRED' || e.code === 'NETWORK') throw e;
        continue;
      }
      for (const rc of list) {
        const end = rc.end_time ? Date.parse(rc.end_time) : null;
        const open =
          (end !== null && end > Date.now()) ||
          !['finished', 'closed', 'ended'].includes(String(rc.status));
        if (!open) {
          seen.add(rc.id);
          continue;
        }
        if (seen.has(rc.id)) continue;
        seen.add(rc.id);
        events.push({
          type: 'rollcall',
          rollcall_id: rc.id,
          course_id: course.id,
          course: course.name ?? null,
          time: rc.rollcall_time ?? null,
          source: rc.source ?? null,
          status: rc.status ?? null,
          is_number: rc.is_number ?? null,
        });
      }
    }
    return { events, scanned: courses.length };
  };

  const emitEvents = (events) => {
    for (const ev of events) {
      if (json) process.stdout.write(JSON.stringify(ev) + '\n');
      else {
        process.stdout.write('\x07');
        print('');
        print(`🔔 点名进行中：${ev.course ?? ev.course_id} · ${ROLLCALL_SOURCE_LABEL[ev.source] ?? ev.source} · ${fmtLocal(ev.time) ?? ''}`);
        print(`   查看: xdc rollcall --course ${ev.course_id}`);
      }
      if (flags.exec) spawnSync(String(flags.exec), { shell: true, stdio: 'inherit' });
    }
    return events.length;
  };

  const first = await scan();
  const n = emitEvents(first.events);
  if (flags.once) {
    if (!json) print(n ? `发现 ${n} 个进行中的点名` : `已检查 ${first.scanned} 门课，当前没有进行中的点名`);
    return;
  }
  if (!json) {
    print(
      `盯人中：每 ${interval / 1000}s 检查 ${first.scanned} 门课${n ? '' : '（Ctrl-C 退出）'}`,
    );
  }

  process.on('SIGINT', () => process.exit(0));
  for (;;) {
    await sleep(interval);
    try {
      emitEvents((await scan()).events);
    } catch (e) {
      if (json) process.stdout.write(JSON.stringify({ type: 'error', code: e.code, message: e.message }) + '\n');
      else print(`⚠️ 检查失败：${e.message}（继续重试）`);
    }
  }
}

async function cmdStatus(flags) {
  const session = loadSession();
  const api = new Api({
    baseUrl: flags.base || session?.baseUrl || DEFAULT_BASE,
    jar: session?.jar,
    retries: 0,
    timeoutMs: 15000,
  });
  const platform = await checkPlatform(api);
  const auth = !session?.jar?.cookies?.size
    ? 'none'
    : platform.checks.some((c) => c.status === 401)
      ? 'expired'
      : 'ok';
  const data = { ...platform, auth };
  render(data, flags, {
    lines: [
      `平台: ${platform.platform}  (${platform.latency_ms}ms)`,
      `会话: ${auth}`,
      ...platform.checks.map(
        (c) => `  ${c.path}: ${c.status ?? c.code}${c.ok ? '' : ' ⚠'} ${c.ms}ms`,
      ),
      platform.platform === 'down' ? '平台当前不可用；如果不是你这边断网，就是学在浙大挂了，稍后再试。' : '',
    ].filter(Boolean),
  });
}

async function cmdDoctor(flags) {
  const report = {
    version: VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    session_file: sessionPath(),
    session: 'missing',
    api: 'unreachable',
    identity: null,
    cookies: [],
  };
  const session = loadSession();
  report.platform = await checkPlatform(
    new Api({ baseUrl: session?.baseUrl || DEFAULT_BASE, jar: session?.jar, retries: 0, timeoutMs: 15000 }),
  );
  if (session?.jar?.cookies?.size) {
    report.session = 'present';
    report.cookies = session.jar.toJSON().map((c) => c.name);
    const api = new Api({ baseUrl: session.baseUrl || DEFAULT_BASE, jar: session.jar, verbose: Boolean(flags.verbose) });
    const health = await sessionHealth(api);
    report.api = health.ok ? 'ok' : (health.code ?? 'error');
    report.api_status = health.status ?? null;
    if (health.ok) report.session = 'valid';
    const identity = await resolveIdentity(api);
    report.identity = identity.me ? withoutRaw(identity.me) : null;
    report.identity_path = identity.path ?? null;
    report.identity_probes = identity.tried;
    if (!health.ok) report.error = health.message;
  }
  const lines = Object.entries(report)
    .filter(([k]) => k !== 'identity')
    .map(([k, v]) => `${pad(k, 15)} ${Array.isArray(v) ? v.join(', ') : v}`);
  if (report.identity) lines.push(`${pad('identity', 15)} ${JSON.stringify(report.identity)}`);
  render(report, flags, { lines });
}

// ----------------------------------------------------------------- utils ----

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// ------------------------------------------------------------------ help ----

const HELP = `xdc — 学在浙大 (courses.zju.edu.cn) 命令行 / CLI for ZJU TronClass

用法:
  xdc <命令> [参数] [选项]

登录:
  xdc login                        登录（交互输入学号/密码，或读 XD_USERNAME/XD_PASSWORD）
  xdc login --cookie "<cookie>"    导入浏览器 Cookie（SSO 有二次验证/验证码时用这个）
  xdc logout                       清除本地会话
  xdc whoami                       显示当前身份

查询:
  xdc courses [--semester <key|学年|秋冬/春夏|current>] [--current]
              [--page N] [--page-size N] [--fields id,name,...]
  xdc course <courseId>                        课程详情 + 章节目录
  xdc assignments [--course <id>] [--current] [--pending] [--limit N]
                                               作业（默认汇总所有课程，按截止时间排序）
  xdc assignment <courseId> <activityId> [--download <dir>]
                                               作业要求/附件/本人提交状态
  xdc submit <courseId> <activityId> --text "..." [--yes]
                                               提交作业文本（默认 dry-run）
  xdc ddl [--current|--all] [--days N] [--limit N]
                                               未提交作业 + 截止时间（默认当前学期）
  xdc watch [--interval 60] [--once] [--course <id>]
                                               盯点名，出现即响铃/输出事件
  xdc todos [--limit N]                        待办
  xdc semesters                                学期列表
  xdc announcements --course <id> | --all      课程公告（--all 聚合全部课程）
  xdc notifications [--limit N]                通知
  xdc materials <courseId> [--download <dir>]  课件/资料（可选下载）
  xdc rollcall --course <id> | --all           点名记录 + 本人在场状态（只读）
  xdc grades <courseId>                        成绩

调试 / 扩展:
  xdc api <METHOD> <PATH> [--query k=v] [--json-body '<json>'] [--form k=v] [--header 'K: V']
  xdc discover [--course <id>]                 探测一组端点是否可用
  xdc status                                   平台健康检查（是否又崩了）
  xdc doctor                                   环境/会话自检

输出:
  --json       强制 JSON（默认非 TTY 时自动 JSON）
  --compact    单行 JSON（省 token）
  --pretty     强制人类表格
  --full       返回未经裁剪的原始对象
  --fields a,b JSON 只保留指定字段（省 token）
  --verbose    把流程步骤打印到 stderr
  --debug      打印每个请求/响应（含响应体）到 stderr，敏感值自动脱敏
  --debug-full 响应体不截断（默认 4096 字符，可用 --debug-max 调整）

环境变量:
  XD_USERNAME / XD_PASSWORD / XD_COOKIE / XD_BASE / XD_CONFIG_DIR
  XD_DEBUG=1 / XD_DEBUG_FULL=1 / XD_DEBUG_MAX=<chars>

退出码:
  0 成功 · 1 一般错误 · 2 未登录/登录失败 · 3 不存在 · 4 网络 · 5 用法错误

示例:
  xdc login --username 3200100000
  xdc assignments --json --limit 10
  xdc api GET /api/courses/123/homework-activities --query page=1
`;

// ------------------------------------------------------------------ main ----

export async function main(argv = process.argv.slice(2)) {
  let flags = {};
  let command = null;
  try {
    const parsed = parseArgv(argv);
    flags = parsed.flags;
    configureDebug(flags);
    if (flags.debug) flags.verbose = true;
    const positional = parsed.positional;
    command = positional.shift() ?? null;

    if (flags.version || command === 'version') {
      print(`xdc ${VERSION}`);
      return EXIT.OK;
    }
    if (flags.help || !command || command === 'help') {
      print(HELP);
      return EXIT.OK;
    }

    switch (command) {
      case 'login':
        await cmdLogin(flags);
        break;
      case 'logout': {
        const removed = clearSession();
        render({ logged_out: removed, session_file: sessionPath() }, flags, {
          lines: [removed ? '✓ 已清除本地会话' : '本地没有会话'],
        });
        break;
      }
      case 'whoami':
        await cmdWhoami(flags);
        break;
      case 'courses':
        await cmdCourses(flags);
        break;
      case 'course':
        await cmdCourse(flags, positional);
        break;
      case 'assignments':
      case 'homework':
        await cmdAssignments(flags);
        break;
      case 'assignment':
        await cmdAssignment(flags, positional);
        break;
      case 'submit':
        await cmdSubmit(flags, positional);
        break;
      case 'todos':
        await cmdTodos(flags);
        break;
      case 'semesters':
        await cmdSemesters(flags);
        break;
      case 'grades':
        await cmdGrades(flags, positional);
        break;
      case 'announcements':
        await cmdAnnouncements(flags);
        break;
      case 'notifications':
        await cmdNotifications(flags);
        break;
      case 'materials':
        await cmdMaterials(flags, positional);
        break;
      case 'rollcall':
      case 'rollcalls':
      case 'attendance':
        await cmdRollcall(flags);
        break;
      case 'api':
        await cmdApi(flags, positional);
        break;
      case 'discover':
        await cmdDiscover(flags);
        break;
      case 'ddl':
        await cmdDdl(flags);
        break;
      case 'watch':
        await cmdWatch(flags);
        break;
      case 'status':
      case 'health':
        await cmdStatus(flags);
        break;
      case 'doctor':
        await cmdDoctor(flags);
        break;
      default:
        throw usageError(`未知命令: ${command}（运行 xdc --help）`);
    }
    return EXIT.OK;
  } catch (err) {
    return reportError(err, flags);
  }
}

function reportError(err, flags) {
  let code = err.code ?? 'ERROR';
  let exitCode = err.exitCode ?? EXIT.ERROR;
  if (err instanceof AuthError) {
    exitCode = EXIT.AUTH;
  } else if (err instanceof ApiError) {
    if (err.code === 'AUTH_REQUIRED') exitCode = EXIT.AUTH;
    else if (err.code === 'NOT_FOUND') exitCode = EXIT.NOT_FOUND;
    else if (err.code === 'NETWORK') exitCode = EXIT.NETWORK;
  }

  const error = { code, message: err.message };
  if (err.hint) error.hint = err.hint;
  if (flags?.verbose && err.body) error.body = String(err.body).slice(0, 800);

  if (useJson(flags ?? {})) {
    process.stderr.write(JSON.stringify({ ok: false, error }, null, 2) + '\n');
  } else {
    process.stderr.write(`错误: ${err.message}\n`);
    if (err.hint) process.stderr.write(`提示: ${err.hint}\n`);
  }
  return exitCode;
}

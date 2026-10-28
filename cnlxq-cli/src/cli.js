import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CookieJar, request, readText } from './http.js';
import { login, looksLoggedIn } from './login.js';
import {
  htmlToText,
  pageMessage,
  humanizeDue,
  parseAssessment,
  parseCourseItems,
  parseCoursePage,
  parseCourses,
  parseGradebook,
  parseScheduleDeadlines,
  parseUploads,
} from './parse.js';
import { readBuffer } from './http.js';

const VERSION = '0.1.0';
const DEFAULT_BASE = 'http://10.214.0.253/network/exercise';
const EXIT = { OK: 0, ERROR: 1, AUTH: 2, NETWORK: 4, USAGE: 5 };

const env = (n) => process.env[`CNHW_${n}`];

class CnhwError extends Error {
  constructor(message, { code = 'ERROR', hint, exitCode } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

const configDir = () => env('CONFIG_DIR') || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cnhw');
const sessionPath = () => path.join(configDir(), 'session.json');

function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
    return { base: data.base, cid: data.cid, username: data.username, jar: CookieJar.fromJSON(data.cookies) };
  } catch { return null; }
}

function saveSession({ base, cid, username, jar }) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = sessionPath();
  fs.writeFileSync(file, JSON.stringify({ base, cid, username, saved_at: new Date().toISOString(), cookies: jar.toJSON() }, null, 2), { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------- argv ----
const VALUE_FLAGS = new Set(['course', 'folder', 'base', 'username', 'password', 'cookie', 'report', 'output', 'answers', 'value']);
const BOOL_FLAGS = new Set(['json', 'raw', 'help', 'version', 'verbose', 'yes']);

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (a === '-v') { flags.version = true; continue; }
    if (a === '-o') {
      const val = argv[++i];
      if (val === undefined) throw new CnhwError('-o 需要一个文件名', { code: 'USAGE', exitCode: EXIT.USAGE });
      flags.output = val;
      continue;
    }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
    if (VALUE_FLAGS.has(key)) {
      const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (val === undefined) throw new CnhwError(`--${key} 需要一个值`, { code: 'USAGE', exitCode: EXIT.USAGE });
      flags[key] = val;
    } else if (BOOL_FLAGS.has(key)) flags[key] = true;
    else throw new CnhwError(`未知参数 --${key}`, { code: 'USAGE', exitCode: EXIT.USAGE });
  }
  return { flags, positional };
}

// -------------------------------------------------------------- output ----
const useJson = (flags) => Boolean(flags.json || !process.stdout.isTTY);
const print = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');

function render(data, flags, { count, table, lines } = {}) {
  if (useJson(flags)) {
    const payload = { ok: true };
    if (count !== undefined) payload.count = count;
    payload.data = data;
    print(JSON.stringify(payload, null, 2));
    return;
  }
  if (lines?.length) print(lines.join('\n'));
  if (table) print(renderTable(table.headers, table.rows));
  if (!lines?.length && !table) print(JSON.stringify(data, null, 2));
}

function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return w;
}
const clip = (s, n) => {
  const str = String(s ?? '');
  if (strWidth(str) <= n) return str;
  let out = '';
  for (const ch of str) { if (strWidth(out + ch) > n - 1) break; out += ch; }
  return out + '…';
};
const pad = (s, w) => { const str = clip(s, w); return str + ' '.repeat(Math.max(0, w - strWidth(str))); };
function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(strWidth(h), ...rows.map((r) => strWidth(r[i] ?? ''))));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

/** Site links mix app-root paths (/course/x) and host-absolute ones (/network/download). */
function resolveTarget(base, target) {
  if (/^https?:/i.test(target)) return target;
  const origin = new URL(base).origin;
  if (target.startsWith('/network/')) return origin + target;
  return target.startsWith('/') ? `${base}${target}` : `${base}/${target}`;
}

// --------------------------------------------------------------- client ----
function requireSession() {
  const s = loadSession();
  if (!s?.jar) {
    throw new CnhwError('未登录', {
      code: 'AUTH_REQUIRED', exitCode: EXIT.AUTH,
      hint: '运行 `cnhw login --username <学号>`（密码走 CNHW_PASSWORD 或交互输入）',
    });
  }
  return s;
}

function client(flags) {
  const s = requireSession();
  const base = flags.base || s.base || env('BASE') || DEFAULT_BASE;
  const cid = Number(flags.course || s.cid || env('CID') || 115);
  return { base, cid, jar: s.jar, username: s.username };
}

async function fetchPage(url, jar) {
  let res;
  try {
    ({ res } = await request(url, { jar }));
  } catch (e) {
    throw new CnhwError(`连接失败: ${e.message}`, {
      code: 'NETWORK', exitCode: EXIT.NETWORK,
      hint: '确认在校内网络/VPN，且 http://10.214.0.253 可访问',
    });
  }
  const html = await readText(res);
  return { status: res.status, html };
}

function assertAuthed(html, url) {
  if (!looksLoggedIn(html)) {
    throw new CnhwError('会话已失效或未登录', {
      code: 'AUTH_REQUIRED', exitCode: EXIT.AUTH,
      hint: '重新运行 `cnhw login`',
    });
  }
}

// ------------------------------------------------------------- commands ----
async function readSecret(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return null;
  process.stderr.write(prompt);
  return await new Promise((resolve) => {
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', on); resolve(buf); };
    const on = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { process.stderr.write('\n'); return done(); }
        if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f') { if (buf) { buf = buf.slice(0, -1); process.stderr.write('\b \b'); } continue; }
        buf += ch; process.stderr.write('*');
      }
    };
    stdin.on('data', on);
  });
}

async function cmdLogin(flags) {
  const base = flags.base || env('BASE') || DEFAULT_BASE;
  const cid = Number(flags.course || env('CID') || 115);

  // Browser-session import: paste the PHPSESSID cookie when password login is
  // blocked (or when you don't want to store the course password).
  if (flags.cookie) {
    const jar = new CookieJar();
    for (const part of String(flags.cookie).replace(/^\s*cookie\s*:/i, '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar.add({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: '10.214.0.253', path: '/', expires: null });
    }
    const { html } = await fetchPage(`${base}/course/course.php?cid=${cid}`, jar);
    if (!looksLoggedIn(html)) throw new CnhwError('Cookie 无效或已过期', { code: 'AUTH_REQUIRED', exitCode: EXIT.AUTH });
    const file = saveSession({ base, cid, username: null, jar });
    render({ authenticated: true, base, cid, method: 'cookie', session_file: file }, flags, {
      lines: [`✓ 已导入浏览器会话（course ${cid}）`, `会话已保存: ${file}`],
    });
    return;
  }

  const username = flags.username || env('USERNAME');
  const password = flags.password || env('PASSWORD') || (await readSecret('密码: '));
  if (!username || !password) {
    throw new CnhwError('需要用户名和密码', {
      code: 'USAGE', exitCode: EXIT.USAGE,
      hint: 'cnhw login --username <学号>，密码用 CNHW_PASSWORD 或交互输入',
    });
  }
  const jar = new CookieJar();
  await login({ base, cid, username, password, jar, log: (m) => flags.verbose && process.stderr.write(`${m}\n`) });
  const file = saveSession({ base, cid, username, jar });
  render({ authenticated: true, base, cid, username, session_file: file }, flags, {
    lines: [`✓ 已登录 ${username}（course ${cid}）`, `会话已保存: ${file}`],
  });
}

async function cmdCourses(flags) {
  const s = loadSession();
  const base = flags.base || s?.base || env('BASE') || DEFAULT_BASE;
  const { html } = await fetchPage(`${base}/index.php`, s?.jar);
  assertAuthed(html, `${base}/index.php`);
  const courses = parseCourses(html);
  render(courses, flags, {
    count: courses.length,
    table: { headers: ['CID', '课程'], rows: courses.map((c) => [c.cid, c.name]) },
  });
}

async function cmdItems(flags) {
  const { base, cid, jar } = client(flags);
  const folder = flags.folder ?? '0';
  const url = `${base}/course/course.php?folder=${encodeURIComponent(folder)}&cid=${cid}`;
  const { html } = await fetchPage(url, jar);
  assertAuthed(html, url);
  const page = parseCoursePage(html);

  render(
    { course_id: cid, folder, header: page.header, links: page.links, schedule: page.schedule },
    flags,
    {
      lines: [
        `course ${cid} · folder ${folder} · ${page.links.length} 个链接`,
        page.header ? `进度表表头: ${page.header.join(' | ')}` : '',
      ].filter(Boolean),
      table: {
        headers: ['类型', '名称', '链接'],
        rows: page.links.map((l) => [l.kind, clip(l.text, 40), clip(l.href, 60)]),
      },
    },
  );
}

async function cmdShow(flags, positional) {
  const id = positional[0];
  if (!id) throw new CnhwError('用法: cnhw show <assessmentId>', { code: 'USAGE', exitCode: EXIT.USAGE });
  const { base, cid, jar } = client(flags);
  const url = `${base}/assessment/showtest.php?cid=${cid}&id=${id}`;
  const { html } = await fetchPage(url, jar);
  assertAuthed(html, url);
  const info = parseAssessment(html);
  render({ ...info, id: Number(id), url }, flags, {
    lines: [
      `${info.title || `assessment ${id}`}`,
      info.points != null ? `满分: ${info.points}` : '',
      info.time_limit_minutes ? `限时: ${info.time_limit_minutes} 分钟` : '无时间限制',
      '',
      info.question || '（未解析到题干）',
    ].filter((v) => v !== ''),
  });
}

async function cmdGradebook(flags) {
  const { base, cid, jar } = client(flags);
  const url = `${base}/course/gradebook.php?cid=${cid}`;
  const { html } = await fetchPage(url, jar);
  assertAuthed(html, url);
  const rows = parseGradebook(html);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  render({ course_id: cid, rows }, flags, {
    count: rows.length,
    table: rows.length
      ? { headers, rows: rows.map((r) => headers.map((h) => r[h])) }
      : undefined,
  });
}

async function cmdGet(flags, positional) {
  const target = positional[0];
  if (!target) throw new CnhwError('用法: cnhw get <path> [--raw]', { code: 'USAGE', exitCode: EXIT.USAGE });
  const s = loadSession();
  const base = flags.base || s?.base || env('BASE') || DEFAULT_BASE;
  const url = resolveTarget(base, target);
  const { status, html } = await fetchPage(url, s?.jar);
  if (flags.raw) {
    print(html);
    return;
  }
  render({ status, url, text: htmlToText(html).slice(0, flags.json ? undefined : 4000) }, flags, {
    lines: [htmlToText(html).slice(0, 4000)],
  });
}

async function cmdUploads(flags) {
  const { base, cid, jar } = client(flags);
  const url = `${base}/report/upload.php?cid=${cid}`;
  const { html } = await fetchPage(url, jar);
  assertAuthed(html, url);
  const { files, reports } = parseUploads(html);
  render({ course_id: cid, files, reports }, flags, {
    count: files.length,
    table: {
      headers: ['Lab', '上传时间', '文件名', '字节'],
      rows: files.map((f) => [f.report_id, f.uploaded_at, clip(f.filename, 44), f.size]),
    },
  });
}

async function cmdUpload(flags, positional) {
  const file = positional[0];
  if (!file) throw new CnhwError('用法: cnhw upload <文件> --report <Lab编号> [--yes]', { code: 'USAGE', exitCode: EXIT.USAGE });
  const reportId = flags.report;
  if (!reportId) throw new CnhwError('缺少 --report（Lab 编号，1-8）', { code: 'USAGE', exitCode: EXIT.USAGE });

  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) throw new CnhwError(`文件不存在: ${abs}`, { code: 'NO_FILE', exitCode: EXIT.USAGE });
  const size = fs.statSync(abs).size;
  if (size > 20_000_000) throw new CnhwError(`文件 ${size} 字节，超过 20MB 上限`, { code: 'FILE_TOO_LARGE' });

  const { base, cid, jar } = client(flags);
  if (!flags.yes) {
    render(
      { dry_run: true, course_id: cid, report_id: Number(reportId), file: abs, size, note: '加 --yes 才会真正上传（这是提交实验报告，会出现在老师端）' },
      flags,
      { lines: [`（dry-run）将上传 ${path.basename(abs)} (${size}B) 到 Lab ${reportId}`, '加 --yes 才会真正提交。'] },
    );
    return;
  }

  const boundary = `----cnhw${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="reportID"\r\n\r\n${reportId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="userfile"; filename="${path.basename(abs)}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fs.readFileSync(abs), tail]);
  const url = `${base}/report/upload.php?cid=${cid}`;
  const { res } = await request(url, {
    method: 'POST',
    jar,
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
      referer: url,
      origin: new URL(base).origin,
    },
  });
  const html = await readText(res);
  render({ uploaded: res.status === 200, status: res.status, report_id: Number(reportId), file: path.basename(abs), message: pageMessage(html) }, flags, {
    lines: [`HTTP ${res.status} ${pageMessage(html) ?? ''}`, '用 `cnhw uploads` 确认文件是否出现在列表里'],
  });
}

async function cmdDownload(flags, positional) {
  const target = positional[0];
  if (!target) throw new CnhwError('用法: cnhw download <path> [-o 文件]', { code: 'USAGE', exitCode: EXIT.USAGE });
  const s = loadSession();
  const base = flags.base || s?.base || env('BASE') || DEFAULT_BASE;
  const url = resolveTarget(base, target);
  const { res } = await request(url, { jar: s?.jar });
  if (!res.ok) throw new CnhwError(`下载失败 HTTP ${res.status}`, { code: 'DOWNLOAD_FAILED' });
  const buf = await readBuffer(res);
  const name = flags.output || decodeURIComponent(path.basename(new URL(url).pathname)) || 'download.bin';
  const out = path.resolve(String(name));
  fs.writeFileSync(out, buf);
  render({ url, path: out, size: buf.length }, flags, { lines: [`✓ ${out} (${buf.length} bytes)`] });
}

function fmtShanghai(iso) {
  if (!iso) return '';
  // sv-SE renders ISO-like "YYYY-MM-DD HH:MM:SS" and we ask for Shanghai time.
  return new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 16);
}

async function cmdDdl(flags) {
  const s = loadSession();
  const base = flags.base || s?.base || env('BASE') || DEFAULT_BASE;
  const solo = flags.course || s?.cid || env('CID') || 115;
  const jar = s?.jar;

  let courses = [{ cid: Number(solo), name: null }];
  try {
    const { html: idx } = await fetchPage(`${base}/index.php`, jar);
    if (looksLoggedIn(idx)) {
      const all = parseCourses(idx);
      courses = flags.all ? all : (all.filter((c) => c.cid === Number(solo)) || []);
      if (!courses.length) courses = [{ cid: Number(solo), name: null }];
    }
  } catch (e) {
    if (e.code === 'NETWORK') throw e;
  }

  const out = [];
  for (const course of courses) {
    let html;
    try {
      ({ html } = await fetchPage(`${base}/course/course.php?cid=${course.cid}`, jar));
    } catch (e) {
      if (e.code === 'NETWORK') throw e;
      continue;
    }
    if (!looksLoggedIn(html)) {
      throw new CnhwError('会话已失效', { code: 'AUTH_REQUIRED', exitCode: EXIT.AUTH, hint: '重新运行 `cnhw login`' });
    }
    const cards = parseCourseItems(html);
    const year = cards
      .map((c) => c.due_at)
      .filter(Boolean)
      .map((iso) => Number(fmtShanghai(iso).slice(0, 4)))[0];

    // Lab report deadlines live in the schedule table, not in the cards.
    let uploaded = new Set();
    try {
      const { html: up } = await fetchPage(`${base}/report/upload.php?cid=${course.cid}`, jar);
      uploaded = new Set(parseUploads(up).files.map((f) => f.report_id));
    } catch {}

    const items = [
      ...cards.filter((i) => i.kind === 'assessment' || i.due_at),
      ...parseScheduleDeadlines(html, { year }),
    ];

    for (const item of items) {
      out.push({
        ...item,
        course_id: course.cid,
        course: course.name,
        due_in: item.due_at ? humanizeDue(item.due_at) : null,
        overdue: item.due_at ? Date.parse(item.due_at) < Date.now() : null,
        submitted: item.kind === 'lab_report' ? uploaded.has(item.report_id) : null,
      });
    }
  }

  out.sort((a, b) => {
    const x = a.due_at ? Date.parse(a.due_at) : Infinity;
    const y = b.due_at ? Date.parse(b.due_at) : Infinity;
    return x - y;
  });

  render(out, flags, {
    count: out.length,
    table: {
      headers: ['截止', '剩余', '类型', '作业', '状态'],
      rows: out.map((i) => [
        i.due_at ? fmtShanghai(i.due_at) : '无',
        i.due_in ?? '',
        i.kind === 'lab_report' ? '实验' : '作业',
        clip(i.title, 34),
        i.submitted === true ? '已交' : i.submitted === false ? '未交' : '',
      ]),
    },
    lines: out.length ? [] : ['当前没有带截止时间的作业'],
  });
}

function readLine(prompt) {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding('utf8');
    const on = (chunk) => {
      stdin.pause();
      stdin.removeListener('data', on);
      resolve(chunk.replace(/\r?\n$/, ''));
    };
    stdin.on('data', on);
  });
}

async function postForm(url, jar, base, fields) {
  const body = new URLSearchParams(fields).toString();
  const { res } = await request(url, {
    method: 'POST',
    jar,
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: url,
      origin: new URL(base).origin,
    },
  });
  return { status: res.status, html: await readText(res) };
}

/**
 * Walk an assessment page by page, submitting the answers *you* provide.
 * This writes real attempts (iMATHAS keeps the last one), so it never submits
 * empty answers unless you explicitly type nothing.
 */
async function cmdReattempt(flags, positional) {
  const id = positional[0];
  if (!id) throw new CnhwError('用法: cnhw reattempt <assessmentId> --yes', { code: 'USAGE', exitCode: EXIT.USAGE });
  const { base, jar } = client(flags);
  if (!flags.yes) {
    render({ dry_run: true, id: Number(id), note: 'reattempt 会清空该测验的所有得分（correct and incorrect 都会清除）' }, flags, {
      lines: ['（dry-run）reattempt 会清空现有得分，加 --yes 才执行。'],
    });
    return;
  }
  // The site's own link drops cid/id: showtest.php?reattempt=all
  const url = `${base}/assessment/showtest.php?reattempt=all`;
  const { status, html } = await fetchPage(url, jar);
  assertAuthed(html, url);
  render({ reattempted: true, status, first_question: parseAssessment(html).question }, flags, {
    lines: [`已重置（HTTP ${status}），现在从第一题开始`],
  });
}

async function cmdAnswer(flags, positional) {
  const id = positional[0];
  if (!id) throw new CnhwError('用法: cnhw answer <assessmentId> [--answers "a1,a2"]', { code: 'USAGE', exitCode: EXIT.USAGE });
  const { base, cid, jar } = client(flags);
  const presets = flags.answers ? String(flags.answers).split('|') : null;

  let url = `${base}/assessment/showtest.php?cid=${cid}&id=${id}`;
  let html = (await fetchPage(url, jar)).html;

  // Single-step mode: submit one answer to the question currently displayed.
  if (flags.value !== undefined) {
    assertAuthed(html, url);
    const info = parseAssessment(html);
    if (!/class=question/.test(html)) {
      throw new CnhwError('当前页面不是题目页（可能已完成）', { code: 'NOT_A_QUESTION' });
    }
    const action = new URL(info.form_action ?? 'showtest.php', url).toString();
    const field = info.answer_input ?? 'qn0';
    const { html: next } = await postForm(action, jar, base, { [field]: String(flags.value), verattempts: info.verattempts });
    const nextInfo = parseAssessment(next);
    const done = !/class=question/.test(next);
    const text = htmlToText(next);
    const score = /([\d.]+)\s*out of\s*([\d.]+)/i.exec(text);
    render(
      {
        submitted: true,
        question: info.question,
        answer: String(flags.value),
        done,
        next: done ? null : { title: nextInfo.title, question: nextInfo.question },
        score: score ? Number(score[1]) : null,
        max_score: score ? Number(score[2]) : null,
      },
      flags,
      { lines: [done ? `已提交，结束：${score ? `${score[1]}/${score[2]}` : '（无分数）'}` : `已提交，下一题：\n${nextInfo.question}`] },
    );
    return;
  }
  for (let step = 0; step < 100; step++) {
    assertAuthed(html, url);
    const info = parseAssessment(html);

    if (!/class=question/.test(html)) {
      const text = htmlToText(html);
      const score = /([\d.]+)\s*out of\s*([\d.]+)/i.exec(text);
      render(
        { finished: true, score: score ? Number(score[1]) : null, max_score: score ? Number(score[2]) : null, url },
        flags,
        { lines: [score ? `结束：${score[1]} / ${score[2]}` : '结束（未解析到分数）', '', text.slice(0, 1200)] },
      );
      return;
    }

    const log = (line) => (useJson(flags) ? process.stderr.write(line + '\n') : print(line));
    log(`\n[${step + 1}] ${info.title}`);
    log(info.question);
    let answer;
    if (presets) {
      answer = presets[step];
      if (answer === undefined) {
        throw new CnhwError('答案数量不足（缺少第 ' + (step + 1) + ' 题）', { code: 'USAGE', exitCode: EXIT.USAGE });
      }
      log(`> ${answer}`);
    } else {
      answer = await readLine('答案（留空=提交空答案，Ctrl-C 退出）: ');
      if (answer === '') {
        const ok = await readLine('确认提交空答案？[y/N] ');
        if (!/^y/i.test(ok)) return;
      }
    }

    const action = new URL(info.form_action ?? 'showtest.php', url).toString();
    const field = info.answer_input ?? 'qn0';
    const fields = { [field]: answer, verattempts: info.verattempts };
    // The POST response IS the next page; do not re-GET it (that restarts).
    ({ html } = await postForm(action, jar, base, fields));
    url = action;
    if (flags.verbose) process.stderr.write(`[answer] POST ${action} -> ${html.length}B\n`);
  }
  throw new CnhwError('超过 100 步，可能页面状态异常', { code: 'LOOP' });
}

const PROBES = [
  '/index.php',
  '/course/course.php?folder=0&cid=115',
  '/course/gradebook.php?cid=115',
  '/course/listusers.php?cid=115',
  '/assessment/showtest.php?cid=115&id=1',
  '/msgs/msglist.php',
  '/forms.php?action=newuser',
];

async function cmdDiscover(flags) {
  const s = loadSession();
  const base = flags.base || s?.base || env('BASE') || DEFAULT_BASE;
  const results = [];
  for (const p of PROBES) {
    try {
      const { status, html } = await fetchPage(`${base}${p}`, s?.jar);
      results.push({ path: p, status, requires_login: !looksLoggedIn(html), bytes: html.length });
    } catch (e) {
      results.push({ path: p, status: null, error: e.code ?? 'ERROR' });
    }
  }
  render(results, flags, {
    table: {
      headers: ['路径', '状态', '需登录', '大小'],
      rows: results.map((r) => [r.path, r.status ?? r.error, r.requires_login ? '是' : '否', r.bytes ?? '']),
    },
  });
}

async function cmdStatus(flags) {
  const s = loadSession();
  const base = flags.base || s?.base || env('BASE') || DEFAULT_BASE;
  const started = Date.now();
  try {
    const { status } = await fetchPage(`${base}/index.php`, s?.jar);
    const report = { base, reachable: true, http_status: status, latency_ms: Date.now() - started, session: s ? 'present' : 'none' };
    render(report, flags, {
      lines: [`${base}  可达 (${status}, ${report.latency_ms}ms)`, `会话: ${report.session}`],
    });
  } catch (e) {
    render({ base, reachable: false, error: e.message }, flags, {
      lines: [`${base}  不可达: ${e.message}`],
    });
  }
}

// ------------------------------------------------------------------ help ----
const HELP = `cnhw — 计算机网络在线作业 (iMATHAS) CLI

用法:
  cnhw login --username <学号>      登录（密码用 CNHW_PASSWORD 或交互输入）
  cnhw logout                       清除本地会话
  cnhw courses                      我选修的课程
  cnhw items [--course 115] [--folder 0]   课程页：资源链接 + 进度表
  cnhw uploads                      已上传的实验报告
  cnhw upload <文件> --report <1-8> [--yes]  上传实验报告（默认 dry-run）
  cnhw download <path> [-o 文件]     下载课件/实验模板
  cnhw ddl [--all]                  作业截止时间（DDL）
  cnhw show <assessmentId>          单次作业/测验概览
  cnhw answer <assessmentId> [--answers "a1|a2"]  逐题作答并提交（真实提交）
  cnhw answer <assessmentId> --value "答案"       只提交当前这题，返回下一题
  cnhw reattempt <assessmentId> --yes             重置测验（清空得分）
  cnhw gradebook                    成绩册
  cnhw get <path> [--raw]           抓任意页面（GB2312 自动转 UTF-8）
  cnhw discover                     探测站点页面
  cnhw status                       连通性/会话检查

选项:
  --course <cid>   课程 ID（默认 115，或 CNHW_CID）
  --folder <n>     课程内目录（默认 0）
  --json           JSON 输出（非 TTY 自动）
  --raw            原样输出 HTML
  --base <url>     覆盖站点根（默认 ${DEFAULT_BASE}）

环境变量:
  CNHW_BASE / CNHW_CID / CNHW_USERNAME / CNHW_PASSWORD / CNHW_CONFIG_DIR

说明:
  登录使用页面内 JS 的哈希: md5(md5(password + '@zju$#') + timestamp)。
  本工具只做读取；提交作业请用网页端。
`;

export async function main(argv = process.argv.slice(2)) {
  let flags = {};
  try {
    const parsed = parseArgv(argv);
    flags = parsed.flags;
    const positional = parsed.positional;
    const cmd = positional.shift();

    if (flags.version || cmd === 'version') { print(`cnhw ${VERSION}`); return EXIT.OK; }
    if (flags.help || !cmd || cmd === 'help') { print(HELP); return EXIT.OK; }

    switch (cmd) {
      case 'login': await cmdLogin(flags); break;
      case 'logout': {
        try { fs.unlinkSync(sessionPath()); print('✓ 已清除本地会话'); }
        catch { print('本地没有会话'); }
        break;
      }
      case 'courses': await cmdCourses(flags); break;
      case 'items': await cmdItems(flags); break;
      case 'ddl': await cmdDdl(flags); break;
      case 'answer': await cmdAnswer(flags, positional); break;
      case 'reattempt': await cmdReattempt(flags, positional); break;
      case 'uploads': await cmdUploads(flags); break;
      case 'upload': await cmdUpload(flags, positional); break;
      case 'download': await cmdDownload(flags, positional); break;
      case 'show': await cmdShow(flags, positional); break;
      case 'gradebook': await cmdGradebook(flags); break;
      case 'get': await cmdGet(flags, positional); break;
      case 'discover': await cmdDiscover(flags); break;
      case 'status': await cmdStatus(flags); break;
      default: throw new CnhwError(`未知命令: ${cmd}（cnhw --help）`, { code: 'USAGE', exitCode: EXIT.USAGE });
    }
    return EXIT.OK;
  } catch (e) {
    const code = e.code ?? 'ERROR';
    const authCodes = new Set(['AUTH_REQUIRED', 'BAD_CREDENTIALS', 'LOGIN_FAILED', 'LOGIN_PAGE']);
    const exitCode = e.exitCode ?? (authCodes.has(code) ? EXIT.AUTH : code === 'NETWORK' ? EXIT.NETWORK : EXIT.ERROR);
    const error = { code, message: e.message };
    if (e.hint) error.hint = e.hint;
    if (useJson(flags)) process.stderr.write(JSON.stringify({ ok: false, error }, null, 2) + '\n');
    else { process.stderr.write(`错误: ${e.message}\n`); if (e.hint) process.stderr.write(`提示: ${e.hint}\n`); }
    return exitCode;
  }
}

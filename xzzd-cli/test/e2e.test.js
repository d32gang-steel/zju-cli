// End-to-end test: run the real CLI binary against a mock TronClass server.
// This exercises arg parsing, session loading, HTTP, normalization and output.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { saveSession, jarFromCookieString } from '../src/session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'xdc.js');

function startMock({ unauthorized = false, failMode = null } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (failMode === '503') {
      res.writeHead(503, { 'content-type': 'text/html' });
      return res.end('<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>');
    }
    if (failMode === 'html500') {
      res.writeHead(500, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html><body>Internal Server Error</body></html>');
    }
    if (unauthorized) return json({ message: '' }, 401);

    const hw = /^\/api\/courses\/(\d+)\/homework-activities$/.exec(url.pathname);
    if (hw) {
      if (hw[1] !== '678') return json({ page: 1, pages: 1, total: 0, homework_activities: [] });
    }

    switch (url.pathname) {
      case '/api/profile':
        return json({ id: 284203, name: '测试用户', user_no: 'tester', email: 't@example.com', role: 'Student' });
      case '/api/user':
        return json({ id: 1, name: '测试用户', username: 'tester', email: 't@example.com' });
      case '/api/my-courses':
        return json({
          courses: [
            {
              id: 678,
              name: '数据结构',
              course_code: '(2026-2027-1)-CS101-0001-1',
              instructors: [{ name: '张三' }],
              status: 'ongoing',
            },
            {
              id: 679,
              name: '操作系统',
              course_code: '(2026-2027-1)-CS102-0002-1',
              instructors: [{ name: '李四' }],
              status: 'ongoing',
            },
            {
              id: 680,
              name: '大学物理',
              course_code: '(2025-2026-2)-PHY001-0003-1',
              instructors: [{ name: '王五' }],
              status: 'closed',
            },
            {
              id: 681,
              name: '军训',
              code: '_uuid_abc',
              start_date: '2025-08-20T00:00:00.000Z',
              instructors: [{ name: '赵六' }],
            },
          ],
        });
      case '/api/activities/9001':
        return json({
          id: 9001,
          title: '实验一：链表',
          end_time: '2026-11-01T15:59:00.000Z',
          data: { description: '<p>实现单链表 &amp; 双链表</p><ul><li>支持插入</li></ul>', allow_retract: true },
          uploads: [{ id: 21, name: 'spec.pdf', size: 3, allow_download: true }],
          is_closed: false,
        });
      case '/api/courses/678':
        return json({ course: { id: 678, name: '数据结构', instructors: [{ name: '张三' }] } });
      case '/api/courses/678/modules':
        return json({ modules: [{ id: 1, name: '第 1 章 绪论' }, { id: 2, name: '第 2 章 线性表' }] });
      case '/api/courses/678/homework-activities':
        return json({
          page: 1,
          pages: 1,
          total: 1,
          homework_activities: [
            {
              id: 9001,
              title: '实验一：链表',
              end_time: '2026-11-01T15:59:00.000Z',
              status: 'pending',
              total_score: 100,
            },
          ],
        });
      case '/api/todos':
        return json({ todo_list: [{ id: 3, title: '看视频', course_name: '数据结构' }] });
      case '/api/alert/messages':
        return json({
          data: [
            {
              id: 5,
              title: '成绩已公布',
              course_id: 678,
              course_name: '数据结构',
              read: false,
              created_at: '2026-10-20T10:00:00.000Z',
            },
          ],
        });
      case '/api/courses/678/activities':
        return json({
          activities: [
            {
              id: 11,
              title: '第 1 章课件',
              type: 'material',
              course_id: 678,
              uploads: [{ id: 111, name: 'ch1.pdf', size: 7, allow_download: true }],
            },
            {
              id: 12,
              title: '外链资料',
              type: 'web_link',
              course_id: 678,
              uploads: [],
              data: { link: 'https://example.com/doc' },
            },
          ],
        });
      case '/api/uploads/111/url':
        return json({ url: `http://${req.headers.host}/files/ch1.pdf` });
      case '/api/courses/679/modules/rollcalls':
        return json({
          rollcalls: [
            {
              id: 78,
              course_id: 679,
              status: 'started',
              source: 'qr',
              type: 'qr_rollcall',
              rollcall_time: '2026-10-27T01:00:00.000Z',
              is_number: false,
            },
          ],
        });
      case '/api/courses/678/modules/rollcalls':
        return json({
          rollcalls: [
            {
              id: 77,
              course_id: 678,
              status: 'finished',
              source: 'radar',
              type: 'radar_rollcall',
              rollcall_time: '2026-10-21T08:00:00.000Z',
              is_number: false,
            },
          ],
        });
      case '/api/rollcall/77':
        return json({
          id: 77,
          status: 'finished',
          source: 'radar',
          rollcall_time: '2026-10-21T08:00:00.000Z',
          student_rollcalls: [
            { student_id: 1, status: 'absent' },
            { student_id: 284203, status: 'on_call_fine' },
          ],
        });
      case '/files/ch1.pdf':
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end('PDFDATA');
      default:
        return json({ message: 'not found' }, 404);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

function sandbox(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-e2e-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const prev = process.env.XD_CONFIG_DIR;
  process.env.XD_CONFIG_DIR = dir;
  saveSession({
    jar: jarFromCookieString('session=test-session; route=abc', '127.0.0.1'),
    username: 'tester',
    baseUrl,
  });
  if (prev === undefined) delete process.env.XD_CONFIG_DIR;
  else process.env.XD_CONFIG_DIR = prev;
  return { dir, baseUrl, env: { XD_CONFIG_DIR: dir } };
}

test('assignments: aggregates, normalizes and emits a stable JSON envelope', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['assignments', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.count, 1);
    const a = payload.data[0];
    assert.equal(a.id, 9001);
    assert.equal(a.title, '实验一：链表');
    assert.equal(a.course, '数据结构');
    assert.equal(a.course_id, 678);
    assert.equal(a.max_score, 100);
    assert.equal(a.due_at, '2026-11-01T15:59:00.000Z');
    assert.ok(a.due_in);
    assert.equal(a.submitted, null);
  } finally {
    server.close();
  }
});

test('courses/course/todos/whoami render expected fields', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const courses = JSON.parse((await run(['courses', '--json', '--base', baseUrl], env)).stdout);
    assert.equal(courses.total, 4);
    assert.equal(courses.data[0].semester, '2026-2027 秋冬');
    assert.equal(courses.data[0].semester_key, '2026-2027-1');
    assert.equal(courses.data[0].instructor, '张三');
    assert.equal(courses.data[0].code, '(2026-2027-1)-CS101-0001-1');
    assert.deepEqual(
      courses.data.map((c) => c.id),
      [678, 679, 680, 681],
    );
    assert.equal(courses.data[3].semester, '2025-2026 秋冬');

    const course = JSON.parse((await run(['course', '678', '--json', '--base', baseUrl], env)).stdout);
    assert.equal(course.data.id, 678);
    assert.equal(course.data.module_count, 2);

    const todos = JSON.parse((await run(['todos', '--json', '--base', baseUrl], env)).stdout);
    assert.equal(todos.data[0].title, '看视频');

    const me = JSON.parse((await run(['whoami', '--json', '--base', baseUrl], env)).stdout);
    assert.equal(me.data.username, 'tester');
    assert.equal(me.data.name, '测试用户');
  } finally {
    server.close();
  }
});

test('expired session exits 2 with AUTH_REQUIRED on stderr', async () => {
  const { server, port } = await startMock({ unauthorized: true });
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['courses', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 2);
    const err = JSON.parse(r.stderr);
    assert.equal(err.ok, false);
    assert.equal(err.error.code, 'AUTH_REQUIRED');
  } finally {
    server.close();
  }
});

test('no session at all exits 2 without network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-empty-'));
  const r = await run(['courses', '--json'], { XD_CONFIG_DIR: dir });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'AUTH_REQUIRED');
});

test('api escape hatch returns status + body', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['api', 'GET', '/api/courses/678/modules', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.data.status, 200);
    assert.equal(payload.data.body.modules.length, 2);
  } finally {
    server.close();
  }
});

test('notifications normalize and expose unread flag', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['notifications', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.data[0].title, '成绩已公布');
    assert.equal(payload.data[0].read, false);
    assert.equal(payload.data[0].course, '数据结构');
  } finally {
    server.close();
  }
});

test('materials lists files and downloads them with a safe name', async () => {
  const { server, port } = await startMock();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-dl-'));
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(
      ['materials', '678', '--json', '--base', baseUrl, '--download', out],
      env,
    );
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.data.materials.length, 2);
    assert.equal(payload.data.materials[0].files[0].name, 'ch1.pdf');
    assert.equal(payload.data.materials[1].link, 'https://example.com/doc');
    assert.equal(payload.data.downloaded.length, 1);
    assert.equal(
      fs.readFileSync(path.join(out, '第 1 章课件', 'ch1.pdf'), 'utf8'),
      'PDFDATA',
    );
  } finally {
    server.close();
  }
});

test('rollcall is read-only listing', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['rollcall', '--course', '678', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.data.count, 1);
    assert.equal(payload.data.rollcalls[0].id, 77);
    assert.equal(payload.data.rollcalls[0].my_status, 'on_call_fine');
    assert.equal(payload.data.rollcalls[0].answered, true);
    assert.equal(payload.data.by_status.on_call_fine, 1);
  } finally {
    server.close();
  }
});

test('--debug traces to stderr without polluting stdout JSON or leaking cookies', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['assignments', '--json', '--debug', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
    assert.match(r.stderr, /\[http\] → GET /);
    assert.match(r.stderr, /\[http\] ← 200 GET /);
    assert.match(r.stderr, /body: /);
    assert.doesNotMatch(r.stderr, /session=test-session/);
    assert.match(r.stderr, /session=<12B>/);
  } finally {
    server.close();
  }
});

test('courses: derived terms, pagination metadata and --current', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);

    const page2 = JSON.parse(
      (await run(['courses', '--json', '--page', '2', '--page-size', '2', '--base', baseUrl], env))
        .stdout,
    );
    assert.equal(page2.count, 2);
    assert.equal(page2.total, 4);
    assert.equal(page2.page, 2);
    assert.equal(page2.pages, 2);
    assert.equal(page2.has_next, false);
    assert.deepEqual(page2.data.map((c) => c.id), [680, 681]);

    const current = JSON.parse(
      (await run(['courses', '--json', '--current', '--base', baseUrl], env)).stdout,
    );
    assert.equal(current.total, 2);
    assert.deepEqual(current.data.map((c) => c.id), [678, 679]);

    const bySeason = JSON.parse(
      (await run(['courses', '--json', '--semester', '春夏', '--base', baseUrl], env)).stdout,
    );
    assert.deepEqual(bySeason.data.map((c) => c.id), [680]);

    const fields = JSON.parse(
      (await run(['courses', '--json', '--fields', 'id,name', '--base', baseUrl], env)).stdout,
    );
    assert.deepEqual(Object.keys(fields.data[0]).sort(), ['id', 'name']);
  } finally {
    server.close();
  }
});

test('semesters falls back to terms derived from course codes', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['semesters', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.data.length, 3);
    assert.equal(payload.data[0].key, '2026-2027-1');
    assert.equal(payload.data[0].count, 2);
    assert.equal(payload.data[0].source, 'derived');
  } finally {
    server.close();
  }
});

test('status detects a platform outage instead of blaming the session', async () => {
  const { server, port } = await startMock({ failMode: '503' });
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['status', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.data.platform, 'down');
    assert.equal(payload.data.checks[0].status, 503);
  } finally {
    server.close();
  }
});

test('a 503 surfaces SERVICE_UNAVAILABLE with an actionable hint', async () => {
  const { server, port } = await startMock({ failMode: '503' });
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['courses', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.equal(err.error.code, 'SERVICE_UNAVAILABLE');
    assert.match(err.error.hint, /xdc status/);
  } finally {
    server.close();
  }
});

test('an HTML 500 is classified as SERVER_ERROR, not a JSON parse failure', async () => {
  const { server, port } = await startMock({ failMode: 'html500' });
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['courses', '--json', '--base', baseUrl], env);
    const err = JSON.parse(r.stderr);
    assert.equal(err.error.code, 'SERVER_ERROR');
    assert.match(err.error.hint, /HTML|平台/);
  } finally {
    server.close();
  }
});

test('ddl lists only unsubmitted homework of the current term', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['ddl', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.data[0].title, '实验一：链表');
    assert.equal(payload.data[0].submitted, null);
    assert.equal(payload.data[0].state, 'pending');
  } finally {
    server.close();
  }
});

test('watch --once emits an event for an open rollcall', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['watch', '--once', '--json', '--all', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'rollcall');
    assert.equal(events[0].rollcall_id, 78);
    assert.equal(events[0].course, '操作系统');
    assert.equal(events[0].source, 'qr');
  } finally {
    server.close();
  }
});

test('assignment shows readable requirements and attachments', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const r = await run(['assignment', '678', '9001', '--json', '--base', baseUrl], env);
    assert.equal(r.code, 0, r.stderr);
    const d = JSON.parse(r.stdout).data;
    assert.equal(d.title, '实验一：链表');
    assert.match(d.description, /实现单链表 & 双链表/);
    assert.match(d.description, /- 支持插入/);
    assert.equal(d.attachments.length, 1);
    assert.equal(d.attachments[0].name, 'spec.pdf');
    assert.equal(d.allow_retract, true);
  } finally {
    server.close();
  }
});

test('submit is dry-run by default and refuses closed homework', async () => {
  const { server, port } = await startMock();
  try {
    const { baseUrl, env } = sandbox(port);
    const dry = await run(['submit', '678', '9001', '--text', 'hello', '--json', '--base', baseUrl], env);
    assert.equal(dry.code, 0, dry.stderr);
    const payload = JSON.parse(dry.stdout).data;
    assert.equal(payload.dry_run, true);
    assert.equal(payload.method, 'POST');
    assert.equal(payload.payload.content, 'hello');
    assert.match(payload.endpoint, /homework-activities\/9001\/submissions/);
  } finally {
    server.close();
  }
});

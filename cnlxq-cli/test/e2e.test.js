import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loginHashes } from '../src/login.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'cnhw.js');
const TS = '1793095256';
const PASS = '5437';

const LOGIN_PAGE = `<html><body><form method="post" action="/network/exercise/course/course.php?folder=0&cid=115">
<input id="username" name="username"><input id="password" name="password">
<input type="hidden" id="timestamp" name="timestamp" value="${TS}"/>
<input type="hidden" id="oldpass" name="oldpass" value=""></form>
<p>Use Student ID as UserName</p></body></html>`;

const INDEX_PAGE = `<html><body>Welcome, 董旭瀛
<a href="course/course.php?folder=0&cid=115">Computer Networks-陆系群-2026</a></body></html>`;

const COURSE_PAGE = `<html><body><a href="../index.php">Home</a>
<a href="/network/download/lab1.doc">Lab1</a>
<a href="../assessment/showtest.php?id=1025&cid=115">Exercise 4</a>
<table>
<tr><td>9月14日-9月27日</td><td>9月21日-10月11日</td></tr>
<tr><td>作业1</td><td>作业2</td></tr>
<tr><td>9月27日</td><td>10月25日</td></tr>
<tr><td>Lab1</td><td>Lab2</td></tr>
</table>
<div class=item><div class=icon>?</div><div class=title><b><a href="../assessment/showtest.php?id=1025&cid=115">Exercise 4 (Chap 4)</a></b><BR> Due Sun 11/8/26, 7:59 am </div>
<div class=itemsum><p>第4次作业(Ch-4)</p></div></div></body></html>`;

const ASSESS_PAGE = `<html><body><h2>Exercise 4 (Chap 4)</h2>
<div class=right>No time limit</div><p>Total Points Possible: 100</p>
<form id="testform" method=post action="showtest.php?action=shownext&score=0">
<div class=question><div> compute N? </div>
<div class="toppad"><label>A: </label><input name=qn0></div><div></div></div>
<div class="review">Points possible: 10</div>
<input type=hidden name="verattempts" value="0" /></form></body></html>`;

const Q2_PAGE = ASSESS_PAGE.replace('compute N?', 'what is the throughput?');
const RESULT_PAGE = `<html><body><h2>Results</h2><p>Your score on this assessment is 10 out of 100.</p></body></html>`;

const UPLOAD_PAGE = `<html><body><table>
<tr><th>Report ID<th>Upload Date<th>FileName<th>FileSize</tr>
<tr><td>1<td>2026-09-26 22:53:30<td>3240105437_1_Lab1.pdf<td>10809942</tr></table>
<form enctype="multipart/form-data" method=post action="upload.php?cid=115">
<select name="reportID"><option value='1'>Lab 1</option><option value='2'>Lab 2</option></select>
<input name="userfile" type="file" /></form></body></html>`;

function startMock() {
  let answerStep = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const authed = /(?:^|;\s*)SID=ok/.test(req.headers.cookie ?? '');
    const html = (body, extra = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra });
      res.end(body);
    };

    if (url.pathname.endsWith('/course/course.php')) {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          const expect = loginHashes(PASS, TS);
          const ok = form.get('username') === '3240105437'
            && form.get('password') === expect.password
            && form.get('oldpass') === expect.oldpass;
          if (ok) return html(COURSE_PAGE, { 'set-cookie': 'SID=ok; Path=/' });
          return html(LOGIN_PAGE.replace('</body>', '<p>Login Error.  Try Again</p></body>'));
        });
        return;
      }
      return html(authed ? COURSE_PAGE : LOGIN_PAGE);
    }
    if (url.pathname.endsWith('/index.php')) return html(authed ? INDEX_PAGE : LOGIN_PAGE);
    if (url.pathname.endsWith('/assessment/showtest.php')) {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          answerStep++;
          return html(authed ? (answerStep >= 2 ? RESULT_PAGE : Q2_PAGE) : LOGIN_PAGE);
        });
        return;
      }
      return html(authed ? ASSESS_PAGE : LOGIN_PAGE);
    }
    if (url.pathname.endsWith('/report/upload.php')) return html(authed ? UPLOAD_PAGE : LOGIN_PAGE);
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

function sandbox(port) {
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cnhw-')), base: `http://127.0.0.1:${port}/network/exercise` };
}

async function loggedIn(port) {
  const { dir, base } = sandbox(port);
  const env = { CNHW_CONFIG_DIR: dir, CNHW_PASSWORD: PASS, CNHW_BASE: base, CNHW_CID: '115' };
  const r = await run(['login', '--username', '3240105437', '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  return { dir, base, env };
}

test('login + courses + items parse the real page shape', async () => {
  const { server, port } = await startMock();
  try {
    const { env } = await loggedIn(port);

    const courses = JSON.parse((await run(['courses', '--json'], env)).stdout);
    assert.equal(courses.data[0].cid, 115);
    assert.match(courses.data[0].name, /Computer Networks/);

    const items = JSON.parse((await run(['items', '--json'], env)).stdout).data;
    assert.deepEqual(items.header, ['9月14日-9月27日', '9月21日-10月11日']);
    assert.equal(items.schedule[0].cells[0], '作业1');
    assert.equal(items.links.length, 2);
    assert.equal(items.links[0].text, 'Lab1');
    assert.equal(items.links[0].kind, 'file');
    assert.equal(items.links[1].id, 1025);
  } finally {
    server.close();
  }
});

test('show exposes points, question and form action', async () => {
  const { server, port } = await startMock();
  try {
    const { env } = await loggedIn(port);
    const r = await run(['show', '1025', '--json'], env);
    assert.equal(r.code, 0, r.stderr);
    const d = JSON.parse(r.stdout).data;
    assert.equal(d.title, 'Exercise 4 (Chap 4)');
    assert.equal(d.points, 100);
    assert.match(d.question, /compute N\?/);
    assert.equal(d.form_action, 'showtest.php?action=shownext&score=0');
    assert.deepEqual(d.inputs, ['qn0', 'verattempts']);
  } finally {
    server.close();
  }
});

test('uploads lists submitted reports', async () => {
  const { server, port } = await startMock();
  try {
    const { env } = await loggedIn(port);
    const r = await run(['uploads', '--json'], env);
    assert.equal(r.code, 0, r.stderr);
    const d = JSON.parse(r.stdout).data;
    assert.equal(d.files.length, 1);
    assert.equal(d.files[0].filename, '3240105437_1_Lab1.pdf');
    assert.equal(d.reports.length, 2);
  } finally {
    server.close();
  }
});

test('upload is dry-run unless --yes', async () => {
  const { server, port } = await startMock();
  try {
    const { env, dir } = await loggedIn(port);
    const file = path.join(dir, 'lab3.pdf');
    fs.writeFileSync(file, 'PDFDATA');
    const r = await run(['upload', file, '--report', '3', '--json'], env);
    assert.equal(r.code, 0, r.stderr);
    const d = JSON.parse(r.stdout).data;
    assert.equal(d.dry_run, true);
    assert.equal(d.report_id, 3);
    assert.equal(d.size, 7);
  } finally {
    server.close();
  }
});

test('wrong password exits 2 with BAD_CREDENTIALS', async () => {
  const { server, port } = await startMock();
  try {
    const { dir, base } = sandbox(port);
    const env = { CNHW_CONFIG_DIR: dir, CNHW_PASSWORD: 'nope', CNHW_BASE: base, CNHW_CID: '115' };
    const r = await run(['login', '--username', '3240105437', '--json'], env);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stderr).error.code, 'BAD_CREDENTIALS');
  } finally {
    server.close();
  }
});

test('items without a session exits 2', async () => {
  const { server, port } = await startMock();
  try {
    const { dir, base } = sandbox(port);
    const env = { CNHW_CONFIG_DIR: dir, CNHW_BASE: base, CNHW_CID: '115' };
    const r = await run(['items', '--json'], env);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stderr).error.code, 'AUTH_REQUIRED');
  } finally {
    server.close();
  }
});

test('ddl parses due dates from course page cards', async () => {
  const { server, port } = await startMock();
  try {
    const { env } = await loggedIn(port);
    const r = await run(['ddl', '--json'], env);
    assert.equal(r.code, 0, r.stderr);
    const d = JSON.parse(r.stdout).data;
    const byTitle = (t) => d.find((x) => x.title === t);
    const ex4 = byTitle('Exercise 4 (Chap 4)');
    assert.equal(ex4.due_at, '2026-11-07T23:59:00.000Z'); // 11/8 07:59 +08
    assert.match(ex4.due_in, /天/);

    const hw1 = byTitle('作业1');
    assert.equal(hw1.kind, 'homework');
    assert.equal(hw1.due_at, '2026-09-27T15:59:00.000Z'); // 23:59 +08

    const lab1 = byTitle('Lab1');
    assert.equal(lab1.kind, 'lab_report');
    assert.equal(lab1.submitted, true); // UPLOAD_PAGE lists report 1
    const lab2 = byTitle('Lab2');
    assert.equal(lab2.submitted, false);
  } finally {
    server.close();
  }
});

test('answer walks pages with provided answers and reports the score', async () => {
  const { server, port } = await startMock();
  try {
    const { env } = await loggedIn(port);
    const r = await run(['answer', '1025', '--answers', '42|100', '--json'], env);
    assert.equal(r.code, 0, r.stderr);
    const d = JSON.parse(r.stdout).data;
    assert.equal(d.finished, true);
    assert.equal(d.score, 10);
    assert.equal(d.max_score, 100);
    assert.match(r.stderr, /compute N\?/);
    assert.match(r.stderr, /throughput/);
  } finally {
    server.close();
  }
});

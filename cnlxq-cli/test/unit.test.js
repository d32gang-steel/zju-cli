import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decodeBody } from '../src/http.js';
import { extractTimestamp, loginHashes, looksLoggedIn } from '../src/login.js';
import {
  classifyHref,
  htmlToText,
  parseAssessment,
  parseCoursePage,
  parseCourseItems,
  parseCourses,
  parseScheduleDeadlines,
  parseDue,
  parseGradebook,
  parseUploads,
} from '../src/parse.js';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

test('login hashes match the page JS (md5(md5(pw + salt) + ts))', () => {
  const ts = '1793095256';
  const pw = 'secret123';
  const h = loginHashes(pw, ts);
  assert.equal(h.password, md5(md5(pw + '@zju$#') + ts));
  assert.equal(h.oldpass, md5(pw));
});

test('login page detection and timestamp extraction', () => {
  assert.equal(extractTimestamp('<input id="timestamp" name="timestamp" value="1793095256"/>'), '1793095256');
  assert.equal(extractTimestamp('<p>x</p>'), null);
  assert.equal(looksLoggedIn('<a href="actions.php?action=logout">Log Out</a>'), true);
  assert.equal(looksLoggedIn('Use Student ID as UserName'), false);
});

test('GB2312 bodies are decoded to UTF-8', () => {
  assert.equal(decodeBody(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'text/html; charset=gb2312'), '中文');
});

test('course list comes from index.php links', () => {
  const html = `<a href="course/course.php?folder=0&cid=115">Computer Networks-陆系群-2026</a>
                <a href="course/course.php?cid=116">Another</a>`;
  const courses = parseCourses(html);
  assert.equal(courses.length, 2);
  assert.equal(courses[0].cid, 115);
  assert.match(courses[0].name, /Computer Networks/);
});

test('course page: schedule header, rows and filtered links', () => {
  const html = `<a href="../index.php">Home</a>
    <a href="/network/download/lab1.doc">Lab1</a>
    <a href="../assessment/showtest.php?id=1025&cid=115">Exercise 4</a>
    <a href="../actions.php?action=logout">Log Out</a>
    <table>
      <tr><td>9月14日-9月27日</td><td>9月21日-10月11日</td></tr>
      <tr><td>作业1</td><td>作业2</td></tr>
      <tr><td>Lab1</td><td>Lab2</td></tr>
    </table>`;
  const page = parseCoursePage(html);
  assert.deepEqual(page.header, ['9月14日-9月27日', '9月21日-10月11日']);
  assert.equal(page.schedule.length, 2);
  assert.equal(page.schedule[0].cells[0], '作业1');
  assert.equal(page.links.length, 2); // Home / Log Out filtered
  assert.equal(page.links[0].kind, 'file');
  assert.equal(page.links[1].kind, 'assessment');
  assert.equal(page.links[1].id, 1025);
  assert.equal(classifyHref('/x/gradebook.php?cid=1'), 'gradebook');
});

test('assessment page: title, points, question, form fields', () => {
  const html = `<h2>Exercise 4 (Chap 4)</h2>
    <div class=right>No time limit</div>
    <p>Total Points Possible: 100</p>
    <form id="testform" method=post action="showtest.php?action=shownext&score=0">
      <div class=question><div> compute N? </div>
        <div class="toppad"><label>A: </label><input name=qn0></div><div></div></div>
      <div class="review">Points possible: 10<br/></div>
      <input type=hidden name="verattempts" value="0" />
    </form>`;
  const a = parseAssessment(html);
  assert.equal(a.title, 'Exercise 4 (Chap 4)');
  assert.equal(a.points, 100);
  assert.equal(a.time_limit_minutes, null);
  assert.match(a.question, /compute N\?/);
  assert.equal(a.form_action, 'showtest.php?action=shownext&score=0');
  assert.deepEqual(a.inputs, ['qn0', 'verattempts']);
  assert.equal(a.verattempts, '0');
  assert.equal(a.answer_input, 'qn0');
});

test('upload page: td without closing tags + report options', () => {
  const html = `<table><tr><th>Report ID<th>Upload Date<th>FileName<th>FileSize</tr>
    <tr><td>1<td>2026-09-26 22:53:30<td>3240105437_1_Lab1.pdf<td>10809942</tr></table>
    <select name="reportID"><option value='1'>Lab 1</option><option value='2'>Lab 2</option></select>`;
  const { files, reports } = parseUploads(html);
  assert.equal(files.length, 1);
  assert.equal(files[0].report_id, 1);
  assert.equal(files[0].size, 10809942);
  assert.equal(reports.length, 2);
  assert.equal(reports[1].label, 'Lab 2');
});

test('gradebook rows become objects keyed by header', () => {
  const html = `<table><tr><th>Item<th>Possible<th>Grade<th>Percent</tr>
    <tr><td>Quiz 1<td>50 pts<td>45<td>90%</tr></table>`;
  const rows = parseGradebook(html);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { Item: 'Quiz 1', Possible: '50 pts', Grade: '45', Percent: '90%' });
});

test('htmlToText keeps structure', () => {
  assert.match(htmlToText('<p>a &amp; b</p><ul><li>one</li></ul>'), /a & b[\s\S]*- one/);
});

test('assessment cards: due date parsing (Shanghai time)', () => {
  const html = `<div class=item><div class=icon>?</div><div class=title>
    <b><a href="../assessment/showtest.php?id=1025&cid=115">Exercise 4 (Chap 4)</a></b>
    <BR> Due Sun 11/8/26, 7:59 am </div>
    <div class=itemsum><p>第4次作业(Ch-4)</p></div></div>`;
  const items = parseCourseItems(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Exercise 4 (Chap 4)');
  assert.equal(items[0].id, 1025);
  assert.equal(items[0].due_text, 'Sun 11/8/26, 7:59 am');
  assert.equal(items[0].due_at, '2026-11-07T23:59:00.000Z');
  assert.equal(items[0].summary, '第4次作业(Ch-4)');
  assert.equal(parseDue('12/30/26, 11:59 pm'), '2026-12-30T15:59:00.000Z');
  assert.equal(parseDue('no date'), null);
});

test('radio questions expose field name and option values', () => {
  const html = `<form action="showtest.php?action=shownext"><div class=question>
    <div> pick one </div>
    <div class="toppad"><ul class=nomark>
      <li><input type=radio name=qn3 value=0 >first</li>
      <li><input type=radio name=qn3 value=1 >second</li>
    </ul></div><div></div></div>
    <div class="review">Points possible: 10</div></form>`;
  const a = parseAssessment(html);
  assert.equal(a.answer_input, 'qn3');
  assert.deepEqual(a.options, [
    { value: '0', label: 'first' },
    { value: '1', label: 'second' },
  ]);
  assert.match(a.question, /pick one/);
});

test('schedule table yields homework and lab deadlines', () => {
  const html = `<table>
    <tr><td>9月14日-9月27日</td><td>9月21日-10月11日</td></tr>
    <tr><td>作业1</td><td>作业2</td></tr>
    <tr><td>9月27日</td><td>10月25日</td></tr>
    <tr><td>Lab1</td><td>Lab2</td></tr>
  </table>`;
  const items = parseScheduleDeadlines(html, { year: 2026 });
  assert.equal(items.length, 4);
  assert.equal(items[0].kind, 'homework');
  assert.equal(items[0].title, '作业1');
  assert.equal(items[0].due_at, '2026-09-27T15:59:00.000Z');
  assert.equal(items[2].kind, 'lab_report');
  assert.equal(items[2].report_id, 1);
  assert.equal(items[3].due_at, '2026-10-25T15:59:00.000Z');
});

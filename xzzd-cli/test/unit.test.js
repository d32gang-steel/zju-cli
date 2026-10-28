import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { CookieJar } from '../src/http.js';
import { redactBody, redactHeader, redactUrl } from '../src/debug.js';
import { classifyFailure, looksLikeHtml } from '../src/health.js';
import {
  compareCourses,
  deriveTerms,
  groupBySemester,
  inferSemesterFromDate,
  matchesSemester,
  parseSemesterFromCode,
  parseSemesterLabel,
  pickCurrentSemesterKey,
  pickCurrentSemesterKeys,
  semesterOrder,
  semesterStartDate,
} from '../src/terms.js';
import { encryptPassword } from '../src/cas.js';
import { jarFromCookieString } from '../src/session.js';
import {
  findArray,
  normalizeObject,
  htmlToText,
  normAssignment,
  normCourse,
  normTodo,
  toIso,
  humanizeDelta,
} from '../src/api.js';

function modPow(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

// Vector produced by running zjuam's own js/login/security.js with this key.
const GOLDEN = {
  n: 'c321df24f8edfab6336696afb1596427239468d7774f2af2eab23d88211c67b75d76e514ab23db3d7954d8d34a2b7c18cb79a99dabc6c09caa8c060375ebc315',
  e: '010001',
  plain: 'Passw0rd',
  expected:
    '557dcca27a873292861b5c7c44cd685a15525f5cd4c3b72892926eee46abea681fbc5d4b1fdc43bf46b1be234c64a3d6eb7215cae34ff4ccbd470930f3f61a92',
};

test('encryptPassword matches the university JS byte-for-byte (golden vector)', () => {
  assert.equal(encryptPassword(GOLDEN.plain, GOLDEN.n, GOLDEN.e), GOLDEN.expected);
});

test('non-ASCII passwords are rejected explicitly', () => {
  assert.throws(
    () => encryptPassword('密码123', GOLDEN.n, GOLDEN.e),
    (e) => e.code === 'NON_ASCII_PASSWORD',
  );
});

test('raw RSA round-trip: decrypting yields reverse(password)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 512 });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const nHex = Buffer.from(pub.n, 'base64url').toString('hex');
  const eHex = Buffer.from(pub.e, 'base64url').toString('hex');
  const dHex = Buffer.from(priv.d, 'base64url').toString('hex');

  const enc = encryptPassword('s3cret-Pass', nHex, eHex);
  assert.equal(enc.includes(' '), false);

  const m = modPow(BigInt('0x' + enc), BigInt('0x' + dHex), BigInt('0x' + nHex));
  let hex = m.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  // Little-endian blocks: reversing the big-endian bytes restores the string.
  const text = Buffer.from(hex, 'hex').reverse().toString('utf8').replace(/\0+$/, '');
  assert.equal(text, 'ssaP-terc3s');
});

test('raw RSA is deterministic and chunks long passwords like security.js', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 512 });
  const pub = publicKey.export({ format: 'jwk' });
  const nHex = Buffer.from(pub.n, 'base64url').toString('hex');
  const eHex = Buffer.from(pub.e, 'base64url').toString('hex');

  assert.equal(encryptPassword('abc', nHex, eHex), encryptPassword('abc', nHex, eHex));

  // 512-bit modulus -> chunkSize 62; 70 chars => 2 blocks joined by a space.
  const long = 'x'.repeat(70);
  const blocks = encryptPassword(long, nHex, eHex).split(' ');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].length, 128);
});

test('cookie jar scopes cookies by domain and path', () => {
  const jar = new CookieJar();
  jar.addFromResponse('https://courses.zju.edu.cn/user/index', {
    headers: {
      getSetCookie: () => [
        'session=abc123; Path=/; Secure; HttpOnly',
        'route=xyz; Path=/',
      ],
    },
  });
  assert.equal(jar.headerFor('https://courses.zju.edu.cn/api/user'), 'session=abc123; route=xyz');

  jar.addFromResponse('https://identity.zju.edu.cn/auth/realms/xdc/protocol/cas/login', {
    headers: { getSetCookie: () => ['AUTH_SESSION_ID=kc1; Path=/auth/realms/xdc/; HttpOnly'] },
  });
  assert.match(jar.headerFor('https://identity.zju.edu.cn/auth/realms/xdc/broker'), /AUTH_SESSION_ID=kc1/);
  assert.doesNotMatch(jar.headerFor('https://identity.zju.edu.cn/other'), /AUTH_SESSION_ID/);
  assert.doesNotMatch(jar.headerFor('https://courses.zju.edu.cn/api/user'), /AUTH_SESSION_ID/);
});

test('expired cookies are dropped', () => {
  const jar = new CookieJar();
  jar.addFromResponse('https://courses.zju.edu.cn/', {
    headers: { getSetCookie: () => ['old=1; Max-Age=0; Path=/', 'keep=2; Path=/'] },
  });
  assert.equal(jar.headerFor('https://courses.zju.edu.cn/'), 'keep=2');
});

test('cookie header string import tolerates "Cookie:" prefix and newlines', () => {
  const jar = jarFromCookieString('Cookie: a=1; b=2\nc=3');
  assert.equal(jar.headerFor('https://courses.zju.edu.cn/'), 'a=1; b=2; c=3');
});

test('toIso handles epochs and strings', () => {
  assert.equal(toIso(1700000000), '2023-11-14T22:13:20.000Z');
  assert.equal(toIso(1700000000000), '2023-11-14T22:13:20.000Z');
  assert.equal(toIso('2026-10-30T23:59:00+08:00'), '2026-10-30T15:59:00.000Z');
  assert.equal(toIso('not a date'), null);
  assert.equal(toIso(''), null);
});

test('humanizeDelta renders Chinese relative time', () => {
  const now = Date.parse('2026-10-27T00:00:00Z');
  assert.equal(humanizeDelta(now + 2 * 86400000, now), '2天');
  assert.equal(humanizeDelta(now + 3 * 3600000, now), '3小时');
  assert.equal(humanizeDelta(now - 2 * 86400000, now), '已过 2天');
});

test('findArray finds the wrapped list under common keys', () => {
  assert.deepEqual(findArray({ courses: [{ id: 1 }] }, ['courses']), [{ id: 1 }]);
  assert.deepEqual(findArray({ data: { courses: [{ id: 2 }] } }, ['courses']), [{ id: 2 }]);
  assert.deepEqual(findArray({ data: [{ id: 3 }] }, ['courses']), [{ id: 3 }]);
  assert.deepEqual(findArray({ nothing: 1 }), []);
});

test('normalizeObject unwraps data/course wrappers', () => {
  assert.deepEqual(normalizeObject({ course: { id: 1 } }, ['course']), { id: 1 });
  assert.deepEqual(normalizeObject({ data: { id: 2 } }, ['course']), { id: 2 });
  assert.deepEqual(normalizeObject({ id: 3 }), { id: 3 });
});

test('normCourse flattens nested semester/instructor objects', () => {
  const c = normCourse({
    id: 42,
    name: '数据结构',
    course_code: 'CS101',
    semester: { id: 7, name: '2026-2027 秋冬' },
    instructors: [{ name: '张三' }, { name: '李四' }],
    status: 'ongoing',
    start_date: '2026-09-01',
  });
  assert.equal(c.id, 42);
  assert.equal(c.semester, '2026-2027 秋冬');
  assert.equal(c.instructor, '张三, 李四');
  assert.equal(c.code, 'CS101');
});

test('normAssignment derives submitted/overdue/due_in', () => {
  const a = normAssignment(
    { id: 9, title: '实验一', end_time: '2020-01-01T00:00:00Z', submission: { id: 1 } },
    { id: 42, name: '数据结构' },
  );
  assert.equal(a.id, 9);
  assert.equal(a.course, '数据结构');
  assert.equal(a.course_id, 42);
  assert.equal(a.submitted, true);
  assert.equal(a.overdue, false);

  const b = normAssignment(
    { id: 10, title: '实验二', due_at: '2020-01-01T00:00:00Z' },
    { id: 42, name: '数据结构' },
  );
  assert.equal(b.submitted, null);
  assert.equal(b.overdue, true);
  assert.match(b.due_in, /^已过/);
});

test('normTodo maps fields', () => {
  const t = normTodo({ id: 1, title: '看视频', course_name: '高数', due_at: '2030-01-01T00:00:00Z' });
  assert.equal(t.title, '看视频');
  assert.equal(t.course, '高数');
  assert.match(t.due_in, /天/);
});

test('debug redaction masks cookies, tickets and passwords', () => {
  assert.equal(redactHeader('cookie', 'session=abc123; route=xyz'), 'session=<6B>; route=<3B>');
  assert.equal(redactHeader('set-cookie', 'sess=deadbeef'), '<redacted 13B>');
  assert.equal(redactHeader('accept', 'application/json'), 'application/json');

  const url = redactUrl('https://zjuam.zju.edu.cn/cas/login?service=x&ticket=ST-123456&page=1');
  assert.doesNotMatch(url, /ST-123456/);
  assert.match(url, /page=1/);
  assert.match(url, /ticket=/);

  assert.equal(
    redactBody('username=bob&password=c2VjcmV0&execution=abc', 'application/x-www-form-urlencoded'),
    'username=bob&password=<redacted>&execution=abc',
  );
  assert.equal(redactBody('{"a":1}', 'application/json'), '{"a":1}');
});

test('semester parsing: codes, fallback dates, ordering', () => {
  assert.deepEqual(parseSemesterFromCode('(2026-2027-1)-CSE3023M-0016235-1'), {
    key: '2026-2027-1',
    academic_year: '2026-2027',
    name: '2026-2027 秋冬',
    start_year: 2026,
    end_year: 2027,
    term: 1,
    half: null,
  });
  assert.equal(parseSemesterFromCode('(2026-2027-2)-CS100-1-1').name, '2026-2027 春夏');
  assert.equal(parseSemesterFromCode('_uuid_0ee20816'), null);
  assert.equal(parseSemesterFromCode('xinshen2024'), null);
  assert.equal(parseSemesterFromCode('(2026-2029-1)-x'), null);

  // Half-semesters: 秋/冬 are parts of 秋冬, 春/夏 of 春夏. Not duplicates.
  assert.equal(parseSemesterLabel('2026-2027秋').key, '2026-2027-1A');
  assert.equal(parseSemesterLabel('2026-2027冬').key, '2026-2027-1B');
  assert.equal(parseSemesterLabel('2026-2027春').key, '2026-2027-2A');
  assert.equal(parseSemesterLabel('2026-2027夏').key, '2026-2027-2B');
  assert.equal(parseSemesterLabel('2026-2027短').key, '2026-2027-4');
  assert.equal(parseSemesterLabel('2026-2027秋冬').key, '2026-2027-1');
  // Display order mirrors the tenant's `sort`: 秋冬 above 秋, 春 above 夏.
  assert.ok(semesterOrder('2026-2027-1') > semesterOrder('2026-2027-1A'));
  assert.ok(semesterOrder('2026-2027-1A') > semesterOrder('2026-2027-1B'));
  assert.ok(semesterOrder('2026-2027-1B') > semesterOrder('2026-2027-2'));

  assert.equal(inferSemesterFromDate('2025-08-20T00:00:00Z').name, '2025-2026 秋冬');
  assert.equal(inferSemesterFromDate('2026-02-03T00:00:00Z').name, '2025-2026 春夏');
  assert.equal(inferSemesterFromDate('2024-06-25T00:00:00Z').name, '2024-2025 秋冬');
  assert.equal(inferSemesterFromDate(null), null);
});

test('current term is the latest one that has started', () => {
  const now = Date.parse('2026-10-27T00:00:00Z');
  const courses = [
    { id: 1, semester_key: '2026-2027-1', start_date: null },
    { id: 2, semester_key: '2025-2026-2', start_date: null },
    { id: 3, semester_key: '2025-2026-1', start_date: '2025-08-20T00:00:00Z' },
  ];
  assert.equal(pickCurrentSemesterKey(courses, now), '2026-2027-1');
  // Full-year + half-term courses are all "current".
  const withHalf = [...courses, { id: 4, semester_key: '2026-2027-1A', start_date: null }];
  assert.deepEqual(
    [...pickCurrentSemesterKeys(withHalf, now)].sort(),
    ['2026-2027-1', '2026-2027-1A'],
  );
  assert.equal(semesterStartDate('2026-2027-1').toISOString(), '2026-09-01T00:00:00.000Z');
  // Before the term starts, fall back to the previous one.
  assert.equal(
    pickCurrentSemesterKey(courses, Date.parse('2026-07-01T00:00:00Z')),
    '2025-2026-2',
  );
});

test('grouping and filtering by semester', () => {
  const courses = [
    { id: 1, name: 'a', semester_key: '2025-2026-2', semester: '2025-2026 春夏', start_date: null },
    { id: 2, name: 'b', semester_key: '2026-2027-1', semester: '2026-2027 秋冬', start_date: null },
    { id: 3, name: 'c', semester: null, semester_key: null, start_date: null },
  ].sort(compareCourses);
  assert.deepEqual(courses.map((c) => c.id), [2, 1, 3]);

  const groups = groupBySemester(courses);
  assert.deepEqual(groups.map((g) => g.key), ['2026-2027-1', '2025-2026-2', null]);
  assert.equal(groups[0].count, 1);

  const c = courses[0];
  assert.ok(matchesSemester(c, '2026-2027'));
  assert.ok(matchesSemester(c, '秋冬'));
  assert.ok(matchesSemester(c, '2026-2027-1'));
  assert.ok(!matchesSemester(c, '2025-2026'));

  const terms = deriveTerms(courses, Date.parse('2026-10-27T00:00:00Z'));
  assert.equal(terms[0].key, '2026-2027-1');
  assert.equal(terms[0].current, true);
  assert.equal(terms[0].count, 1);
});

test('upstream failures are classified for the user', () => {
  assert.equal(classifyFailure(200, 'application/json', '{}'), null);
  assert.equal(classifyFailure(403, 'application/json', '{}'), null);

  assert.equal(classifyFailure(0, '', '').code, 'NETWORK');
  assert.equal(classifyFailure(502, 'text/html', '<html>').code, 'SERVICE_UNAVAILABLE');
  assert.equal(classifyFailure(503, '', '').code, 'SERVICE_UNAVAILABLE');
  assert.equal(classifyFailure(500, 'text/html', '<!doctype html><html>').code, 'SERVER_ERROR');
  assert.match(classifyFailure(503, '', '').hint, /xdc status/);

  assert.ok(looksLikeHtml('text/html', ''));
  assert.ok(looksLikeHtml('', '<html><body>'));
  assert.ok(!looksLikeHtml('application/json', '{"a":1}'));
});

test('htmlToText keeps structure and decodes entities', () => {
  const text = htmlToText('<p>a &amp; b</p><ul><li>one</li><li>two</li></ul><p>line<br>break</p>');
  assert.match(text, /a & b/);
  assert.match(text, /- one/);
  assert.match(text, /- two/);
  assert.match(text, /line\nbreak/);
  assert.equal(htmlToText(''), null);
  assert.equal(htmlToText('<p>&#39;quoted&#39;</p>'), "'quoted'");
});

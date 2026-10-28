// TronClass / 学在浙大 (courses.zju.edu.cn) API client + response normalizers.
//
// The API is plain JSON (no envelope) and authenticates with the CAS session
// cookie. Requests must look like XHR (Accept + X-Requested-With), otherwise
// unauthenticated calls get an HTML redirect instead of a 401.

import { request } from './http.js';
import { classifyFailure } from './health.js';
import { inferSemesterFromDate, parseSemesterFromCode, parseSemesterLabel } from './terms.js';

export const DEFAULT_BASE = 'https://courses.zju.edu.cn';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'API_ERROR', body, hint } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.hint = hint;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Api {
  constructor({ baseUrl = DEFAULT_BASE, jar, timeoutMs = 30000, retries = 2, onAuthRequired, verbose = false } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.jar = jar;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    // Optional async () => CookieJar|null hook, used to transparently re-login.
    this.onAuthRequired = onAuthRequired;
    this.verbose = verbose;
  }

  url(path, query) {
    const u = new URL(path.startsWith('http') ? path : this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return u.toString();
  }

  /** Low-level call. Returns { status, ok, json, text, headers }. */
  async call(method, path, opts = {}) {
    const { query, json, form, headers = {}, timeoutMs } = opts;
    const url = this.url(path, query);
    const h = {
      accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      referer: `${this.baseUrl}/user/index`,
      ...headers,
    };
    let body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }

    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let res;
      try {
        ({ res } = await request(url, {
          method,
          headers: h,
          body,
          jar: this.jar,
          timeoutMs: timeoutMs ?? this.timeoutMs,
        }));
      } catch (e) {
        lastErr = e;
        if (attempt < this.retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        const hint = classifyFailure(0)?.hint;
        throw new ApiError(`网络请求失败: ${e.message}`, { code: 'NETWORK', hint });
      }

      if (this.verbose) {
        process.stderr.write(`[api] ${method} ${url.replace(this.baseUrl, '')} -> ${res.status}\n`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const bodyText = buf.toString('utf8');
      let parsed;
      const ctype = res.headers.get('content-type') ?? '';
      if (/json/i.test(ctype) || /^[\s]*[{[]/.test(bodyText)) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          parsed = undefined;
        }
      }

      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 600 * (attempt + 1));
        continue;
      }

      if (res.status === 401) {
        if (!opts._retried && this.onAuthRequired) {
          const freshJar = await this.onAuthRequired();
          if (freshJar) {
            this.jar = freshJar;
            return this.call(method, path, { ...opts, _retried: true });
          }
        }
        throw new ApiError('未登录或会话已过期', {
          status: 401,
          code: 'AUTH_REQUIRED',
          hint: '运行 `xdc login` 重新登录（或 `xdc login --cookie "..."` 导入浏览器会话）',
        });
      }
      if (res.status === 403) {
        throw new ApiError('无权限访问该资源', {
          status: 403,
          code: 'FORBIDDEN',
          hint: '可能不是该课程成员，或需要更高角色',
          body: bodyText.slice(0, 300),
        });
      }
      if (res.status === 404) {
        throw new ApiError(`接口不存在: ${path}`, {
          status: 404,
          code: 'NOT_FOUND',
          hint: '用 `xdc discover` 或 `xdc api GET <path>` 排查',
          body: bodyText.slice(0, 300),
        });
      }
      const upstream = classifyFailure(res.status, ctype, bodyText);
      if (upstream) {
        throw new ApiError(`学在浙大服务异常 (HTTP ${res.status})`, {
          status: res.status,
          code: upstream.code,
          hint: upstream.hint,
          body: bodyText.slice(0, 300),
        });
      }
      if (!res.ok) {
        let msg = res.statusText;
        if (parsed && typeof parsed.message === 'string' && parsed.message) msg = parsed.message;
        throw new ApiError(`API ${res.status}: ${msg}`, {
          status: res.status,
          code: 'HTTP_ERROR',
          body: bodyText.slice(0, 500),
        });
      }

      return { status: res.status, ok: res.ok, json: parsed, text: bodyText, headers: res.headers };
    }
    throw new ApiError(`请求失败: ${lastErr?.message ?? '未知错误'}`, { code: 'NETWORK' });
  }

  async getJson(path, opts = {}) {
    const r = await this.call('GET', path, opts);
    if (r.json === undefined) {
      throw new ApiError('响应不是 JSON（可能是登录页或平台错误页）', {
        code: 'NOT_JSON',
        body: r.text.slice(0, 300),
        hint: '若浏览器也异常，说明平台故障（`xdc status` 可确认）；否则会话失效，运行 `xdc login`',
      });
    }
    return r.json;
  }

  // ---- resources -------------------------------------------------------

  whoami() {
    // /api/user is teacher/admin only on this tenant; /api/profile is the
    // student-facing "me" endpoint.
    return this.getJson('/api/profile');
  }

  async myCourses() {
    // The endpoint is paginated (default page_size is small on some tenants).
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const j = await this.getJson('/api/my-courses', { query: { page, page_size: 200 } });
      const list = findArray(j, ['courses', 'my_courses']);
      all.push(...list);
      const pages = Number(j?.pages ?? 1);
      if (page >= pages || !list.length) break;
    }
    const list = normalizeCourses(all);
    // Some course objects omit semester.name; fill it from /api/my-semesters
    // so half-term (秋/冬) labels survive.
    if (list.some((c) => c.semester_id && !c.semester)) {
      try {
        const sems = await this.mySemesters();
        const byId = new Map(sems.map((s) => [s.id, s]));
        for (const c of list) {
          const sem = byId.get(c.semester_id);
          if (!sem) continue;
          const parsed = parseSemesterLabel(sem.name);
          c.semester = sem.name;
          c.semester_key = parsed?.key ?? c.semester_key;
          c.academic_year = parsed?.academic_year ?? c.academic_year;
          c.term = parsed?.term ?? c.term;
          c.half = parsed?.half ?? null;
        }
      } catch {
        // best effort only
      }
    }
    return list;
  }

  async mySemesters() {
    return findArray(await this.getJson('/api/my-semesters'), ['semesters']).map(normSemester);
  }

  async courseDetail(courseId) {
    const raw = normalizeObject(await this.getJson(`/api/courses/${courseId}`), ['course']);
    const norm = normCourse(raw);
    return { ...norm, raw };
  }

  async courseModules(courseId) {
    const j = await this.getJson(`/api/courses/${courseId}/modules`);
    return findArray(j, ['modules', 'course_modules']);
  }

  /** All homework activities of one course, paginated. */
  async homeworkActivities(courseId, { pageSize = 100, maxPages = 50 } = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const j = await this.getJson(`/api/courses/${courseId}/homework-activities`, {
        query: { page, page_size: pageSize },
      });
      const items = findArray(j, ['homework_activities', 'activities']);
      all.push(...items);
      const pages = Number(j?.pages ?? 0);
      const total = Number(j?.total ?? 0);
      if (!items.length) break;
      if (pages && page >= pages) break;
      if (total && all.length >= total) break;
      if (!pages && !total && items.length < pageSize) break;
    }
    return all;
  }

  async homeworkDetail(courseId, activityId) {
    // On this tenant the course-scoped detail is 404; /api/activities/{id} works.
    try {
      return await this.getJson(`/api/activities/${activityId}`);
    } catch (e) {
      if (e.code === 'NOT_FOUND' || e.status === 404) {
        return this.getJson(`/api/courses/${courseId}/homework-activities/${activityId}`);
      }
      throw e;
    }
  }

  /** Submit text content to a homework activity (endpoint unverified on ZJU). */
  async submitHomework(courseId, activityId, content) {
    return this.call('POST', `/api/courses/${courseId}/homework-activities/${activityId}/submissions`, {
      json: { content },
    });
  }

  async todos() {
    return findArray(await this.getJson('/api/todos'), ['todo_list', 'todos']);
  }

  async announcements(courseId) {
    // TronClass calls course announcements "bulletins".
    return findArray(await this.getJson(`/api/courses/${courseId}/bulletins`), [
      'bulletins',
      'announcements',
    ]);
  }

  async latestAnnouncements() {
    return findArray(await this.getJson('/api/bulletins/latest'), ['bulletins']);
  }

  async notifications() {
    return findArray(await this.getJson('/api/alert/messages', { query: { page: 1, page_size: 50 } }), [
      'data',
      'notifications',
      'messages',
    ]);
  }

  async courseActivities(courseId) {
    return findArray(
      await this.getJson(`/api/courses/${courseId}/activities`, { query: { sub_course_id: 0 } }),
      ['activities'],
    );
  }

  /**
   * There is no /materials endpoint: learning materials are activities whose
   * type is material / page / web_link (with `uploads` attached).
   */
  async courseMaterials(courseId) {
    const acts = await this.courseActivities(courseId);
    return acts.filter((a) =>
      ['material', 'page', 'web_link', 'document', 'file', 'video', 'audio'].includes(a.type),
    );
  }

  /** Signed download URL for an upload (host tcmedia.zju.edu.cn, token-bound). */
  async uploadUrl(uploadId) {
    const j = await this.getJson(`/api/uploads/${uploadId}/url`);
    if (!j?.url) throw new ApiError('未取得下载链接（可能不允许下载）', { code: 'NO_DOWNLOAD_URL' });
    return j.url;
  }

  /**
   * Student-facing rollcall list. The page at /course/{id}/rollcall calls this;
   * it returns session metadata only (no per-student status).
   */
  async moduleRollcalls(courseId) {
    return findArray(
      await this.getJson(`/api/courses/${courseId}/modules/rollcalls`),
      ['rollcalls'],
    );
  }

  /** One rollcall including `student_rollcalls: [{student_id, status}]`. */
  rollcallDetail(rollcallId) {
    return this.getJson(`/api/rollcall/${rollcallId}`);
  }

  /** Download a course file (with session cookies) to disk. */
  async downloadFile(url, destPath) {
    const abs = url.startsWith('http')
      ? url
      : this.baseUrl + (url.startsWith('/') ? url : `/${url}`);
    const { res } = await request(abs, { jar: this.jar, timeoutMs: 120000 });
    if (!res.ok) {
      throw new ApiError(`下载失败 (HTTP ${res.status}): ${url}`, {
        status: res.status,
        code: 'DOWNLOAD_FAILED',
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return { path: destPath, size: buf.length };
  }

  async grades(courseId) {
    return this.getJson(`/api/courses/${courseId}/exam-scores`);
  }
}

// ---- tolerant extraction ------------------------------------------------

export function findArray(json, keys = []) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const k of keys) if (Array.isArray(json[k])) return json[k];
  for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  for (const k of keys) {
    const v = json[k];
    if (v && typeof v === 'object') {
      for (const inner of Object.values(v)) if (Array.isArray(inner)) return inner;
    }
  }
  if (json.data && typeof json.data === 'object') return findArray(json.data, keys);
  return [];
}

export function normalizeObject(json, keys = []) {
  if (!json || typeof json !== 'object') return {};
  for (const k of keys) if (json[k] && typeof json[k] === 'object') return json[k];
  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) return json.data;
  return json;
}

const pick = (obj, keys, dflt = null) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return dflt;
};

function nameOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).join(', ') || null;
  if (typeof v === 'object') return pick(v, ['name', 'title', 'display_name', 'full_name']);
  return null;
}

export function toIso(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string') {
    if (/^\d{10}$/.test(v)) return new Date(Number(v) * 1000).toISOString();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function humanizeDelta(targetMs, nowMs = Date.now()) {
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const units = [
    ['天', 86400000],
    ['小时', 3600000],
    ['分钟', 60000],
  ];
  let rest = abs;
  const parts = [];
  for (const [label, ms] of units) {
    const n = Math.floor(rest / ms);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * ms;
    }
    if (parts.length === 2) break;
  }
  if (!parts.length) parts.push('不到1分钟');
  return (diff < 0 ? '已过 ' : '') + parts.join('');
}

export function normCourse(c) {
  const code = pick(c, ['course_code', 'code', 'no']);
  const startDate = toIso(pick(c, ['start_date', 'start_time', 'began_at']));
  const endDate = toIso(pick(c, ['end_date', 'end_time', 'ended_at']));
  const sem = c?.semester && typeof c.semester === 'object' ? c.semester : null;
  const ay = c?.academic_year && typeof c.academic_year === 'object' ? c.academic_year : null;
  const apiSemName = sem?.name ?? (typeof c?.semester === 'string' ? c.semester : null);
  // Prefer the API label (it encodes 秋/冬 half-terms), then the code, then date.
  const derived =
    parseSemesterLabel(apiSemName) ??
    parseSemesterLabel(sem?.code) ??
    parseSemesterFromCode(code) ??
    inferSemesterFromDate(startDate);
  return {
    id: pick(c, ['id', 'course_id']),
    name: pick(c, ['name', 'title', 'course_name']),
    code,
    semester: apiSemName ?? derived?.name ?? null,
    semester_key: derived?.key ?? null,
    semester_id: sem?.id ?? null,
    academic_year: ay?.name ?? derived?.academic_year ?? null,
    term: derived?.term ?? null,
    half: derived?.half ?? null,
    instructor: nameOf(pick(c, ['instructor', 'teacher', 'instructors', 'teachers'])),
    department: nameOf(pick(c, ['department', 'department_name', 'org'])),
    credit: pick(c, ['credit']),
    status: pick(c, ['status', 'state']),
    start_date: startDate,
    end_date: endDate,
  };
}

export function normalizeCourses(list) {
  return list.map(normCourse).filter((c) => c.id != null);
}

export function normSemester(s) {
  return {
    id: pick(s, ['id']),
    name: pick(s, ['name', 'title']),
    real_name: pick(s, ['real_name']),
    sort: pick(s, ['sort']),
    academic_year: nameOf(pick(s, ['academic_year', 'academic_year_name'])),
    active: Boolean(pick(s, ['is_active', 'active'], false)),
    start_date: toIso(pick(s, ['start_date', 'start_time'])),
    end_date: toIso(pick(s, ['end_date', 'end_time'])),
  };
}

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

export function normAssignment(a, course = {}) {
  const dueRaw = pick(a, ['due_at', 'end_time', 'deadline', 'due_time']);
  const due = toIso(dueRaw);
  const submission = pick(a, ['submission', 'my_submission']);
  const submitted =
    typeof a?.submitted === 'boolean'
      ? a.submitted
      : typeof a?.is_submitted === 'boolean'
        ? a.is_submitted
        : submission
          ? true
          : /submitted|已提交|已完成/i.test(String(pick(a, ['status', 'submission_status'], '')))
            ? true
            : null;
  return {
    id: pick(a, ['id', 'activity_id']),
    title: pick(a, ['title', 'name']),
    course_id: pick(a, ['course_id'], course.id ?? null),
    course: course.name ?? null,
    type: pick(a, ['type', 'activity_type']),
    status: pick(a, ['status', 'submission_status']),
    submitted,
    due_at: due,
    due_at_raw: dueRaw ?? null,
    due_in: due ? humanizeDelta(Date.parse(due)) : null,
    overdue: due ? Date.parse(due) < Date.now() && submitted !== true : null,
    score: toNum(pick(a, ['score', 'data.score'])),
    score_percent: pick(a, ['score']) != null ? toNum(pick(a, ['score_percentage'])) : null,
    max_score: toNum(pick(a, ['total_score', 'max_score'])),
    state: submitted === true ? 'submitted' : due && Date.parse(due) < Date.now() ? 'overdue' : 'pending',
  };
}

export function normTodo(t) {
  const due = toIso(pick(t, ['due_at', 'end_time', 'deadline']));
  return {
    id: pick(t, ['id']),
    title: pick(t, ['title', 'name']),
    type: pick(t, ['type', 'todo_type']),
    course_id: pick(t, ['course_id']),
    course: nameOf(pick(t, ['course_name', 'course'])),
    due_at: due,
    due_in: due ? humanizeDelta(Date.parse(due)) : null,
    status: pick(t, ['status']),
  };
}

export function normNotification(n) {
  return {
    id: pick(n, ['id']),
    title: pick(n, ['title', 'name']),
    type: pick(n, ['type', 'notification_type']),
    read: pick(n, ['read', 'is_read']),
    course_id: pick(n, ['course_id']),
    course: nameOf(pick(n, ['course_name', 'course'])),
    created_at: toIso(pick(n, ['created_at', 'published_at', 'updated_at'])),
    content: pick(n, ['content', 'body', 'message']),
  };
}

export function normMaterial(a) {
  const uploads = Array.isArray(a?.uploads) ? a.uploads : [];
  return {
    id: pick(a, ['id', 'activity_id']),
    title: pick(a, ['title', 'name']),
    type: pick(a, ['type']),
    course_id: pick(a, ['course_id']),
    start_time: toIso(pick(a, ['start_time', 'created_at'])),
    link: a?.data?.link ?? a?.link ?? null,
    files: uploads.map((u) => ({
      id: pick(u, ['id']),
      name: pick(u, ['name', 'filename']),
      size: pick(u, ['size', 'file_size']),
      type: pick(u, ['type', 'mime_type']),
      downloadable: u?.allow_download !== false,
      key: pick(u, ['key']),
    })),
  };
}

export function normRollcall(r, course = {}, me = null) {
  const t = toIso(pick(r, ['rollcall_time', 'created_at', 'started_at']));
  const mine =
    me == null
      ? null
      : (r?.student_rollcalls ?? []).find((x) => String(x.student_id) === String(me));
  const myStatus = mine?.status ?? null;
  return {
    id: pick(r, ['id', 'rollcall_id']),
    course_id: pick(r, ['course_id'], course.id ?? null),
    course: course.name ?? nameOf(pick(r, ['course_title', 'course_name'])),
    title: pick(r, ['title']),
    type: pick(r, ['type']),
    source: pick(r, ['source']),
    time: t,
    time_in: t ? humanizeDelta(Date.parse(t)) : null,
    session_status: pick(r, ['status']),
    my_status: myStatus,
    answered: myStatus == null ? null : myStatus !== 'absent',
    is_number: pick(r, ['is_number', 'number']),
    number_code: pick(r, ['number_code', 'code']),
    teacher: nameOf(pick(r, ['created_by_name', 'teacher_name', 'created_by'])),
  };
}


const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Convert the activity description HTML into readable plain text. */
export function htmlToText(html) {
  if (!html) return null;
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITY[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normAssignmentDetail(a, course = {}) {
  const base = normAssignment(a, course);
  return {
    ...base,
    description: htmlToText(a?.data?.description),
    description_html: a?.data?.description ?? null,
    attachments: (a?.uploads ?? []).map((u) => ({
      id: pick(u, ['id']),
      name: pick(u, ['name', 'filename']),
      size: pick(u, ['size']),
      type: pick(u, ['type', 'mime_type']),
      downloadable: u?.allow_download !== false,
    })),
    submit_times: pick(a, ['submit_times', 'user_submit_count']),
    allow_retract: a?.data?.allow_retract ?? null,
    is_closed: a?.is_closed ?? null,
    score_published: a?.score_published ?? null,
    reference_answer: htmlToText(a?.data?.reference_answer),
  };
}

// Semester metadata derived from course codes and the /api/my-semesters table.
//
// ZJU course codes embed the term: `(2026-2027-1)-CS3103M-...`.
// `-1` is 秋冬 (autumn+winter), `-2` is 春夏, `-3` 暑期, `-4` 短学期.
// Half-semester courses are only distinguishable in the API semester name:
// 秋 / 冬 are the two halves of 秋冬, 春 / 夏 of 春夏. They are NOT duplicates.

const TERM_LABEL = { 1: '秋冬', 2: '春夏', 3: '暑期', 4: '短学期' };
const HALF_LABEL = { A: '秋', B: '冬', C: '春', D: '夏' };

function makeSemester(startYear, term, half = null) {
  if (!TERM_LABEL[term]) return null;
  let label = TERM_LABEL[term];
  if (half) {
    if (term === 1) label = half === 'A' ? '秋' : '冬';
    else if (term === 2) label = half === 'A' ? '春' : '夏';
    else return null;
  }
  return {
    key: `${startYear}-${startYear + 1}-${term}${half ?? ''}`,
    academic_year: `${startYear}-${startYear + 1}`,
    name: `${startYear}-${startYear + 1} ${label}`,
    start_year: startYear,
    end_year: startYear + 1,
    term,
    half,
  };
}

/** Parse `(2024-2025-2)-...` style course codes (no half-term info). */
export function parseSemesterFromCode(code) {
  if (typeof code !== 'string') return null;
  const m = /\((\d{4})-(\d{4})-([1-4])\)/.exec(code);
  if (!m) return null;
  const startYear = Number(m[1]);
  if (Number(m[2]) !== startYear + 1) return null;
  return makeSemester(startYear, Number(m[3]));
}

/** Parse API labels: `2026-2027秋`, `2025-2026春夏`, `2025-2026短`. */
export function parseSemesterLabel(label) {
  if (typeof label !== 'string') return null;
  const m = /(\d{4})-(\d{4})\s*(秋冬|秋|冬|春夏|春|夏|短)/.exec(label);
  if (!m) return null;
  const startYear = Number(m[1]);
  if (Number(m[2]) !== startYear + 1) return null;
  switch (m[3]) {
    case '秋冬': return makeSemester(startYear, 1);
    case '秋': return makeSemester(startYear, 1, 'A');
    case '冬': return makeSemester(startYear, 1, 'B');
    case '春夏': return makeSemester(startYear, 2);
    case '春': return makeSemester(startYear, 2, 'A');
    case '夏': return makeSemester(startYear, 2, 'B');
    case '短': return makeSemester(startYear, 4);
    default: return null;
  }
}

/** Fallback for courses without a term in the code (`_uuid_...`, `xinshen2024`). */
export function inferSemesterFromDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return month >= 6 ? makeSemester(year, 1) : makeSemester(year - 1, 2);
}

/**
 * Display order, mirroring the tenant's `sort`: 秋冬 > 秋 > 冬 > 春夏 > 春 > 夏 > 短.
 * (Reversed chronological, but it puts the full autumn term on top.)
 */
const TERM_ORDER = { 1: 60, 1.1: 50, 1.2: 40, 2: 30, 2.1: 20, 2.2: 10, 3: 5, 4: 0 };

export function semesterOrder(key) {
  const m = /^(\d{4})-\d{4}-([1-4])([A-B])?$/.exec(String(key ?? ''));
  if (!m) return -1;
  const term = Number(m[2]);
  const half = m[3] === 'A' ? 0.1 : m[3] === 'B' ? 0.2 : 0;
  return Number(m[1]) * 100 + (TERM_ORDER[term + half] ?? 0);
}

export function baseSemesterKey(key) {
  return String(key ?? '').replace(/[A-B]$/, '');
}

/** Chronological value (ms) used for cross-term sorting. */
export function semesterStartMs(key) {
  const d = semesterStartDate(key);
  return d ? d.getTime() : -Infinity;
}

export function compareCourses(a, b) {
  const ka = semesterStartMs(a.semester_key);
  const kb = semesterStartMs(b.semester_key);
  if (ka !== kb) return kb - ka;
  const sa = a.start_date ? Date.parse(a.start_date) : -Infinity;
  const sb = b.start_date ? Date.parse(b.start_date) : -Infinity;
  if (sa !== sb) return sb - sa;
  return Number(a.id ?? 0) - Number(b.id ?? 0);
}

/** Group already-sorted courses; unknown terms go last. */
export function groupBySemester(courses) {
  const groups = [];
  const index = new Map();
  for (const course of courses) {
    const key = course.semester_key ?? '';
    let group = index.get(key);
    if (!group) {
      group = {
        key: key || null,
        name: course.semester ?? '未分学期',
        order: semesterStartMs(key),
        count: 0,
        courses: [],
      };
      index.set(key, group);
      groups.push(group);
    }
    group.count++;
    group.courses.push(course);
  }
  groups.sort((a, b) => b.order - a.order);
  return groups;
}

/** Approximate term start: 秋冬 = Sep 1, 春夏 = Feb 1, 暑期/短 = Jun 1. */
export function semesterStartDate(key) {
  const m = /^(\d{4})-\d{4}-([1-4])([A-B])?/.exec(String(key ?? ''));
  if (!m) return null;
  const term = Number(m[2]);
  const half = m[3];
  // 秋冬/秋 start in Sep of the first year; 春夏/春 in Feb, 夏 in May and
  // 短/暑期 in Jun of the SECOND year of the academic year.
  const year = Number(m[1]) + (term === 1 ? 0 : 1);
  const month = term === 1 ? (half === 'B' ? 10 : 8) : term === 2 ? (half === 'B' ? 4 : 1) : 5;
  return new Date(Date.UTC(year, month, 1));
}

/**
 * Current terms = every semester sharing the base of the latest started term,
 * so 秋冬 full-year + 秋/冬 half-term courses are all considered current.
 */
export function pickCurrentSemesterKeys(courses, now = Date.now()) {
  const keys = [...new Set(courses.map((c) => c.semester_key).filter(Boolean))];
  if (!keys.length) return new Set();
  const bases = [...new Set(keys.map(baseSemesterKey))];
  const started = bases.filter((k) => {
    const start = semesterStartDate(k);
    return start && start.getTime() <= now;
  });
  const pool = started.length ? started : bases;
  // "Current" is about dates, not numbering: 短学期 (Jun) must lose to 秋冬 (Sep).
  const latest = pool.sort((a, b) => {
    const diff = semesterStartDate(b).getTime() - semesterStartDate(a).getTime();
    return diff !== 0 ? diff : semesterOrder(b) - semesterOrder(a);
  })[0];
  return new Set(keys.filter((k) => baseSemesterKey(k) === latest));
}

export function pickCurrentSemesterKey(courses, now = Date.now()) {
  const keys = pickCurrentSemesterKeys(courses, now);
  return keys.size ? [...keys].sort((a, b) => semesterOrder(b) - semesterOrder(a))[0] : null;
}

/** `--semester` accepts a key, an academic year, 秋/冬/春夏, or a name fragment. */
export function matchesSemester(course, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [course.semester_key, course.academic_year, course.semester]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());
  return haystack.some((v) => v === q || v.includes(q));
}

/** Summarize terms for `xdc semesters` when the API returns nothing. */
export function deriveTerms(courses, now = Date.now()) {
  const currentKeys = pickCurrentSemesterKeys(courses, now);
  const map = new Map();
  for (const course of courses) {
    if (!course.semester_key) continue;
    let t = map.get(course.semester_key);
    if (!t) {
      t = {
        key: course.semester_key,
        name: course.semester,
        academic_year: course.academic_year,
        term: course.term,
        half: course.half ?? null,
        count: 0,
        first_start: null,
        last_start: null,
      };
      map.set(course.semester_key, t);
    }
    t.count++;
    if (course.start_date) {
      const ts = Date.parse(course.start_date);
      if (Number.isFinite(ts)) {
        if (t.first_start === null || ts < Date.parse(t.first_start)) t.first_start = course.start_date;
        if (t.last_start === null || ts > Date.parse(t.last_start)) t.last_start = course.start_date;
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => semesterOrder(b.key) - semesterOrder(a.key))
    .map((t) => ({ ...t, current: currentKeys.has(t.key), source: 'derived' }));
}

export { HALF_LABEL };

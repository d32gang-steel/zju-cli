// HTML helpers. The site is a PHP app (GB2312, table-based HTML), so parsing is
// deliberately tolerant: extract text/links/rows instead of depending on DOM ids.

export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractLinks(html) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    // hrefs in the page are HTML-escaped (`&amp;id=`), so normalise first.
    const href = m[1].replace(/&amp;/g, '&').replace(/&#38;/g, '&');
    out.push({ href, text: htmlToText(m[2]) });
  }
  return out;
}

export function parseRows(html) {
  const rows = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) {
    const inner = m[1];
    const cells = [];
    // This app omits </td> in several tables, so stop at the next <td>/<th>
    // or at the end of the row instead of requiring a closing tag.
    const cre = /<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/tr>|<\/table>|$)/gi;
    let c;
    while ((c = cre.exec(inner))) cells.push(htmlToText(c[1]));
    if (!cells.length) continue;
    // Join cells with a space: adjacent <td> would otherwise glue "2026-11-01"
    // and "23:59" together and break date detection.
    rows.push({ cells, links: extractLinks(inner), text: cells.filter(Boolean).join(' ') });
  }
  return rows;
}

export function classifyHref(href) {
  if (/showtest\.php/i.test(href)) return 'assessment';
  if (/course\.php.*folder=/i.test(href)) return 'folder';
  if (/viewmsg|msglist/i.test(href)) return 'message';
  if (/gradebook/i.test(href)) return 'gradebook';
  if (/\.(pdf|docx?|xlsx?|zip|rar|ppt)$/i.test(href)) return 'file';
  return 'link';
}

export function extractId(href) {
  const m = /[?&]id=(\d+)/i.exec(href);
  return m ? Number(m[1]) : null;
}

const NAV_RE = /(^|\/)(index\.php|actions\.php\?action=logout|help\.php)/i;
const isNavLink = (l) => NAV_RE.test(l.href) || /^(Home|Log ?out|Help|使用帮助)$/i.test(l.text);

const DATE_RE = /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;

/** Index page: links to enrolled courses (course.php?cid=N). */
export function parseCourses(html) {
  const out = [];
  const seen = new Set();
  for (const l of extractLinks(html)) {
    const m = /course\.php\?(?:[^"']*&)?cid=(\d+)/i.exec(l.href);
    if (!m || !l.text) continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ cid: Number(m[1]), name: l.text, href: l.href });
  }
  return out;
}

/**
 * Course page: a schedule table (weeks as columns) plus links to labs,
 * reports, assessments and tools. We return both so the caller can choose.
 */
export function parseCoursePage(html) {
  const links = [];
  const seen = new Set();
  for (const l of extractLinks(html)) {
    if (!l.text) continue;
    // The same target often appears twice (inline link + card title).
    const key = l.href;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text: l.text, href: l.href, kind: classifyHref(l.href), id: extractId(l.href) });
  }

  const rows = [];
  for (const row of parseRows(html)) {
    if (row.cells.length >= 2) {
      rows.push({
        cells: row.cells,
        links: row.links.filter((l) => l.text).map((l) => ({ text: l.text, href: l.href })),
      });
    }
  }

  const isDateRow = (cells) =>
    cells.length > 1 && cells.every((c) => /\d+月\d+日|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}/.test(c));
  const header = isDateRow(rows[0]?.cells ?? []) ? rows.shift().cells : null;
  return { links: links.filter((l) => !isNavLink(l)), schedule: rows, header };
}

export function parseAssessment(html) {
  const title =
    htmlToText(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(html)?.[1] ?? '') ||
    htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');

  const points = Number(/Total Points Possible:\s*(\d+)/i.exec(html)?.[1] ?? NaN);
  const timeLimit = /No time limit/i.test(html)
    ? null
    : Number(/Time Limit[:\s]*(\d+)\s*(?:minutes|min)/i.exec(html)?.[1] ?? NaN);

  const questionDiv = /<div class=question>([\s\S]*?)<\/div>\s*<div class="review"/i.exec(html)?.[1]
    ?? /<div class=question>([\s\S]*?)<\/div>/i.exec(html)?.[1]
    ?? '';
  // Keep radio options in the text; strip only the trailing "A:" input label.
  const question = htmlToText(questionDiv).replace(/\s*A:\s*$/, '').trim();
  const answerInput = /<input[^>]*name=["']?(qn\d+)/i.exec(questionDiv)?.[1] ?? null;
  const options = [...questionDiv.matchAll(/<li>\s*<input[^>]*value=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => ({
    value: m[1],
    label: htmlToText(m[2]),
  }));

  const formAction = /<form[^>]*action=["']([^"']+)["']/i.exec(html)?.[1] ?? null;
  const verattempts = /name=["']?verattempts["']?[^>]*value=["']?(\d+)/i.exec(html)?.[1] ?? '0';
  const inputs = [...html.matchAll(/<input\b[^>]*name=["']?([\w\[\]]+)/gi)].map((m) => m[1]);

  return {
    title,
    points: Number.isFinite(points) ? points : null,
    time_limit_minutes: Number.isFinite(timeLimit) ? timeLimit : null,
    question,
    answer_input: answerInput,
    options,
    form_action: formAction,
    verattempts,
    inputs,
    has_password: /assessment password/i.test(html),
  };
}

/** Gradebook: first row is the header. */
export function parseGradebook(html) {
  const rows = parseRows(html).map((r) => r.cells).filter((c) => c.length >= 2);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h || '');
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h || `col${i}`] = cells[i] ?? ''; });
    return obj;
  });
}

/** Report upload page: uploaded files + selectable report IDs. */
export function parseUploads(html) {
  const files = [];
  for (const row of parseRows(html)) {
    if (row.cells.length === 4 && /^\d+$/.test(row.cells[0])) {
      files.push({ report_id: Number(row.cells[0]), uploaded_at: row.cells[1], filename: row.cells[2], size: Number(row.cells[3]) });
    }
  }
  const reports = [...html.matchAll(/<option value=['"]?(\d+)['"]?>([^<]*)<\/option>/gi)].map((m) => ({
    id: Number(m[1]),
    label: htmlToText(m[2]),
  }));
  return { files, reports };
}

/** `Due Sun 11/8/26, 7:59 am` (server timezone is Asia/Shanghai). */
export function parseDue(text) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})[,\s]+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(String(text));
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  let hour = Number(m[4]);
  const ap = (m[6] ?? '').toLowerCase();
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  return new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2]), hour - 8, Number(m[5]))).toISOString();
}

/**
 * Assessment cards on the course page:
 *   <div class=item><div class=title><a href=...>Exercise 4</a><BR> Due ...</div>
 *   <div class=itemsum>...</div></div>
 */
export function parseCourseItems(html) {
  const items = [];
  const chunks = String(html).split('<div class=item>').slice(1);
  for (const chunk of chunks) {
    const seg = chunk.slice(0, 2000);
    const link = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(seg);
    const dueText = /Due\s+([^<]+)/i.exec(seg)?.[1]?.trim() ?? null;
    if (!link && !dueText) continue;
    const summary = /<div class=itemsum>([\s\S]*?)<\/div>/i.exec(seg)?.[1] ?? '';
    const href = link?.[1]?.replace(/&amp;/g, '&') ?? null;
    if (!href && !dueText) continue;
    items.push({
      title: htmlToText(link?.[2] ?? ''),
      href,
      id: href ? extractId(href) : null,
      kind: href ? classifyHref(href) : 'info',
      due_text: dueText,
      due_at: dueText ? parseDue(dueText) : null,
      summary: htmlToText(summary),
    });
  }
  return items;
}

/**
 * The course page schedule has two deadline rows:
 *   header: 9月14日-9月27日 ...        (teaching windows)
 *   row:    作业1 作业2 ...             (homework per window)
 *   row:    9月27日 10月25日 ...        (lab report due dates)
 *   row:    Lab1 Lab2 ...
 * Convert them into dated items. Year comes from the course's assessment due
 * date when available (Sep–Dec belong to the starting year).
 */
export function parseScheduleDeadlines(html, { year } = {}) {
  const { header, schedule } = parseCoursePage(html);
  const y = year ?? new Date().getFullYear();
  const weekRe = /(\d{1,2})月(\d{1,2})日\s*-\s*(\d{1,2})月(\d{1,2})日/;
  const dateRe = /^(\d{1,2})月(\d{1,2})日$/;

  const iso = (m, d) => new Date(Date.UTC(y, m - 1, d, 15, 59)).toISOString(); // 23:59 +08
  const items = [];

  const hwRow = schedule.find((r) => r.cells.every((c) => /^作业\d+$/.test(c)));
  const dateRow = schedule.find((r) => r.cells.length >= 2 && r.cells.every((c) => dateRe.test(c)));
  const labRow = schedule.find((r) => r.cells.every((c) => /^Lab\d+$/i.test(c)));

  if (header && hwRow) {
    header.forEach((cell, i) => {
      const m = weekRe.exec(cell);
      if (!m) return;
      items.push({
        kind: 'homework',
        title: hwRow.cells[i] ?? `作业${i + 1}`,
        due_text: `${m[3]}月${m[4]}日`,
        due_at: iso(Number(m[3]), Number(m[4])),
      });
    });
  }

  if (dateRow && labRow) {
    dateRow.cells.forEach((cell, i) => {
      const m = dateRe.exec(cell);
      if (!m) return;
      items.push({
        kind: 'lab_report',
        title: labRow.cells[i] ?? `Lab${i + 1}`,
        report_id: i + 1,
        due_text: cell,
        due_at: iso(Number(m[1]), Number(m[2])),
      });
    });
  }

  return items;
}

export function humanizeDue(iso, now = Date.now()) {
  if (!iso) return null;
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const units = [['天', 86400000], ['小时', 3600000], ['分钟', 60000]];
  let rest = abs;
  const parts = [];
  for (const [label, ms] of units) {
    const n = Math.floor(rest / ms);
    if (n) { parts.push(`${n}${label}`); rest -= n * ms; }
    if (parts.length === 2) break;
  }
  if (!parts.length) parts.push('不到1分钟');
  return (diff < 0 ? '已过 ' : '') + parts.join('');
}

/** Pull a human-readable message out of a page after an action. */
export function pageMessage(html) {
  const text = htmlToText(html);
  const m = /(上传成功|成功|已上传|Success[^\n]*|Error[^\n]*|失败[^\n]*)/i.exec(text);
  return m ? m[0].trim() : null;
}

// Platform health checks.
//
// 学在浙大 is notoriously flaky: 502/503 from nginx, empty 200s, HTML error
// pages from the Rails app, and 500s on individual endpoints. These helpers
// separate "your session is bad" from "the service is down" so the CLI can
// tell the user which it is.

export function looksLikeHtml(contentType, bodyText) {
  if (/text\/html/i.test(contentType ?? '')) return true;
  return /^\s*<(!doctype|html|head|body)/i.test(String(bodyText ?? ''));
}

/** Map a failed response to an actionable code/hint, or null if it is fine. */
export function classifyFailure(status, contentType, bodyText) {
  if (!status) {
    return {
      code: 'NETWORK',
      hint: '连不上学在浙大：检查网络/代理，或用 `xdc status` 确认平台是否可达',
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      hint: `平台网关返回 ${status}，通常是学在浙大后端挂了或正在维护；稍等几分钟后重试，用 \`xdc status\` 复查`,
    };
  }
  if (status >= 500) {
    return {
      code: 'SERVER_ERROR',
      hint: looksLikeHtml(contentType, bodyText)
        ? '平台返回了 HTML 错误页（后端异常），不是你的会话问题；稍后重试，用 `xdc status` 复查'
        : '平台服务端错误；稍后重试，用 `xdc status` 复查',
    };
  }
  return null;
}

/**
 * Probe the platform. A 401/403/404 still proves the service is up — only
 * transport errors and 5xx/HTML responses count as an outage.
 */
export async function checkPlatform(api, { timeoutMs = 15000 } = {}) {
  const checks = [];
  for (const path of ['/api/profile', '/api/my-courses']) {
    const started = Date.now();
    try {
      const r = await api.call('GET', path, { timeoutMs, retries: 0 });
      checks.push({
        path,
        ok: true,
        status: r.status,
        ms: Date.now() - started,
        json: r.json !== undefined,
      });
    } catch (e) {
      const up = [401, 403, 404].includes(e.status);
      checks.push({
        path,
        ok: up,
        status: e.status ?? null,
        code: e.code,
        ms: Date.now() - started,
        message: e.message,
      });
    }
  }

  const broken = checks.filter((c) => !c.ok);
  const platform = broken.length === 0 ? 'ok' : broken.length === checks.length ? 'down' : 'degraded';
  return {
    platform,
    reachable: checks.some((c) => c.status !== null),
    latency_ms: Math.max(...checks.map((c) => c.ms)),
    checked_at: new Date().toISOString(),
    checks,
  };
}

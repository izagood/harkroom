/**
 * 계정 사용량을 **글자로 만드는 곳**. 순수 함수라 컴포넌트 없이 잰다.
 *
 * ## 왜 퍼센트도 막대도 없는가
 *
 * 분모를 모른다. `claude auth status --json` 에 사용량도 한도도 없고(실측 2.1.263)
 * 트랜스크립트에도 한도 값이 적히지 않는다 — claude 는 **넘은 순간에만** "넘었다"고
 * 말한다(`quotaLimits`). 그래서 막대를 그리면 그 막대의 100% 는 우리가 지어낸 값이다.
 *
 * 대신 두 종류의 사실을 나눠서 말한다:
 *
 * | 무엇 | 어떤 종류의 사실인가 | 화면에서의 쓸모 |
 * |---|---|---|
 * | 창 안의 토큰·응답 수 | 관측된 양 | 계정들 사이의 **상대 비교** — 어느 것이 많이 돌았나 |
 * | 한도 사건과 `resetsAt` | claude 자신이 말한 것 | **단정할 수 있는 것** — 지금 못 쓴다 · 몇 시에 돌아온다 |
 *
 * ## 캐시 읽기를 입력에 더하지 않는 이유
 *
 * 자릿수가 한둘 크다(실측: 창 하나에서 입력 수만, 캐시 읽기 수천만). 하나로 더하면
 * 화면의 숫자가 사실상 캐시 읽기 하나가 되고, 계정들의 차이가 그 안에 묻힌다.
 */
import type { ClaudeAccountUsage } from '@murmur/shared/daemonProtocol';

/**
 * 토큰 수를 짧게. **자리를 하나만 남긴다** — 이 숫자는 비교용이고, `1,234,567` 을 그대로
 * 적으면 줄이 숫자로 가득 차 옆 계정과 눈으로 비교하기 어렵다.
 */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** `HH:MM`. 사람이 시계를 보고 대조하는 값이라 상대 시간이 아니라 시각으로 말한다. */
export function clockLabel(atMs: number, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}),
  }).format(new Date(atMs));
}

/**
 * 창 안에서 쓴 양. **응답이 0 일 때 `0 tokens` 라고 적지 않는다** — 그것은 "안 돌았다"는
 * 뜻인데, 0 을 늘어놓으면 사람이 "재기를 실패했나"를 의심한다(`AgentTurns` 에서 `0` 과
 * `모름` 을 가른 것과 같은 판단이다).
 */
export function usageSummary(u: ClaudeAccountUsage): string {
  if (u.responses === 0) return 'Not used in this window';
  const parts = [
    `${u.responses} response${u.responses === 1 ? '' : 's'}`,
    `in ${compactTokens(u.tokens.input + u.tokens.cacheCreation)}`,
    `out ${compactTokens(u.tokens.output)}`,
    `cache ${compactTokens(u.tokens.cacheRead)}`,
  ];
  // **적게 세어졌다는 사실을 숨기지 않는다.** 못 읽은 파일이 있으면 위 숫자는 하한이다.
  if (u.unreadableFiles > 0) parts.push(`+${u.unreadableFiles} file${u.unreadableFiles === 1 ? '' : 's'} unreadable`);
  return parts.join(' · ');
}

/**
 * 한도 상태 한 줄. `null` = 말할 것이 없다(이 창에 한도 사건이 없었다).
 *
 * **`resetsAt` 이 미래인가로 갈린다.** 미래면 지금 못 쓰는 상태이고 몇 시에 돌아오는지
 * 말할 수 있다. 과거면 이미 풀린 것이라 경고가 아니다 — 그런데도 이 창에서 걸렸다는
 * 사실은 남겨 둔다: 같은 창에서 또 걸릴 계정이라는 뜻이다.
 */
export function limitLine(
  u: ClaudeAccountUsage,
  nowMs: number,
  locale: string,
  timeZone?: string,
): { tone: 'warning' | 'muted'; text: string } | null {
  const hit = u.limitHit;
  if (!hit) return null;
  if (hit.resetsAtMs !== null && hit.resetsAtMs > nowMs) {
    return { tone: 'warning', text: `Rate limited — resets ${clockLabel(hit.resetsAtMs, locale, timeZone)}` };
  }
  if (hit.atMs < u.windowStartMs) return null; // 이 창의 일이 아니다.
  return { tone: 'muted', text: `Hit the limit earlier in this window` };
}

/** 마지막으로 이 계정으로 돈 시각. `null` 은 **`0`이 아니라 "쓴 적 없다"** 다. */
export function lastUsedLabel(u: ClaudeAccountUsage, locale: string, timeZone?: string): string {
  return u.lastUsedAtMs === null ? 'Never used' : `Last active ${clockLabel(u.lastUsedAtMs, locale, timeZone)}`;
}

/** 계정 → 사용량. 목록과 사용량이 따로 오므로 화면이 짝을 맞출 표가 필요하다. */
export function usageByAccount(
  accounts: ClaudeAccountUsage[] | null,
): Map<string, ClaudeAccountUsage> {
  const m = new Map<string, ClaudeAccountUsage>();
  for (const u of accounts ?? []) m.set(`${u.pool}/${u.account}`, u);
  return m;
}

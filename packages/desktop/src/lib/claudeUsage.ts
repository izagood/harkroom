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
 * 창 안에서 쓴 양을 **열마다 하나씩** 나눈 것. `null` 은 **`0` 이 아니라 "이 창에 안
 * 돌았다"** 다 — 화면은 그 자리에 `0` 대신 `—` 를 그린다(`AgentTurns` 에서 `0` 과
 * `모름` 을 가른 것과 같은 규율).
 *
 * 왜 한 줄짜리 문장이 아니라 열인가: 계정 넷이 각자 자기 문장을 가지면 `1283` 과
 * `1649` 가 화면에서 130px 떨어진 서로 다른 x 좌표에 서고, 그러면 **어느 계정이 많이
 * 돌았나** 를 눈으로 알 수 없다. 이 화면이 존재하는 이유가 그 비교다.
 *
 * 캐시 읽기가 자기 열로 남는 이유는 이 파일 머리말에 있다 — 입력에 더하면 화면의
 * 숫자가 사실상 캐시 읽기 하나가 된다.
 */
export function usageCells(u: ClaudeAccountUsage): {
  responses: string;
  input: string;
  output: string;
  cacheRead: string;
  /** 못 읽은 파일이 있다는 사실. `null` = 없다. 있으면 위 숫자는 **하한**이다. */
  underCounted: string | null;
} | null {
  if (u.responses === 0) return null;
  return {
    responses: String(u.responses),
    input: compactTokens(u.tokens.input + u.tokens.cacheCreation),
    output: compactTokens(u.tokens.output),
    cacheRead: compactTokens(u.tokens.cacheRead),
    underCounted:
      u.unreadableFiles > 0
        ? `+${u.unreadableFiles} file${u.unreadableFiles === 1 ? '' : 's'} unreadable`
        : null,
  };
}

/**
 * 계정 하나의 상태. **문장이 아니라 갈래로 낸다** — 화면이 이것을 알약(pill)으로 그리기
 * 때문이다.
 *
 * 앞판은 이 자리에 `Hit the limit earlier in this window` 라는 **문장**을 라벨용 회색
 * (`--app-fg-subtle`, 배경과 3.08:1 로 AA 미달)으로 이메일 바로 아래에 뒀다. 그러면
 * 이 화면에서 가장 결정적인 사실 — 러너가 또 태울 계정이 어느 것인가 — 이 나머지 잡정보와
 * 똑같이 생긴다. 색만 올리는 것으로는 부족하다: **모양**이 달라야 훑어서 걸린다.
 *
 * 갈래를 다섯으로 가른 축은 두 개다.
 * 1. `resetsAt` 이 미래인가 — 미래면 **지금** 못 쓰는 것이고 몇 시에 돌아오는지 말할 수
 *    있다(`limited`). 과거면 이미 풀린 것이라 경고가 아니다.
 * 2. 그래도 **이 창에서 걸렸는가** — 걸렸으면 같은 창에서 또 걸릴 계정이다
 *    (`limited-earlier`). 이 창의 일이 아니면 한도 사건은 말할 것이 없다.
 *
 * 한도 사건이 없으면 남는 것은 돌았나 · 쓴 적은 있나 뿐이다. `never` 와 `idle` 을 가르는
 * 이유: 둘 다 이 창에 `—` 이지만, 하나는 **쓴 적이 없는 계정**이고 하나는 **지금 쉬는
 * 계정**이다 — 계정을 지울지 판단하는 사람에게 그 둘은 다른 사실이다.
 */
export type AccountState =
  | { kind: 'limited'; tone: 'warning'; label: string }
  | { kind: 'limited-earlier'; tone: 'muted'; label: string }
  | { kind: 'active'; tone: 'success'; label: string }
  | { kind: 'idle'; tone: 'subtle'; label: string }
  | { kind: 'never'; tone: 'subtle'; label: string };

export function accountState(
  u: ClaudeAccountUsage,
  nowMs: number,
  locale: string,
  timeZone?: string,
): AccountState {
  const hit = u.limitHit;
  if (hit && hit.resetsAtMs !== null && hit.resetsAtMs > nowMs) {
    return {
      kind: 'limited',
      tone: 'warning',
      label: `Limited — back ${clockLabel(hit.resetsAtMs, locale, timeZone)}`,
    };
  }
  if (hit && hit.atMs >= u.windowStartMs) {
    return { kind: 'limited-earlier', tone: 'muted', label: 'Limited earlier' };
  }
  if (u.responses > 0) return { kind: 'active', tone: 'success', label: 'Active' };
  if (u.lastUsedAtMs === null) return { kind: 'never', tone: 'subtle', label: 'Never used' };
  return { kind: 'idle', tone: 'subtle', label: 'Idle this window' };
}

/** 계정 → 사용량. 목록과 사용량이 따로 오므로 화면이 짝을 맞출 표가 필요하다. */
export function usageByAccount(
  accounts: ClaudeAccountUsage[] | null,
): Map<string, ClaudeAccountUsage> {
  const m = new Map<string, ClaudeAccountUsage>();
  for (const u of accounts ?? []) m.set(`${u.pool}/${u.account}`, u);
  return m;
}

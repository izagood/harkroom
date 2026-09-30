/**
 * claude 계정별 **한도 사용률 스냅숏**(`usage.json`) — 데몬(쓰는 쪽)과 러너(읽는 쪽)가 같은 한 벌을 본다.
 *
 * ## 모양
 *
 * ```
 * <claude-accounts 뿌리>/
 *   pools.json    기본 풀·순서·배정(claudePools.ts)
 *   usage.json    이 파일. writer = 데몬의 사용량 폴러 하나(operator/src/claudeUsagePoller.ts)
 * ```
 *
 * 러너는 새 스레드에 계정을 고를 때 이것을 읽는다(점수 = 주간 창이 초기화되기 전에 남은 양을
 * 시간당으로 나눈 것). 러너가 직접 재지 않는 이유: 재는 데 계정마다 `claude` 프로세스가 하나씩
 * 뜨고, 러너는 에이전트마다 따로 떠 있다 — 러너가 재면 같은 계정을 러너 수만큼 잰다.
 *
 * **담는 것은 %·초기화 시각·읽은 시각뿐이다.** 이메일·조직 이름은 넣지 않는다. 같은 로그인인지는
 * `signIn` 으로 가리는데, 이것은 계정 uuid 둘의 해시 앞자리라 누구인지는 드러내지 않는다.
 *
 * **관용적으로 파싱한다** — `claudePools.ts` 와 같은 규율이다. 러너가 턴마다 읽을 수 있으므로
 * 깨진 항목 하나로 던지면 배정 전체가 죽는다. 틀린 항목만 버린다.
 *
 * 런타임 Node 의존이 없다(`daemonProtocol` 은 타입만 가져온다) — 웹뷰가 import 해도 안전하다.
 */
import type { ProviderUsageWindow } from './daemonProtocol.js'; // 타입만 — 런타임 의존이 아니다

export const CLAUDE_USAGE_FILE = 'usage.json';
export const CLAUDE_USAGE_VERSION = 1;

/**
 * 이보다 오래 읽은 값은 **믿지 않는다**(2026-09-29 C 제안). 믿지 않는다는 것은 "그 값으로 계정을
 * 빼지 않는다"는 뜻이다 — 모르는 계정으로 다룬다. 폴러가 쉬는 계정을 10분마다 재므로 한 번
 * 놓치면 넘는다.
 */
export const CLAUDE_USAGE_STALE_MS = 10 * 60 * 1000;

export interface ClaudeUsageEntry {
  /** 평평한 구조면 `''`. */
  pool: string;
  account: string;
  /**
   * 같은 로그인이면 같은 값(uuid 둘의 해시 앞자리). 같은 로그인은 한도를 함께 쓰므로 배정할 때
   * **한 칸**으로 센다. 로그인 정보를 못 읽으면 `null` — 그 계정은 자기 혼자인 묶음이다.
   */
  signIn: string | null;
  /** 5시간 창. */
  session: ProviderUsageWindow | null;
  /** 주간 창(모든 모델). */
  weekly: ProviderUsageWindow | null;
  /** 모델별 주간 창(`Opus weekly` 등). 배정은 에이전트 모델에 맞는 것과 `weekly` 중 빡빡한 쪽을 쓴다. */
  modelWeekly: { label: string; window: ProviderUsageWindow }[];
  /**
   * 위 창들을 **마지막으로 성공해 읽은** 시각. 한 번도 못 읽었으면 `null`. 조회가 실패하면
   * 창들은 앞 값 그대로 두고 이 값도 그대로다 — 그래서 신선도는 언제나 이 값 하나로 잰다.
   */
  readAtMs: number | null;
  /** 마지막 시도가 실패했으면 그 꼬리표(`ProviderAccountUsage.error` 와 같은 말). */
  error?: string;
}

export interface ClaudeUsageFile {
  version: typeof CLAUDE_USAGE_VERSION;
  writtenAtMs: number;
  accounts: ClaudeUsageEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function window(raw: unknown): ProviderUsageWindow | null {
  if (!isRecord(raw)) return null;
  const used = finite(raw.usedPercent);
  if (used === null) return null;
  const resets = finite(raw.resetsAtMs);
  return { usedPercent: Math.max(0, Math.min(100, used)), resetsAtMs: resets };
}

/** 모르는 판본·깨진 파일은 계정 없는 스냅숏이 된다 — 러너는 "아무것도 모른다"로 떨어진다. */
export function parseClaudeUsageFile(raw: unknown): ClaudeUsageFile {
  const empty: ClaudeUsageFile = { version: CLAUDE_USAGE_VERSION, writtenAtMs: 0, accounts: [] };
  if (!isRecord(raw) || raw.version !== CLAUDE_USAGE_VERSION || !Array.isArray(raw.accounts)) return empty;
  const accounts: ClaudeUsageEntry[] = [];
  for (const a of raw.accounts) {
    if (!isRecord(a) || typeof a.account !== 'string' || a.account.length === 0) continue;
    const modelWeekly: ClaudeUsageEntry['modelWeekly'] = [];
    if (Array.isArray(a.modelWeekly)) {
      for (const m of a.modelWeekly) {
        const w = isRecord(m) ? window(m.window) : null;
        if (w && typeof m.label === 'string') modelWeekly.push({ label: m.label, window: w });
      }
    }
    accounts.push({
      pool: typeof a.pool === 'string' ? a.pool : '',
      account: a.account,
      signIn: typeof a.signIn === 'string' && a.signIn.length > 0 ? a.signIn : null,
      session: window(a.session),
      weekly: window(a.weekly),
      modelWeekly,
      readAtMs: finite(a.readAtMs),
      ...(typeof a.error === 'string' ? { error: a.error } : {}),
    });
  }
  return { version: CLAUDE_USAGE_VERSION, writtenAtMs: finite(raw.writtenAtMs) ?? 0, accounts };
}

/** 이 값으로 판단해도 되는가. 한 번도 못 읽었거나 `CLAUDE_USAGE_STALE_MS` 를 넘었으면 아니다. */
export function isUsageFresh(entry: ClaudeUsageEntry, now: number, staleMs: number = CLAUDE_USAGE_STALE_MS): boolean {
  return entry.readAtMs !== null && now - entry.readAtMs <= staleMs;
}

/**
 * 배정 점수: 창이 초기화되기 전에 남은 % 를 남은 시간(h)으로 나눈 것 — 초기화 전에 다 쓰려면
 * 시간당 몇 % 를 써야 하는가. 높을수록 먼저 쓴다(`agent/src/accountAssign.ts`). 러너와 화면이
 * **같은 식**을 써야 화면의 점수가 러너의 판단과 같은 말을 한다.
 *
 * 초기화 시각을 모르면 한 주 전체(168h)로 본다 — 모르는 것을 "곧 초기화된다"로 보면 그 계정에
 * 몰린다. 초기화 직전 값이 무한대로 튀지 않게 6분을 바닥으로 둔다.
 */
export function headroomPerHour(
  window: ProviderUsageWindow, now: number, penaltyPct: number = 0,
): number {
  const hours = window.resetsAtMs === null
    ? 168
    : Math.max(0.1, (window.resetsAtMs - now) / 3_600_000);
  return Math.max(0, 100 - window.usedPercent - penaltyPct) / hours;
}

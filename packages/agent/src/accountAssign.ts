// claude 계정을 **스레드마다** 고른다(2026-09-29 C ②).
//
// **목표는 풀 전체 사용량을 최대로 쓰는 것이다.** 한 계정을 먼저 태우면 그동안 다른 계정의
// 5시간 창은 쓰이지 않은 채 초기화된다. 풀이 쓸 수 있는 양의 상한은 계정마다 **주간 창이
// 초기화되기 전에 남은 양**의 합이고, 5시간 창은 그 양을 얼마나 빨리 쓸 수 있는지를 막는다.
// 그래서 골고루 돌린다 — 5시간 창 여러 개가 동시에 쓰이고 주간 창도 버려지지 않는다.
//
// **점수** = `(100 − 주간%) ÷ 주간 초기화까지 남은 시간(h)`. 초기화 전에 다 쓰려면 시간당 몇 %
// 를 써야 하는지다. 높을수록 먼저 쓴다 — 먼저 사라질 여유부터 쓰고, 쓰면 점수가 내려가 저절로
// 다음 계정으로 넘어간다.
//
// **스레드 단위로 고정한다.** claude 세션 파일은 `<CLAUDE_CONFIG_DIR>/projects` 아래 있어
// 계정을 넘어가지 못한다(`mentionTurn.ts` 의 `계정이바뀌었나`) — 턴마다 고르면 매번 세션을
// 버린다. 그래서 스레드가 처음 올 때 고르고, 그 뒤로는 `SessionRecord.claudeAccount` 에 적힌
// 계정을 따른다. 고정된 계정은 옮기기 기준(95/98)을 넘었을 때만 옮긴다 — 새 배정 기준(85/97)
// 보다 높은 이유는 옮기면 세션을 잃기 때문이다.
//
// 이 파일은 둘로 나뉜다: `pickAccount` 는 순수 함수(파일·시계·난수를 인자로 받는다)이고,
// `createAccountAssigner` 가 usage.json·세션 장부·최근 배정 수를 모아 그것을 부른다.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_ASSIGN_THRESHOLDS,
  parseClaudePoolsConfig,
  resolveAssignThresholds,
  type ClaudeAssignThresholds,
} from '@harkroom/shared/claudePools';
import {
  CLAUDE_USAGE_FILE,
  headroomPerHour,
  isUsageFresh,
  parseClaudeUsageFile,
  type ClaudeUsageEntry,
} from '@harkroom/shared/claudeUsage';
import type { ProviderUsageWindow } from '@harkroom/shared/daemonProtocol';

import type { ClaudeAccount } from './claudeAccounts.js';

/**
 * 기준 % 넷은 `pools.json` 의 풀별 `assign` 에서 온다(설정 › Claude 계정, 비면 jaebin 이 고른
 * 85/97·95/98). 나머지 둘은 사람이 만질 값이 아니라 상수다.
 */
export interface AssignPolicy extends ClaudeAssignThresholds {
  /** 스냅숏을 읽은 뒤 이 러너가 배정한 스레드마다 주간 남은 양에서 뺀다(%p). */
  perAssignPenaltyPct: number;
  /** 점수가 1등의 이 비율 안쪽이면 동점으로 보고 5시간 사용률이 낮은 쪽을 앞에 둔다. */
  tieRatio: number;
}

export const DEFAULT_ASSIGN_POLICY: AssignPolicy = {
  ...DEFAULT_ASSIGN_THRESHOLDS,
  perAssignPenaltyPct: 2,
  tieRatio: 0.1,
};

export type PickReason =
  /** 고정된 계정을 그대로 쓴다. */
  | 'kept'
  /** 새 스레드(또는 고정 계정이 풀에서 사라짐) — 점수로 골랐다. */
  | 'new'
  /** 고정된 계정이 옮기기 기준을 넘었다. */
  | 'moved'
  /** 모든 계정이 새 배정 기준을 넘었다 — 걸린 창이 가장 먼저 초기화되는 계정으로 보낸다. */
  | 'all-hot'
  /** 믿을 만한 값이 하나도 없다 — 지금 동작(풀 순서)으로 떨어진다. */
  | 'unknown';

export interface PickInput {
  /** 풀 순서(`orderAccounts`) 그대로의 계정 이름. 비어 있으면 안 된다. */
  accounts: readonly string[];
  /** 이 풀의 usage.json 항목(이름 → 항목). 없는 계정은 모르는 계정이다. */
  usage: ReadonlyMap<string, ClaudeUsageEntry>;
  /** 이 스레드에 이미 고정된 계정. 새 스레드면 `null`. */
  pinned: string | null;
  policy: AssignPolicy;
  now: number;
  /** 스냅숏을 읽은 뒤 이 러너가 배정한 스레드 수(계정 이름 → 수). */
  recentAssignments: ReadonlyMap<string, number>;
  /** 에이전트 모델(`claude-opus-…`). 맞는 모델별 주간 창이 있으면 `weekly` 와 둘 중 빡빡한 쪽을 쓴다. */
  model?: string | null;
  /** [0,1) 난수. 러너끼리의 몰림을 상위 둘 무작위로 흩는다. */
  random: () => number;
}

export interface PickResult {
  /** 페일오버 순서: [고른 계정, 나머지 점수순]. */
  order: string[];
  reason: PickReason;
  /** 로그용 한 줄(이름·% 만 — 이메일은 없다). */
  detail: string;
}

interface Scored {
  name: string;
  /** 풀 순서 — 동점일 때 마지막 기준. */
  index: number;
  known: boolean;
  sessionPct: number | null;
  weeklyPct: number | null;
  score: number;
  /** 새 배정 자격(모르는 계정은 자격이 있다 — 조회 실패로 멀쩡한 계정을 빼지 않는다). */
  eligible: boolean;
  /** 옮기기 기준을 넘었나. */
  mustMove: boolean;
  /** 자격을 잃게 만든 창이 초기화되는 시각(`all-hot` 에서만 쓴다). */
  unblockAtMs: number;
}

/** 모델 이름에 들어 있는 낱말로 모델별 주간 창을 고른다(`Opus weekly` ↔ `claude-opus-4-…`). */
function modelWindow(entry: ClaudeUsageEntry, model: string | null | undefined): ProviderUsageWindow | null {
  if (!model) return null;
  const m = model.toLowerCase();
  let tightest: ProviderUsageWindow | null = null;
  for (const { label, window } of entry.modelWeekly) {
    const word = label.toLowerCase().split(/\s+/)[0];
    if (!word || word === 'weekly' || !m.includes(word)) continue;
    if (!tightest || window.usedPercent > tightest.usedPercent) tightest = window;
  }
  return tightest;
}

/**
 * 계정을 고른다. **순수 함수다** — 파일·시계·난수를 모두 인자로 받는다.
 *
 * 같은 로그인(`signIn`)은 한도를 함께 쓰므로 **한 칸**으로 센다: 묶음 안에서 가장 최근에 읽은
 * 값을 모두가 쓰고, 최근 배정 수도 묶음으로 합친다.
 */
export function pickAccount(input: PickInput): PickResult {
  const { accounts, usage, pinned, policy, now, model } = input;
  if (!accounts.length) throw new Error('pickAccount: 계정이 비어 있다');

  // 묶음 키 → 가장 최근에 읽은 믿을 만한 항목, 최근 배정 합.
  const groupOf = (name: string): string => {
    const signIn = usage.get(name)?.signIn;
    return signIn ? `s:${signIn}` : `a:${name}`;
  };
  const groupEntry = new Map<string, ClaudeUsageEntry>();
  const groupAssigned = new Map<string, number>();
  for (const name of accounts) {
    const g = groupOf(name);
    groupAssigned.set(g, (groupAssigned.get(g) ?? 0) + (input.recentAssignments.get(name) ?? 0));
    const e = usage.get(name);
    if (!e || !isUsageFresh(e, now) || !e.weekly) continue;
    const prev = groupEntry.get(g);
    if (!prev || (e.readAtMs ?? 0) > (prev.readAtMs ?? 0)) groupEntry.set(g, e);
  }

  const scored: Scored[] = accounts.map((name, index) => {
    const g = groupOf(name);
    const e = groupEntry.get(g);
    if (!e || !e.weekly) {
      return {
        name, index, known: false, sessionPct: null, weeklyPct: null,
        score: 0, eligible: true, mustMove: false, unblockAtMs: Infinity,
      };
    }
    const mw = modelWindow(e, model);
    const binding = mw && mw.usedPercent > e.weekly.usedPercent ? mw : e.weekly;
    const weeklyPct = binding.usedPercent;
    const sessionPct = e.session?.usedPercent ?? null;
    const penalty = (groupAssigned.get(g) ?? 0) * policy.perAssignPenaltyPct;
    // 화면(설정 › Claude 계정)과 **같은 식**이다 — shared 에 둔 이유.
    const score = headroomPerHour(binding, now, penalty);
    const sessionHot = sessionPct !== null && sessionPct >= policy.newSessionPct;
    const weeklyHot = weeklyPct >= policy.newWeeklyPct;
    const unblock = Math.max(
      sessionHot ? (e.session?.resetsAtMs ?? Infinity) : -Infinity,
      weeklyHot ? (binding.resetsAtMs ?? Infinity) : -Infinity,
    );
    return {
      name, index, known: true, sessionPct, weeklyPct, score,
      eligible: !sessionHot && !weeklyHot,
      mustMove: (sessionPct !== null && sessionPct >= policy.moveSessionPct) || weeklyPct >= policy.moveWeeklyPct,
      unblockAtMs: unblock,
    };
  });

  const known = scored.filter((s) => s.known);
  const describe = (s: Scored): string => s.known
    ? `${s.name}(5h ${Math.round(s.sessionPct ?? 0)}% · 주간 ${Math.round(s.weeklyPct ?? 0)}% · 점수 ${s.score.toFixed(2)}/h)`
    : `${s.name}(모름)`;

  // 믿을 만한 값이 하나도 없으면 지금 동작 그대로 — 풀 순서, 고정 계정이 있으면 그것부터.
  if (!known.length) {
    const order = pinned && accounts.includes(pinned)
      ? [pinned, ...accounts.filter((a) => a !== pinned)]
      : [...accounts];
    return { order, reason: pinned && accounts.includes(pinned) ? 'kept' : 'unknown', detail: '사용량을 모른다 — 풀 순서' };
  }

  // 모르는 계정은 "순서상 먼저"가 아니라 **풀의 중간 점수**다.
  const sortedScores = known.map((s) => s.score).sort((a, b) => a - b);
  const mid = sortedScores.length % 2
    ? sortedScores[(sortedScores.length - 1) / 2]!
    : (sortedScores[sortedScores.length / 2 - 1]! + sortedScores[sortedScores.length / 2]!) / 2;
  for (const s of scored) if (!s.known) s.score = mid;

  // 점수 내림차순. 1등의 tieRatio 안쪽끼리는 5시간 사용률이 낮은 쪽(모르면 50%), 그다음 풀 순서.
  const byScore = (list: Scored[]): Scored[] => {
    const desc = [...list].sort((a, b) => b.score - a.score || a.index - b.index);
    const top = desc[0]?.score ?? 0;
    const cut = top * (1 - policy.tieRatio);
    const tier = desc.filter((s) => s.score >= cut);
    const rest = desc.filter((s) => s.score < cut);
    tier.sort((a, b) => (a.sessionPct ?? 50) - (b.sessionPct ?? 50) || b.score - a.score || a.index - b.index);
    return [...tier, ...rest];
  };
  const eligible = byScore(scored.filter((s) => s.eligible));
  const hot = byScore(scored.filter((s) => !s.eligible));
  const tail = (first: string): string[] => [...eligible, ...hot].map((s) => s.name).filter((n) => n !== first);

  const pin = pinned ? scored.find((s) => s.name === pinned) : undefined;
  if (pin && !pin.mustMove) {
    return { order: [pin.name, ...tail(pin.name)], reason: 'kept', detail: describe(pin) };
  }

  if (!eligible.length) {
    // 모두 뜨겁다. 턴을 막지 않는다 — 걸린 창이 가장 먼저 풀리는 계정으로 보내고, 실패 기반
    // 페일오버가 안전망이다. 고정 계정이 옮기기 기준 아래면 위에서 이미 그대로 썼다.
    const soonest = [...hot].sort((a, b) => a.unblockAtMs - b.unblockAtMs || a.index - b.index)[0]!;
    return {
      order: [soonest.name, ...tail(soonest.name)],
      reason: 'all-hot',
      detail: `풀 전체가 새 배정 기준(5h ${policy.newSessionPct}% / 주간 ${policy.newWeeklyPct}%) 이상 — ${describe(soonest)}`,
    };
  }

  // 러너끼리는 배정 수를 나누지 않는다 → 상위 둘 가운데 무작위로 흩는다(power-of-two).
  const pickIdx = eligible.length >= 2 && input.random() >= 0.5 ? 1 : 0;
  const chosen = eligible[pickIdx]!;
  return {
    order: [chosen.name, ...tail(chosen.name)],
    reason: pin ? 'moved' : 'new',
    detail: pin ? `${describe(pin)} → ${describe(chosen)}` : describe(chosen),
  };
}

export interface AccountAssignerDeps {
  /** 기동 때 읽은 계정 축(풀 순서). `[null]` 이면 풀이 없다 — 손대지 않는다. */
  lane: readonly (ClaudeAccount | null)[];
  /** 이 러너의 풀. 평평한 구조면 `null`(usage.json 에서는 `''`). */
  pool: string | null;
  /** claude-accounts 뿌리 — usage.json 이 여기 있다. */
  root: string;
  /** 스레드에 고정된 계정(`SessionRecord.claudeAccount`). */
  pinnedOf(threadKey: string): string | null;
  /** 주면 `pools.json` 을 읽지 않고 이것을 쓴다(테스트). */
  policy?: AssignPolicy;
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
}

export interface AccountAssigner {
  /** 이 스레드의 페일오버 순서. 실패해도 던지지 않는다 — 기동 때 축으로 떨어진다. */
  laneFor(threadKey: string, model?: string | null): Promise<readonly (ClaudeAccount | null)[]>;
}

/** 최근 배정 기록을 이만큼만 들고 있는다 — 쉬는 계정도 10분 안에 다시 재진다(폴러). */
const ASSIGNMENT_MEMORY_MS = 15 * 60 * 1000;

export function createAccountAssigner(deps: AccountAssignerDeps): AccountAssigner {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? ((line: string) => console.log(line));
  const accounts = deps.lane.filter((a): a is ClaudeAccount => a !== null);
  const byName = new Map(accounts.map((a) => [a.name, a]));
  const poolKey = deps.pool ?? '';
  /** 이 러너가 새로 배정한 기록. 스냅숏이 그 뒤에 읽혔으면 이미 값에 반영됐으므로 세지 않는다. */
  const assigned: { account: string; atMs: number }[] = [];
  /** "풀 전체가 뜨겁다"는 한 번만 알린다 — 풀리면 다시 알릴 수 있게 된다. */
  let allHotNoticed = false;

  /**
   * 기준은 **턴마다** 읽는다 — 사람이 설정에서 숫자를 바꾸면 러너를 다시 띄우지 않아도 다음
   * 새 스레드부터 따른다. 파일이 없거나 깨졌으면 기본값이다(러너는 이 파일을 쓰지 않는다).
   */
  async function readPolicy(): Promise<AssignPolicy> {
    if (deps.policy) return deps.policy;
    let cfg = null;
    try {
      cfg = parseClaudePoolsConfig(JSON.parse(await readFile(join(deps.root, 'pools.json'), 'utf8')));
    } catch { /* 없다·깨졌다 = 기본값 */ }
    return { ...DEFAULT_ASSIGN_POLICY, ...resolveAssignThresholds(cfg, deps.pool) };
  }

  async function readUsage(): Promise<Map<string, ClaudeUsageEntry>> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(deps.root, CLAUDE_USAGE_FILE), 'utf8'));
    } catch {
      return new Map(); // 파일이 없다 = 폴러가 아직 안 돌았다. "모른다"의 정상 경로다.
    }
    const file = parseClaudeUsageFile(raw);
    return new Map(file.accounts.filter((e) => e.pool === poolKey).map((e) => [e.account, e]));
  }

  return {
    async laneFor(threadKey, model) {
      // 계정이 하나 이하면 고를 것이 없다.
      if (accounts.length < 2) return deps.lane;
      const t = now();
      const [usage, policy] = await Promise.all([readUsage(), readPolicy()]);
      while (assigned.length && t - assigned[0]!.atMs > ASSIGNMENT_MEMORY_MS) assigned.shift();
      const recent = new Map<string, number>();
      for (const a of assigned) {
        const readAt = usage.get(a.account)?.readAtMs ?? null;
        if (readAt !== null && readAt >= a.atMs) continue;
        recent.set(a.account, (recent.get(a.account) ?? 0) + 1);
      }
      const pinnedRaw = deps.pinnedOf(threadKey);
      const pinned = pinnedRaw && byName.has(pinnedRaw) ? pinnedRaw : null;
      const res = pickAccount({
        accounts: accounts.map((a) => a.name), usage, pinned, policy, now: t,
        recentAssignments: recent, model: model ?? null, random,
      });
      const first = res.order[0]!;
      if (res.reason === 'new' || res.reason === 'moved' || res.reason === 'all-hot') {
        assigned.push({ account: first, atMs: t });
      }
      if (res.reason === 'all-hot') {
        if (!allHotNoticed) log(`[계정 배정] ${res.detail}`);
        allHotNoticed = true;
      } else if (res.reason !== 'kept') {
        allHotNoticed = false;
      }
      if (res.reason !== 'kept' && res.reason !== 'unknown') {
        const what = res.reason === 'moved' ? '옮김' : res.reason === 'all-hot' ? '새 스레드(풀 전체 뜨거움)' : '새 스레드';
        log(`[계정 배정] ${threadKey}: ${what} → ${first} — ${res.detail}`);
      }
      return res.order.map((name) => byName.get(name)!);
    },
  };
}

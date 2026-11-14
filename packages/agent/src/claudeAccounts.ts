// claude 계정 풀. 계정 하나 = `CLAUDE_CONFIG_DIR` 하나다.
//
// **왜 이 축이 성립하는가**(2026-09-07 실측, claude 2.1.263): macOS 의 claude 는 자격증명을
// Keychain 에서 먼저 읽고 **서비스 이름을 `CLAUDE_CONFIG_DIR` 경로의 sha256 앞 8자로
// 파생한다**(미설정이면 `Claude Code-credentials`). 파일 폴백은 `<configDir>/.credentials.json`.
// 즉 config 디렉터리를 바꾸면 자격증명이 통째로 갈린다 — 빈 디렉터리를 주고 `claude -p` 를
// 돌리면 `Not logged in · Please run /login` 이 뜬다(종료 코드 1). 세션 파일
// (`<configDir>/projects`)도 같이 따라간다 — 그래서 `claudeSessions.ts` 가 이 값을 받는다.
//
// **이 모듈이 있는 이유는 러너가 시스템 기본 계정에 묶여 있었다는 것이다.** 러너는
// `CLAUDE_CONFIG_DIR` 를 설정하지 않아 언제나 `~/.claude` 를 썼고, 계정 전환을 그 경로로
// 하지 않는 도구(Orca 등은 `CLAUDE_CONFIG_DIR` 주입으로 전환한다)에서는 사람이 계정을 바꿔도
// 러너에 닿지 않았다. 러너 env 는 데몬 env 를 통째로 상속하고 `HARKROOM_PAT`·`HARKROOM_URL`·
// `PATH` 만 덮어쓰므로(`desktop/src/lib/runnerLauncher.ts`), 그 자리에 계정이 들어올 길이
// 아예 없었다.
//
// **계정 뿌리는 러너 상태 디렉터리 밖이다.** `codexHome` 은 러너별로 격리하는 것이 목적
// (개인 config.toml 을 물려주지 않는다)이지만, 계정은 그 반대다 — 에이전트·인스턴스·서버를
// 가로지르는 자산이고, `resolveAgentStateDir` 아래 두면 에이전트마다 다시 로그인해야 한다.
//
// **목록의 진실은 디스크다.** 별도 설정 파일을 두지 않는다. 파일을 두면 파일과 디스크가
// 갈리는 날이 오고, 그날 러너는 없는 계정을 가리킨다(`ensureCodexHome` 이 `auth.json` 의
// 존재로 판정하는 것과 같은 규율).
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  agentPoolChain,
  orderAccounts,
  parseClaudePoolsConfig,
  type ClaudePoolsConfig,
} from '@harkroom/shared/claudePools';

import { isCredentialFailure, isExecutableNotFound, isQuotaExhausted } from './policy.js';
import { PromptNotDeliveredError } from './pty.js';
// 풀 해석(계정 뿌리·`pools.json`·풀 순서)은 `@harkroom/shared/claudeAccountLane` 에 있다 — 오퍼레이터의 러너 고르기
// (`runnerPick.ts`, B4-5e)가 **같은 함수**로 「이 에이전트가 계정 풀로 도는가」를 판정하게 하려고 옮겼다.
import {
  CLAUDE_ACCOUNT_PATTERN,
  claudeAccountsRoot,
  loadClaudeAccountLane,
  loadClaudeAccounts,
  type ClaudeAccount,
  type ClaudePoolLane,
} from '@harkroom/shared/claudeAccountLane';
export { CLAUDE_ACCOUNT_PATTERN, claudeAccountsRoot, loadClaudeAccountLane, loadClaudeAccounts, type ClaudeAccount, type ClaudePoolLane };

/**
 * 이 오류에서 **계정을 바꿔 다시 해 볼 만한가**.
 *
 * `policy.ts` 가 아니라 여기 있는 이유: 그 파일은 아무것도 import 하지 않는다는 규율이
 * 있고(파일 머리 주석), 이 판정은 그 파일의 세 판정을 **조합**한다. 조합을 거기 두면 그
 * 규율이 깨지고, 여기 두면 "계정 축의 판단은 계정 모듈에 있다"가 성립한다.
 *
 * 참인 경우 둘:
 * - **사용량 한도** — `policy.ts::isQuotaExhausted` 주석은 "여기서 할 일은 기다리는 것뿐"
 *   이라 적었다. 계정이 여러 개면 그 말이 더는 참이 아니다 — 기다리지 않고 옮겨 탈 수 있다.
 * - **harness 자격증명 실패** — 그 계정의 로그인이 만료·부재다. 다른 계정은 멀쩡할 수 있다.
 *
 * 거짓인 경우: harkroom PAT 실패(계정과 무관하다 — 러너가 물러나야 한다, #250), 실행 파일
 * 부재(PATH 문제다, #340), 그리고 평범한 실패(기존 재시도 회계로 간다).
 *
 * **실행 파일 부재를 먼저 보는 이유는 순서가 아니라 배타성이다.**
 * `ExecutableNotFoundError` 의 메시지에는 자식에게 넘긴 PATH 가 그대로 실려 있어, 그 경로에
 * `notloggedin` 같은 문구가 들어 있으면 아래 자격증명 판정이 문구 매칭으로 걸린다.
 */
export function switchesAccount(err: unknown): boolean {
  if (isExecutableNotFound(err) === 'executable-not-found') return false;
  if (isQuotaExhausted(err) !== null) return true;
  // **TUI 가 준비 상태에 못 닿았다 = 이 계정으로는 안 된다(2026-09-08).**
  //
  // 그 계정의 config 디렉터리가 첫 실행 승인을 안 지났다는 뜻이다(온보딩·팀 텔레메트리 —
  // 다중 계정 설계 §5 의 "계정 준비"). 승인은 계정마다 따로이므로 **다른 계정은 멀쩡할 수
  // 있고**, 그것이 정확히 계정 축이 있는 이유다.
  //
  // 이 줄이 없으면 승인을 안 지난 계정이 lane 첫 번째일 때 그 멘션이 3회를 태우고 버려진다 —
  // 나머지 계정이 다 멀쩡한데도. 실측(2026-09-08): aria 이 첫 계정이라 모든 턴이 거기서
  // 막혔고 basil·cedar 은 놀고 있었다.
  if (err instanceof PromptNotDeliveredError) return true;
  return isCredentialFailure(err) === 'harness-credential';
}

/**
 * 계정을 바꾸게 만든 실패의 **종류**(2026-10-02). 사람에게 "계정마다 왜 못 했나"를 말할 때 쓴다.
 *
 * ## 왜 필요한가 — 마지막 계정의 오류가 원인을 가렸다(2026-10-01 실측)
 * work 풀 세 계정 가운데 배정 1등(acct-ddb9b523)이 첫 실행 승인 화면에 서 있었고, 나머지 둘은
 * 한도였다. 축이 다 돌면 `withAccountFailover` 는 **마지막 오류**를 던지므로 스레드에는
 * "11pm 에 풀립니다"만 남았다 — 사람이 하면 풀리는 계정이 있다는 사실은 어디에도 없었다.
 *
 * **종류만 담는다.** `PromptNotDeliveredError.tail`·`err.message` 는 화면 원문이고 조직 설정
 * 값이 들어 있을 수 있다. 사람이 보는 자리(스레드·로그)에는 이 종류만 간다.
 */
export type AccountFailureKind =
  /** 관문 화면이 서서 사람의 선택을 기다린다(첫 실행 승인 등). 사람이 한 번 답하면 풀린다. */
  | 'gate'
  /** 사용량 한도. `resetsAt` 은 하네스가 적은 풀리는 시각(못 읽으면 `null`). */
  | 'quota'
  /** 하네스 로그인이 풀렸다·없다. */
  | 'credential'
  /** 상한까지 입력창을 못 봤다(관문인지 느린 부팅인지 모른다). */
  | 'timeout';

export interface AccountFailure {
  /** 계정 이름. 풀이 없는 러너(`[null]`)면 `null`. */
  account: string | null;
  kind: AccountFailureKind;
  resetsAt: string | null;
}

/** 이 오류가 계정 전환 방아쇠라면 그 종류. 아니면 `null`(판정은 `switchesAccount` 와 같다). */
export function accountFailureOf(err: unknown): Omit<AccountFailure, 'account'> | null {
  if (isExecutableNotFound(err) === 'executable-not-found') return null;
  const quota = isQuotaExhausted(err);
  if (quota !== null) return { kind: 'quota', resetsAt: quota.resetsAt };
  if (err instanceof PromptNotDeliveredError) {
    return { kind: err.kind === 'waiting' ? 'gate' : 'timeout', resetsAt: null };
  }
  if (isCredentialFailure(err) === 'harness-credential') return { kind: 'credential', resetsAt: null };
  return null;
}

/**
 * 계정 축이 돈 기록. 오류 객체에 **필드를 붙이지 않고** 옆 장부에 둔다 — 호출자의 판정
 * (`isQuotaExhausted` 등)은 그 오류를 그대로 읽어야 하고, 그 모양을 바꾸지 않는다.
 */
const trails = new WeakMap<object, readonly AccountFailure[]>();

/**
 * 이 오류가 나오기까지 계정 축이 남긴 이유들(시도 순서). 축을 한 칸이라도 넘겼을 때만 있다 —
 * 계정 하나로 끝난 실패는 그 오류 자신이 이유이므로 빈 배열이다.
 */
export function accountTrailOf(err: unknown): readonly AccountFailure[] {
  return typeof err === 'object' && err !== null ? trails.get(err) ?? [] : [];
}

/**
 * 계정 축을 돌며 `attempt` 를 시도한다. 계정을 바꿔서 나을 실패(`switchesAccount`)면 다음
 * 계정으로 **같은 일**을 다시 시도하고, 아니면 즉시 그 오류를 던진다.
 *
 * **별 함수로 뺀 이유는 제어 흐름이다.** `main.ts` 의 멘션 루프는 유예·종료요청·한도
 * 분기에서 `continue`·`break` 를 쓴다. 계정 루프를 그 안에 인라인으로 넣으면 그 제어문이
 * 계정 루프를 향하게 되어 조용히 멘션 루프를 못 벗어난다. 함수 경계로 끊고, 그 덕에 이
 * 판단이 루프 없이 검증된다.
 *
 * **재시도 회계(`MAX_ATTEMPTS`)와 별개로 돈다.** 그 회계는 "같은 조건으로 또 해 봤다"를
 * 세는 것이고, 계정을 바꾼 것은 조건이 달라진 것이다. 두 축을 곱하면 계정 3개 × 3회 = 9번을
 * 태우게 되고 그중 8번은 이미 답을 아는 실패다. 그래서 한 계정에서는 **한 번만** 시도한다 —
 * 방아쇠가 참이라는 것은 그 계정에서 재시도로 낫지 않는다는 판정이 이미 끝났다는 뜻이다.
 *
 * `accounts` 가 `[null]` 이면 한 번 돌고 기존 동작과 같아진다(계정 풀을 안 만든 러너).
 * **빈 배열은 호출자 결함이다** — 조용히 성공값을 지어내면 답하지 않은 멘션이 답한 것으로
 * 처리되므로 던진다.
 */
export async function withAccountFailover<T>(
  accounts: readonly (ClaudeAccount | null)[],
  /**
   * `isLast` 는 **물러설 곳이 남았는가**다(2026-09-08). 이 축이 필요해진 이유:
   * 준비 실패는 계정 전환 방아쇠인데, 사람을 부르는 경로는 **던지지 않는다** — PTY 를
   * 살려 둬야 사람이 그 화면을 볼 수 있기 때문이다. 그래서 "부른다"와 "전환한다"는
   * 동시에 못 한다.
   *
   * 순서로 가른다: 앞 계정들은 던져서 전환을 태우고, **마지막에서만** 살려 두고 부른다.
   * 그러려면 시도 함수가 자기가 마지막인지 알아야 한다. 계정이 하나뿐인 러너
   * (풀 미구성 `[null]` 포함)는 첫 시도가 곧 마지막이다.
   */
  attempt: (account: ClaudeAccount | null, isLast: boolean) => Promise<T>,
  /** `why` 는 앞 계정을 떠난 이유의 종류다(원문 없음 — `AccountFailureKind`). */
  onSwitch?: (from: ClaudeAccount | null, to: ClaudeAccount | null, why: AccountFailureKind | null) => void,
): Promise<T> {
  if (!accounts.length) {
    throw new Error('withAccountFailover: 계정 축이 비어 있다 — 호출자는 최소 [null] 을 넘겨야 한다');
  }
  let last: unknown;
  const trail: AccountFailure[] = [];
  /** 축을 한 칸이라도 넘겼으면 그 기록을 오류 옆에 둔다. 원시값 오류에는 둘 곳이 없다. */
  const withTrail = (err: unknown): unknown => {
    if (trail.length && typeof err === 'object' && err !== null) trails.set(err, [...trail]);
    return err;
  };
  for (const [idx, account] of accounts.entries()) {
    if (idx > 0) onSwitch?.(accounts[idx - 1] ?? null, account, trail.at(-1)?.kind ?? null);
    try {
      return await attempt(account, idx === accounts.length - 1);
    } catch (err) {
      last = err;
      // 계정을 바꿔서 나을 실패가 아니면 축을 헛돌지 않는다 — 호출자의 기존 실패 경로가
      // 이 오류를 받아야 한다(재시도 회계, 러너 물러남, 실행 파일 부재 안내).
      // 앞 계정들의 이유는 함께 넘긴다 — 그 실패 통지도 "앞 계정은 왜 못 했나"를 말할 수 있다.
      if (!switchesAccount(err)) throw withTrail(err);
      const failure = accountFailureOf(err);
      if (failure) trail.push({ account: account?.name ?? null, ...failure });
    }
  }
  // 모든 계정이 방아쇠에 걸렸다. 마지막 오류를 던져 호출자의 한도·자격증명 경로가 받게 한다.
  // 계정이 둘 이상이었으면 계정마다의 이유를 함께 넘긴다 — 마지막 오류만으로는 앞 계정이
  // 사람 손으로 풀리는 관문이었다는 사실이 사라진다(위 `AccountFailureKind` 주석).
  if (accounts.length < 2) throw last;
  throw withTrail(last);
}

/**
 * 기동 때 읽은 계정 축에서 **지금 디렉터리가 있는 계정만** 남긴다. 턴마다 부른다.
 *
 * ## 왜 필요한가 — 지운 계정이 되살아났다(2026-09-29 실측)
 *
 * 러너는 계정 축을 기동 때 한 번 읽는다. 사람이 앱에서 계정을 지워도(데몬이 디렉터리를 지운다)
 * 이미 떠 있는 러너는 그 계정을 **맨 앞에 든 채로** 다음 턴을 돌렸고, claude 는
 * `CLAUDE_CONFIG_DIR` 이 없으면 **그 디렉터리를 새로 만든다.** 남은 Keychain 항목(서비스 이름이
 * 경로의 해시다) 때문에 그 계정은 로그인된 채로 앱 목록에 다시 나타났다.
 *
 * 없는 디렉터리를 건너뛰면 러너는 절대 그 경로를 다시 만들지 않는다. 새로 추가된 계정을 줍는
 * 일(축을 다시 읽기)은 `createLiveAccountLane` 이 맡고, 그 결과에도 이 함수를 다시 씌운다.
 *
 * 전부 사라지면 `[null]`(시스템 기본 로그인)이다 — 풀이 빈 채로 기동한 러너와 같은 동작이다.
 * `null` 칸(애초에 풀이 비었다)은 디렉터리가 없으므로 그대로 둔다.
 */
export async function presentAccounts(
  lane: readonly (ClaudeAccount | null)[],
  isDir: (path: string) => Promise<boolean> = (p) => stat(p).then((s) => s.isDirectory(), () => false),
): Promise<(ClaudeAccount | null)[]> {
  const kept: (ClaudeAccount | null)[] = [];
  for (const a of lane) {
    if (a === null || (await isDir(a.configDir))) kept.push(a);
  }
  return kept.length ? kept : [null];
}

export interface LiveLaneValue {
  pool: string | null;
  lane: (ClaudeAccount | null)[];
  /**
   * 에이전트의 풀 순서(2026-10-15). 디렉터리가 있는 계정만 담는다(빈 풀도 칸은 남는다). 생략은
   * 풀이 하나뿐인 옛 동작이다 — 그때는 `pool`·`lane` 이 전부다.
   */
  chain?: ClaudePoolLane[];
}

/**
 * 화면 칩에 실을 **순번**(계정 칩 A, 2026-11-12). 서버에는 계정·풀 이름을 보내지 않는다(#1039) — 폴더 이름이라
 * 사람 이름일 수 있다. 그래서 「풀 n · 계정 m」의 n·m 만 계산한다.
 *
 * - `claudePoolRank`: 그 풀이 풀 순서(`chain`)에서 몇 번째인가. 순서에 없으면(뿌리 풀·풀 하나뿐) 싣지 않는다.
 * - `claudeAccountRank`: 그 계정이 **그 풀 안에서** 몇 번째인가. 풀이 순서에 있으면 그 풀의 계정 목록에서, 없으면
 *   축(`lane`)에서 센다. `null` 계정(시스템 기본 로그인)은 `null`. 목록에서 못 찾으면 싣지 않는다(모른다).
 */
export function accountRanks(
  snap: LiveLaneValue, account: { name: string; pool?: string | null } | null,
): { claudePoolRank?: number; claudeAccountRank?: number | null } {
  if (!account) return { claudeAccountRank: null };
  const pool = account.pool ?? snap.pool ?? null;
  const chain = snap.chain ?? [];
  const idx = pool === null ? -1 : chain.findIndex((c) => c.pool === pool);
  const list = idx >= 0 ? chain[idx]!.accounts : snap.lane.filter((a): a is ClaudeAccount => a !== null);
  const at = list.findIndex((a) => a.name === account.name);
  return {
    ...(idx >= 0 ? { claudePoolRank: idx + 1 } : {}),
    ...(at >= 0 ? { claudeAccountRank: at + 1 } : {}),
  };
}

export interface LiveAccountLane {
  /** 지금 풀과 계정 축(디렉터리가 있는 계정만, 비면 `[null]`). 턴마다 부른다. */
  current(): Promise<LiveLaneValue>;
  /** 마지막으로 읽은 값(동기). 폴이 서버에 싣는 신고값·인터랙티브의 경로 찾기가 쓴다. */
  snapshot(): LiveLaneValue;
}

/**
 * 계정 축을 **디스크에서 다시 읽는다**(2026-09-30). `presentAccounts` 는 지운 계정을 건너뛰기만
 * 하고 새 계정은 줍지 않았다 — 그래서 러너가 기동 때 목록을 쥔 채로 남았다.
 *
 * ## 왜 필요한가 — 한 계정만 사용량이 올랐다(qa 실측, 09-30)
 * 05:26Z 에 뜬 러너들이 그 뒤 지운 `lime` 을 계속 축에 들고 있었다. 배정(`accountAssign.ts`)이
 * 상위 둘 가운데 하나를 고르는데 lime 이 그 한 자리를 차지했고, 턴 직전 `presentAccounts` 가
 * lime 을 빼면 순서상 다음인 lychee 로 떨어졌다 — plum 은 한 번도 뽑히지 않았다.
 *
 * ## 왜 러너 재시작이 아닌가
 * 데몬이 계정을 지울 때 러너를 다시 띄우면 그 러너에서 돌던 턴이 모두 끊긴다. 계정 하나 지우는
 * 일이 대화 여러 개를 죽일 이유가 없다. 다시 읽는 비용은 readdir·stat 몇 번이다.
 *
 * ## 규율
 * - `minIntervalMs` 안쪽이면 앞 값을 쓴다 — 한 번에 여러 스레드가 몰려도 디스크를 한 번만 본다.
 * - **다시 읽기가 실패하면(던지면) 앞 값을 지운 계정만 걸러 쓴다.** `HARKROOM_CLAUDE_ACCOUNTS` 가
 *   지운 계정을 가리키면 `loadClaudeAccounts` 가 던진다 — 기동 때라면 사람이 고칠 신호지만, 떠 있는
 *   러너가 그 이유로 턴을 못 돌리면 안 된다. 같은 이유는 한 번만 경고한다.
 * - 목록이 바뀌면 한 줄 로그를 남긴다(이름만 — 이메일·경로는 없다).
 */
export function createLiveAccountLane(opts: {
  initial: { pool: string | null; accounts: ClaudeAccount[]; chain?: ClaudePoolLane[] };
  load: () => Promise<{ pool: string | null; accounts: ClaudeAccount[]; chain?: ClaudePoolLane[] }>;
  minIntervalMs?: number;
  now?: () => number;
  isDir?: (path: string) => Promise<boolean>;
  log?: (line: string) => void;
}): LiveAccountLane {
  const minIntervalMs = opts.minIntervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  const toLane = (accounts: ClaudeAccount[]): (ClaudeAccount | null)[] => (accounts.length ? accounts : [null]);
  const describe = (v: LiveLaneValue): string => v.chain && v.chain.length > 1
    ? v.chain.map((c, i) => `${i + 1}.${c.pool}: ${c.accounts.map((a) => a.name).join(', ') || '(없음)'}`).join(' / ')
    : `${v.pool ?? '기본'}: ${v.lane.map((a) => a?.name ?? '(시스템 기본)').join(', ')}`;
  /** 풀 순서의 계정도 지운 것은 뺀다 — 빈 풀은 `[]` 로 남긴다(`[null]` 은 풀 하나일 때만 뜻이 있다). */
  const presentChain = async (chain: ClaudePoolLane[] | undefined): Promise<ClaudePoolLane[] | undefined> => {
    if (!chain) return undefined;
    const out: ClaudePoolLane[] = [];
    for (const c of chain) {
      out.push({ pool: c.pool, accounts: (await presentAccounts(c.accounts, opts.isDir)).filter((a): a is ClaudeAccount => a !== null) });
    }
    return out;
  };
  const withChain = (v: LiveLaneValue, chain: ClaudePoolLane[] | undefined): LiveLaneValue =>
    (chain ? { ...v, chain } : v);

  let last: LiveLaneValue = withChain({ pool: opts.initial.pool, lane: toLane(opts.initial.accounts) }, opts.initial.chain);
  let readAt = -Infinity;
  let inflight: Promise<LiveLaneValue> | null = null;
  let warned: string | null = null;

  async function refresh(): Promise<LiveLaneValue> {
    let next: LiveLaneValue;
    try {
      const loaded = await opts.load();
      next = withChain(
        { pool: loaded.pool, lane: await presentAccounts(toLane(loaded.accounts), opts.isDir) },
        await presentChain(loaded.chain),
      );
      warned = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (warned !== msg) console.warn(`[claudeAccounts] 계정 축을 다시 읽지 못했다 — 앞 목록에서 지운 계정만 뺀다: ${msg}`);
      warned = msg;
      next = withChain({ pool: last.pool, lane: await presentAccounts(last.lane, opts.isDir) }, await presentChain(last.chain));
    }
    if (describe(next) !== describe(last)) log(`[계정 축] 바뀜 — ${describe(last)} → ${describe(next)}`);
    last = next;
    readAt = now();
    return next;
  }

  return {
    async current() {
      if (now() - readAt < minIntervalMs) return last;
      inflight ??= refresh().finally(() => { inflight = null; });
      return inflight;
    },
    snapshot: () => last,
  };
}

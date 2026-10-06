/**
 * 작업 폴더 정리(삭제 예정 → N일 뒤 삭제)의 원장 모양 — 오퍼레이터가 쓰고, 앱이 daemon 소켓으로 읽는다.
 *
 * 원장은 **이 기기의 것**이다(오퍼레이터 데이터 폴더 `cleanup/ledger.json`). 경로는 이 기기에서만 뜻이 있어
 * 서버에 올리지 않는다. 스레드·사람은 id 로 적고, 이름은 화면이 붙인다(이름은 바뀌는 이름표다).
 *
 * 상태:
 * - `unowned` — 어느 스레드 것인지 모른다. 청소기는 **손대지 않는다**(목록에 넣지도, 의존성 폴더를 지우지도 않는다).
 *   사람이 「삭제 예정에 넣기」를 누를 때만 `listed` 가 된다.
 * - `listed` — 삭제 예정. 넣는 순간 다시 만들 수 있는 폴더(`node_modules` 등)만 지우고, `deleteAfter` 가 지나면
 *   지우기 직전 검사를 거쳐 지운다.
 * - `kept` — 사람이 「보존」했다. 청소기는 다시 넣지 않는다.
 * - `blocked` — 기한이 지났지만 검사에 걸려 지우지 않았다(⚠). 다음 회차에 다시 검사한다.
 * - `deleted` — 지웠다. 최근 기록에 남기려고 잠시 둔다.
 */
export const CLEANUP_STATES = ['unowned', 'listed', 'kept', 'blocked', 'deleted'] as const;
export type CleanupState = (typeof CLEANUP_STATES)[number];

export const CLEANUP_KINDS = ['worktree', 'threadDir', 'claudeSession'] as const;
export type CleanupKind = (typeof CLEANUP_KINDS)[number];

/**
 * 지우지 않은 이유. `turn-running` 은 사람이 할 일이 없는 **미룸**이라 화면은 ⚠ 로 세지 않는다(시안 v3).
 */
export const CLEANUP_BLOCK_REASONS = ['uncommitted', 'unpushed', 'turn-running'] as const;
export type CleanupBlockReason = (typeof CLEANUP_BLOCK_REASONS)[number];

export interface CleanupThreadRef {
  channelId: string;
  threadRootId: string;
}

export interface CleanupPr {
  number: number;
  state: 'open' | 'merged' | 'closed';
  /** PR 의 마지막 커밋. squash 머지 뒤 원격 브랜치가 사라져도 "올라간 커밋"을 이것으로 판정한다. */
  headSha: string | null;
}

export interface CleanupItem {
  /** 원장 안의 키 — 경로를 그대로 쓴다(한 경로는 한 항목). */
  path: string;
  kind: CleanupKind;
  state: CleanupState;
  /** worktree 일 때 그 저장소(main worktree 경로). */
  repo: string | null;
  /** 로컬 브랜치 이름. detached 면 null. */
  branch: string | null;
  headSha: string | null;
  thread: CleanupThreadRef | null;
  pr: CleanupPr | null;
  /** 폴더 안 파일의 마지막 수정 시각(ISO) — 주인 모름 줄이 보여 준다. */
  lastModifiedAt: string | null;
  listedAt: string | null;
  /** 이 시각이 지나면 지운다(ISO). `listed`·`blocked` 에서만 뜻이 있다. */
  deleteAfter: string | null;
  blockReason: CleanupBlockReason | null;
  /** 「보존」·「삭제 예정에 넣기」를 누른 사람(계정 id)과 시각. 청소기가 넣었으면 null. */
  actedBy: string | null;
  actedAt: string | null;
  /** 바이트. 처음 잰 크기와 지금 크기(의존성 폴더를 지운 뒤 줄어든다). */
  sizeBefore: number | null;
  sizeNow: number | null;
}

/** 최근 기록 한 줄 — 누가(null=청소기)·무엇을·얼마나. */
export interface CleanupEvent {
  at: string;
  path: string;
  thread: CleanupThreadRef | null;
  action: 'listed' | 'deps-removed' | 'kept' | 'unkept' | 'revived' | 'blocked' | 'deleted';
  by: string | null;
  bytes: number | null;
  reason: CleanupBlockReason | null;
}

export interface CleanupSettings {
  enabled: boolean;
  /** 유예 일수(1~30). */
  graceDays: number;
}

export const CLEANUP_GRACE_MIN = 1;
export const CLEANUP_GRACE_MAX = 30;
export const CLEANUP_GRACE_DEFAULT = 7;
/** 이만큼 턴이 없으면 스레드 폴더·세션 기록을 넣는다(규칙 6). */
export const CLEANUP_IDLE_DAYS = 7;

export interface CleanupLedger {
  version: 1;
  items: CleanupItem[];
  events: CleanupEvent[];
  lastSweepAt: string | null;
}

/** 넣는 즉시 지우는, 다시 만들 수 있는 폴더 이름(규칙 3). */
export const REBUILDABLE_DIRS = ['node_modules', 'target', 'dist', 'build'] as const;

export function emptyLedger(): CleanupLedger {
  return { version: 1, items: [], events: [], lastSweepAt: null };
}

export function clampGraceDays(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return CLEANUP_GRACE_DEFAULT;
  return Math.min(CLEANUP_GRACE_MAX, Math.max(CLEANUP_GRACE_MIN, Math.round(n)));
}

// ── 러너 → 오퍼레이터 보고 ───────────────────────────────────────────────────
//
// 오퍼레이터는 러너의 상태 트리(`sessions.json` 이 사는 곳)를 **읽지도 쓰지도 않는다**(#431 D5 — writer 가 둘이 되면 조용한
// lost update). 그래서 "이 worktree 는 어느 스레드 것인가"·"이 스레드의 마지막 턴"·"지금 도는 턴"은 러너가 relay 로
// 알린다(`/agent/turn-slots` 와 같은 틀 — 오퍼레이터가 받아 서버로 넘기지 않는다).

export const CLEANUP_REPORT_PATH = '/agent/cleanup-report';

export interface CleanupThreadReport extends CleanupThreadRef {
  /** 이 스레드의 턴이 만든 worktree 경로들(턴 앞뒤 `git worktree list` 비교, 또는 세션 기록의 `worktree add`). */
  worktrees: string[];
  /** 이 스레드의 마지막 턴 시각(ISO). 모르면 null. */
  lastTurnAt: string | null;
  /** 지금 이 스레드의 턴이 도는가. */
  running: boolean;
  /**
   * 이 스레드의 작업 폴더(러너 상태 트리 안). 7일 넘게 턴이 없으면 이 경로가 「스레드 폴더」 항목이 된다(규칙 6).
   * 오퍼레이터는 이 폴더를 **지우지도 재지도 않는다** — 지우기는 답(`deleteThreads`)으로 러너에게 맡긴다.
   */
  workspaceDir?: string | null;
}

export interface CleanupReport {
  threads: CleanupThreadReport[];
  /** 앞 답의 `deleteThreads` 를 러너가 지웠다(작업 폴더·세션 기록·세션 레코드). */
  deleted?: CleanupThreadRef[];
}

/** 보고의 답 — 기한이 지나 검사를 통과한, 이 러너가 지울 스레드들. */
export interface CleanupReportReply { deleteThreads: CleanupThreadRef[] }

const UUIDISH = /^[0-9a-f-]{36}$/i;
const MAX_REPORT_THREADS = 2000;
const MAX_REPORT_WORKTREES = 50;

/** 러너가 보낸 본문을 거른다. 모양이 틀린 줄은 버린다(통째로 거절하지 않는다 — 한 줄 때문에 나머지를 잃지 않게). */
/** `lastTurnAt` 이 미래면 `now` 로 자른다 — 미래 시각은 주인을 계속 가져가고 항목을 영영 되살린다. */
export function readCleanupReport(body: unknown, now: number = Date.now()): CleanupReport | null {
  const b = body as { threads?: unknown } | null;
  if (!b || !Array.isArray(b.threads)) return null;
  const threads: CleanupThreadReport[] = [];
  for (const t of b.threads.slice(0, MAX_REPORT_THREADS)) {
    const x = t as Partial<CleanupThreadReport> | null;
    if (!x || typeof x.channelId !== 'string' || !UUIDISH.test(x.channelId)) continue;
    if (typeof x.threadRootId !== 'string' || !UUIDISH.test(x.threadRootId)) continue;
    const worktrees = Array.isArray(x.worktrees)
      ? x.worktrees.filter((w): w is string => typeof w === 'string' && w.startsWith('/') && w.length < 1024).slice(0, MAX_REPORT_WORKTREES)
      : [];
    const t0 = typeof x.lastTurnAt === 'string' ? Date.parse(x.lastTurnAt) : Number.NaN;
    const lastTurnAt = Number.isNaN(t0) ? null : new Date(Math.min(t0, now)).toISOString();
    const workspaceDir = typeof x.workspaceDir === 'string' && x.workspaceDir.startsWith('/') && x.workspaceDir.length < 1024 ? x.workspaceDir : null;
    threads.push({ channelId: x.channelId, threadRootId: x.threadRootId, worktrees, lastTurnAt, running: x.running === true, workspaceDir });
  }
  const deleted = Array.isArray((b as { deleted?: unknown }).deleted)
    ? ((b as { deleted: unknown[] }).deleted).flatMap((d) => {
      const x = d as Partial<CleanupThreadRef> | null;
      return x && typeof x.channelId === 'string' && UUIDISH.test(x.channelId) && typeof x.threadRootId === 'string' && UUIDISH.test(x.threadRootId)
        ? [{ channelId: x.channelId, threadRootId: x.threadRootId }] : [];
    }).slice(0, MAX_REPORT_THREADS)
    : [];
  return { threads, ...(deleted.length ? { deleted } : {}) };
}

/** `/tmp/x` 와 `/private/tmp/x` 는 같은 곳이다(macOS). 끝 슬래시도 뗀다. 경로 비교는 이 모양으로. */
export function normalizeCleanupPath(p: string): string {
  let s = p;
  if (s.startsWith('/private/tmp/')) s = s.slice('/private'.length);
  return s.replace(/\/+$/, '');
}

/** claude 가 `projects/` 아래 디렉터리 이름을 짓는 법 — 작업 폴더 경로의 영숫자·`-` 밖 글자를 `-` 로. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * 세션 기록 글에서 `git worktree add` 의 대상 경로를 뽑는다(`-b x`·`--detach` 같은 플래그는 건너뛴다). 변수로 지은
 * 경로(`$W`)처럼 글에 절대 경로가 안 드러나면 못 뽑는다 — 그것은 주인 모름으로 남는다(사람이 고른다).
 */
export function worktreeAddPaths(text: string, home: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/worktree add\b([^"\n]{0,400})/g)) {
    const toks = m[1]!.replace(/\\[nt]/g, ' ').split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t === '-b' || t === '-B' || t === '--reason') { i++; continue; }
      if (t.startsWith('-')) continue;
      if (/^[;&|]/.test(t)) break;
      const clean = t.replace(/[;&|)]+$/, '');
      if (clean.startsWith('/')) out.push(normalizeCleanupPath(clean));
      else if (clean.startsWith('~/')) out.push(normalizeCleanupPath(`${home}/${clean.slice(2)}`));
      break;
    }
  }
  return out;
}

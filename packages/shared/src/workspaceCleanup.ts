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

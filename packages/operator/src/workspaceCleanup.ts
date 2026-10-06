/**
 * 작업 폴더 청소기 — 「삭제 예정 → N일 뒤 삭제」(스레드 9e909150 설계, 시안 v3).
 *
 * 두 층으로 나눴다:
 * - `planSweep` — **순수 함수**. 원장 + 이번 회차에 잰 사실 → 새 원장 + 할 일. 규칙은 전부 여기 있다.
 * - `runSweep` — 할 일을 포트(git·파일)로 실행한다. 지우기 직전 검사도 여기서 **다시** 잰다 — 계획과 실행 사이에
 *   사람이 커밋했을 수 있다.
 *
 * 지키는 것:
 * - `unowned`·`kept` 는 청소기가 바꾸지 않는다(사람만 바꾼다).
 * - 그 스레드에 새 턴이 오면 목록에서 뺀다(되살리기).
 * - 의존성 폴더가 심링크면 **링크만** 지운다 — PR worktree 의 `node_modules` 는 공유 트리를 가리키는 일이 많다.
 */
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CLEANUP_STATES,
  REBUILDABLE_DIRS,
  clampGraceDays,
  emptyLedger,
  type CleanupBlockReason,
  type CleanupEvent,
  type CleanupItem,
  type CleanupKind,
  type CleanupLedger,
  type CleanupPr,
  type CleanupSettings,
  type CleanupThreadRef,
} from '@harkroom/shared/workspaceCleanup';

const DAY_MS = 86_400_000;
/** 최근 기록은 이만큼만 둔다 — 화면은 최근 것만 보여 준다. */
export const MAX_EVENTS = 200;

// ── 원장 파일 ─────────────────────────────────────────────────────────────────

export function cleanupLedgerPath(appDataDir: string): string {
  return join(appDataDir, 'cleanup', 'ledger.json');
}

function isItem(v: unknown): v is CleanupItem {
  const i = v as Partial<CleanupItem> | null;
  return !!i && typeof i.path === 'string' && typeof i.kind === 'string'
    && (CLEANUP_STATES as readonly string[]).includes(i.state as string);
}

/** 없거나 깨졌으면 빈 원장이다. 깨진 파일은 덮어쓰기 전에 옆으로 치운다(무엇이 있었는지 사람이 볼 수 있게). */
export async function readLedger(path: string): Promise<CleanupLedger> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return emptyLedger(); }
  try {
    const raw = JSON.parse(text) as Partial<CleanupLedger>;
    if (raw?.version !== 1 || !Array.isArray(raw.items)) throw new Error('shape');
    return {
      version: 1,
      items: raw.items.filter(isItem),
      events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
      lastSweepAt: typeof raw.lastSweepAt === 'string' ? raw.lastSweepAt : null,
    };
  } catch {
    await rename(path, `${path}.broken-${Date.now()}`).catch(() => {});
    return emptyLedger();
  }
}

/** 임시 파일에 쓰고 rename — 쓰다 죽어도 반쪽 원장이 남지 않는다. */
export async function writeLedger(path: string, ledger: CleanupLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

// ── 이번 회차에 잰 사실 ──────────────────────────────────────────────────────

export interface ObservedWorktree {
  path: string;
  repo: string;
  branch: string | null;
  headSha: string | null;
  /** null = 어느 스레드 것인지 모른다. */
  thread: CleanupThreadRef | null;
  pr: CleanupPr | null;
  lastModifiedAt: string | null;
  size: number | null;
}

export interface ObservedIdle {
  path: string;
  kind: Exclude<CleanupKind, 'worktree'>;
  thread: CleanupThreadRef;
  size: number | null;
  lastModifiedAt: string | null;
}

export interface SweepFacts {
  worktrees: ObservedWorktree[];
  /** 7일 넘게 턴이 없는 스레드의 폴더·세션 기록(규칙 6). 러너 사실에서 온다. */
  idle: ObservedIdle[];
  /** 스레드 상태가 ✅(done)인 스레드 키. */
  doneThreads: ReadonlySet<string>;
  /** 스레드 키 → 마지막 턴 시각(ISO). 목록에 넣은 뒤 새 턴이 왔는지 본다. */
  lastTurnAt: ReadonlyMap<string, string>;
  /** 지금 턴이 도는 스레드 키. */
  runningThreads: ReadonlySet<string>;
}

export function threadKey(t: CleanupThreadRef): string {
  return `${t.channelId}/${t.threadRootId}`;
}

// ── 계획 ─────────────────────────────────────────────────────────────────────

export type SweepAction =
  | { op: 'removeDeps'; path: string }
  | { op: 'delete'; path: string };

export interface SweepPlan {
  ledger: CleanupLedger;
  actions: SweepAction[];
}

function blank(path: string, kind: CleanupKind): CleanupItem {
  return {
    path, kind, state: 'unowned', repo: null, branch: null, headSha: null, thread: null, pr: null,
    lastModifiedAt: null, listedAt: null, deleteAfter: null, blockReason: null,
    actedBy: null, actedAt: null, sizeBefore: null, sizeNow: null,
  };
}

function event(at: string, item: CleanupItem, action: CleanupEvent['action'], extra?: Partial<CleanupEvent>): CleanupEvent {
  return { at, path: item.path, thread: item.thread, action, by: null, bytes: null, reason: null, ...extra };
}

/** 규칙 1: PR 이 머지·닫힘 **그리고** 스레드 ✅. */
function qualifies(w: ObservedWorktree, facts: SweepFacts): boolean {
  return !!w.thread && !!w.pr && w.pr.state !== 'open' && facts.doneThreads.has(threadKey(w.thread));
}

export function planSweep(prev: CleanupLedger, facts: SweepFacts, settings: CleanupSettings, now: Date): SweepPlan {
  const at = now.toISOString();
  const grace = clampGraceDays(settings.graceDays) * DAY_MS;
  const events: CleanupEvent[] = [];
  const actions: SweepAction[] = [];
  const byPath = new Map(prev.items.map((i) => [i.path, i]));
  const seen = new Set<string>();
  const out: CleanupItem[] = [];

  const list = (item: CleanupItem): CleanupItem => {
    const next: CleanupItem = { ...item, state: 'listed', listedAt: at, deleteAfter: new Date(now.getTime() + grace).toISOString(), blockReason: null };
    events.push(event(at, next, 'listed'));
    actions.push({ op: 'removeDeps', path: next.path });
    return next;
  };

  const step = (observed: CleanupItem, eligible: boolean) => {
    seen.add(observed.path);
    const old = byPath.get(observed.path);
    if (!old) {
      if (!observed.thread) { out.push(observed); return; } // 주인 모름 — 보이기만 한다
      if (eligible && settings.enabled) out.push(list(observed));
      return; // 아직 조건이 안 됐으면 원장에 올리지 않는다
    }
    // 잰 사실(PR·크기·주인)은 새 값으로, 사람이 정한 것(state·actedBy)은 그대로.
    let item: CleanupItem = {
      ...old,
      repo: observed.repo ?? old.repo, branch: observed.branch, headSha: observed.headSha,
      thread: old.thread ?? observed.thread, pr: observed.pr ?? old.pr,
      lastModifiedAt: observed.lastModifiedAt ?? old.lastModifiedAt,
      sizeNow: observed.sizeNow ?? old.sizeNow,
    };
    if (item.state === 'unowned' && item.thread && item.actedBy === null && eligible && settings.enabled) {
      item = list(item); // 나중에 주인이 밝혀졌고 조건도 맞는다
    }
    if ((item.state === 'listed' || item.state === 'blocked') && item.thread && item.listedAt) {
      const last = facts.lastTurnAt.get(threadKey(item.thread));
      if (last && last > item.listedAt) { // 규칙 4: 새 턴이 왔다 → 목록에서 뺀다
        events.push(event(at, item, 'revived'));
        return;
      }
    }
    if (settings.enabled && (item.state === 'listed' || item.state === 'blocked') && item.deleteAfter && item.deleteAfter <= at) {
      actions.push({ op: 'delete', path: item.path });
    }
    out.push(item);
  };

  for (const w of facts.worktrees) {
    const item: CleanupItem = {
      ...blank(w.path, 'worktree'),
      repo: w.repo, branch: w.branch, headSha: w.headSha, thread: w.thread, pr: w.pr,
      lastModifiedAt: w.lastModifiedAt, sizeBefore: w.size, sizeNow: w.size,
    };
    step(item, qualifies(w, facts));
  }
  for (const d of facts.idle) {
    step({ ...blank(d.path, d.kind), thread: d.thread, lastModifiedAt: d.lastModifiedAt, sizeBefore: d.size, sizeNow: d.size }, true);
  }
  // 이번에 안 보인 항목: 폴더가 이미 없다 → 원장에서 뺀다(지운 기록은 events 에 있다).
  // 단 사람이 「보존」한 것은 남긴다 — 다음 회차에 다시 보일 수 있고, 보존한 사실을 잃으면 안 된다.
  for (const old of prev.items) if (!seen.has(old.path) && old.state === 'kept') out.push(old);

  return {
    ledger: { version: 1, items: out, events: [...prev.events, ...events].slice(-MAX_EVENTS), lastSweepAt: at },
    actions,
  };
}

// ── 사람의 손 ────────────────────────────────────────────────────────────────

export type HumanAction = 'keep' | 'unkeep' | 'list';

/**
 * 「보존」(→kept)·「목록으로 되돌리기」(kept→listed, 기한을 오늘부터 다시)·「삭제 예정에 넣기」(unowned→listed).
 * 넣기면 의존성 폴더 지우기를 돌려준다 — 넣는 순간 지우는 것은 사람이 넣어도 같다.
 */
export function applyHumanAction(
  prev: CleanupLedger, path: string, action: HumanAction, by: string, settings: CleanupSettings, now: Date,
): { ledger: CleanupLedger; actions: SweepAction[] } {
  const at = now.toISOString();
  const idx = prev.items.findIndex((i) => i.path === path);
  if (idx < 0) throw new Error('no such cleanup item');
  const item = prev.items[idx]!;
  let next: CleanupItem;
  let ev: CleanupEvent['action'];
  const actions: SweepAction[] = [];
  if (action === 'keep') {
    if (item.state === 'deleted') throw new Error('already deleted');
    next = { ...item, state: 'kept', deleteAfter: null, blockReason: null };
    ev = 'kept';
  } else {
    const from: CleanupItem['state'] = action === 'unkeep' ? 'kept' : 'unowned';
    if (item.state !== from) throw new Error(`cannot ${action} from ${item.state}`);
    next = {
      ...item, state: 'listed', listedAt: at, blockReason: null,
      deleteAfter: new Date(now.getTime() + clampGraceDays(settings.graceDays) * DAY_MS).toISOString(),
    };
    ev = action === 'unkeep' ? 'unkept' : 'listed';
    actions.push({ op: 'removeDeps', path });
  }
  next = { ...next, actedBy: by, actedAt: at };
  const items = prev.items.slice();
  items[idx] = next;
  const e = { ...event(at, next, ev), by };
  return { ledger: { ...prev, items, events: [...prev.events, e].slice(-MAX_EVENTS) }, actions };
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

export interface CleanupPorts {
  /** 지우기 직전 검사. 통과면 null. */
  check(item: CleanupItem, runningThreads: ReadonlySet<string>): Promise<CleanupBlockReason | null>;
  /** worktree 면 `git worktree remove` + (원격·PR head 에 들어 있으면) 브랜치 삭제, 아니면 폴더 삭제. */
  remove(item: CleanupItem): Promise<void>;
  size(path: string): Promise<number | null>;
  /** 다시 만들 수 있는 폴더만 지운다(`removeRebuildable`). */
  removeDeps(root: string): Promise<void>;
}

/**
 * 다시 만들 수 있는 폴더를 지운다. **심링크면 링크만** — 따라가서 공유 트리를 지우면 안 된다.
 *
 * 이름만 보고 지우지 않는다: `safe(name)` 이 참일 때만(그 저장소가 그 폴더를 무시하고, 올려 둔 파일이 없을 때) 지운다.
 * 다른 저장소는 `build/`·`dist/` 를 올려 두거나 손 파일을 둘 수 있다 — 그것은 다시 만들 수 있는 폴더가 아니다.
 */
export async function removeRebuildable(root: string, safe: (name: string) => Promise<boolean>): Promise<void> {
  for (const name of REBUILDABLE_DIRS) {
    const p = join(root, name);
    const st = await lstat(p).catch(() => null);
    if (!st || !(st.isSymbolicLink() || st.isDirectory())) continue;
    if (!(await safe(name))) continue;
    if (st.isSymbolicLink()) await unlink(p);
    else await rm(p, { recursive: true, force: true });
  }
}

export async function runSweep(
  plan: SweepPlan, ports: CleanupPorts, runningThreads: ReadonlySet<string>, now: Date,
): Promise<CleanupLedger> {
  const at = now.toISOString();
  const items = plan.ledger.items.slice();
  const events = plan.ledger.events.slice();
  for (const a of plan.actions) {
    const idx = items.findIndex((i) => i.path === a.path);
    if (idx < 0) continue;
    const item = items[idx]!;
    if (a.op === 'removeDeps') {
      // worktree 만 — 스레드 폴더·세션 기록에는 의존성 폴더가 없고, 있더라도 통째로 지울 것이다.
      if (item.kind !== 'worktree') continue;
      try {
        await ports.removeDeps(item.path);
        const sizeNow = await ports.size(item.path);
        items[idx] = { ...item, sizeNow };
        const freed = item.sizeNow !== null && sizeNow !== null ? Math.max(0, item.sizeNow - sizeNow) : null;
        events.push(event(at, item, 'deps-removed', { bytes: freed }));
      } catch { /* 다음 회차에 다시 */ }
      continue;
    }
    const reason = await ports.check(item, runningThreads);
    if (reason) {
      if (item.blockReason !== reason) events.push(event(at, item, 'blocked', { reason }));
      items[idx] = { ...item, state: 'blocked', blockReason: reason };
      continue;
    }
    try {
      await ports.remove(item);
      items[idx] = { ...item, state: 'deleted', blockReason: null, sizeNow: 0 };
      events.push(event(at, item, 'deleted', { bytes: item.sizeNow }));
    } catch { /* 지우다 실패 — 원장은 그대로, 다음 회차에 다시 */ }
  }
  return { ...plan.ledger, items: items.filter((i) => i.state !== 'deleted'), events: events.slice(-MAX_EVENTS) };
}

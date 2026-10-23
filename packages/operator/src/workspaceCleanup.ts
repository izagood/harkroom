/**
 * 작업 폴더 청소기 — 「삭제 예정 → N일 뒤 삭제」(스레드 9e909150 설계, 시안 v3).
 *
 * 두 층으로 나눴다:
 * - `planSweep` — **순수 함수**. 원장 + 이번 회차에 잰 사실 → 새 원장 + 할 일. 규칙은 전부 여기 있다.
 * - `runSweep` — 할 일을 포트(git·파일)로 실행한다. 지우기 직전 검사도 여기서 **다시** 잰다 — 계획과 실행 사이에
 *   사람이 커밋했을 수 있다.
 *
 * 지키는 것:
 * - `kept` 는 청소기가 바꾸지 않는다(사람만 바꾼다). `unowned` 는 사람이 넣거나, 아래 「주인 모름 자동」 조건을 **모두**
 *   만족할 때만 넣는다(`qualifiesUnowned`).
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
  /**
   * 주인 모름 자동 후보만 잰다(아니면 비움): 커밋 안 된 변경도 push 안 된 커밋도 없는가 — 지우기 직전 검사(`check`)와 같은 판정.
   */
  clean?: boolean | null;
  /** 주인 모름 자동 후보만: 마지막으로 손댄 흔적(HEAD 커밋·HEAD reflog·worktree 를 만든 시각 중 늦은 것). */
  lastActivityAt?: string | null;
  /** 주인 모름 자동 후보만: 무시된 파일이 다시 만들 수 있는 폴더(`REBUILDABLE_DIRS`) 안에만 있는가 — `.env` 같은 손 파일이 없는가. */
  onlyRebuildableIgnored?: boolean | null;
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

/**
 * 주인 모름 자동(소유자 10-19 #task c77dcd20): 스레드를 모르는 worktree 도 아래를 **모두** 만족하면 목록에 넣는다.
 * - PR 이 머지·닫힘이고 그 PR head 가 worktree HEAD 와 **같다**(조상은 안 된다 — 주인이 없으니 더 좁게).
 * - 커밋 안 된 변경·push 안 된 커밋이 없다(`clean`). 무시된 파일도 다시 만들 수 있는 폴더 안에만 있다(`onlyRebuildableIgnored`) —
 *   주인 모름엔 사람이 손으로 만든 worktree 도 들어가고, `worktree remove` 는 무시된 `.env`·로컬 DB 도 함께 지운다.
 * - 보존 기간보다 오래 손대지 않았다 — 주인 스레드가 없어 「새 턴이면 되살리기」를 못 하므로 이것으로 대신한다.
 * PR 이 열려 있거나 없으면 지금처럼 보이기만 한다.
 */
/** 조건 1·2 — PR 이 머지·닫힘이고 PR head 가 HEAD 와 같다. 넣은 뒤 이것이 깨지면(새 커밋·PR 다시 열림) 되살린다. */
export function unownedPrMatches(w: Pick<ObservedWorktree, 'pr' | 'headSha'>): boolean {
  return !!w.pr && w.pr.state !== 'open' && !!w.headSha && w.pr.headSha === w.headSha;
}

export function qualifiesUnowned(w: ObservedWorktree, settings: CleanupSettings, now: Date): boolean {
  if (w.thread || !unownedPrMatches(w)) return false;
  if (w.clean !== true || w.onlyRebuildableIgnored !== true || !w.lastActivityAt) return false;
  return Date.parse(w.lastActivityAt) <= now.getTime() - clampGraceDays(settings.graceDays) * DAY_MS;
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

  const step = (observed: CleanupItem, eligible: boolean, unowned: { activityAt: string | null; prMatches: boolean } | null = null) => {
    seen.add(observed.path);
    const old = byPath.get(observed.path);
    if (!old) {
      // 주인 모름 — 자동 조건을 다 맞추지 않으면 보이기만 한다.
      if (!observed.thread) { out.push(eligible && settings.enabled ? list(observed) : observed); return; }
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
    if (item.state === 'unowned' && item.actedBy === null && eligible && settings.enabled) {
      item = list(item); // 나중에 주인이 밝혀졌고 조건도 맞는다, 또는 주인 모름 자동 조건을 다 맞췄다
    }
    // 주인 모름을 자동으로 넣은 뒤 누가 손댔다 → 되살린다. 스레드가 없으니 이것이 규칙 4 를 대신한다.
    // - 조건 1·2 가 깨짐(새 커밋으로 HEAD ≠ PR head, PR 다시 열림·못 읽음): 손댄 시각을 재지 못해도 이것만으로(security F1).
    //   여기서 돌아가므로 원장의 headSha 를 새 HEAD 로 덮지 않는다 — 덮으면 지우기 직전 HEAD 재확인이 새 커밋을 놓친다.
    // - 손댄 흔적(커밋·checkout·reset·다시 만든 worktree)이 넣은 뒤에 생김.
    if (unowned && (old.state === 'listed' || old.state === 'blocked') && !old.thread && old.actedBy === null && old.listedAt
      && (!unowned.prMatches || (unowned.activityAt !== null && unowned.activityAt > old.listedAt))) {
      events.push(event(at, old, 'revived'));
      return;
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
    step(item, w.thread ? qualifies(w, facts) : qualifiesUnowned(w, settings, now),
      w.thread ? null : { activityAt: w.lastActivityAt ?? null, prMatches: unownedPrMatches(w) });
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
export async function removeRebuildable(root: string, safe: (name: string, symlink: boolean) => Promise<boolean>): Promise<void> {
  for (const name of REBUILDABLE_DIRS) {
    const p = join(root, name);
    const st = await lstat(p).catch(() => null);
    if (!st || !(st.isSymbolicLink() || st.isDirectory())) continue;
    if (!(await safe(name, st.isSymbolicLink()))) continue;
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

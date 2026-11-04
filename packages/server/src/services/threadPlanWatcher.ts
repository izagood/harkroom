/**
 * 스레드 계획판 2차(P6) — 자동 갱신 구독기.
 *
 * `startThreadStatusWatcher` 와 같은 꼴이다(architect W1): 이벤트 버스 하나를 구독하고, 루트마다 debounce·직렬로 돈다.
 * 메시지를 쓰는 자리(REST·MCP·래퍼 보고·카드 답)마다 부르지 않는다 — 경로가 늘 때 하나씩 빠진다.
 *
 * 하는 일:
 * - 래퍼 머지 줄(`meta.merge.result === 'merged'`) → **같은 스레드** 계획에서 그 `pr repo#n` 을 단 단계를 done(W3).
 *   queued·failed 는 손대지 않는다.
 * - 카드 답(`meta.ask.answeredWith`) → 같은 스레드 계획에서 그 `card` 를 단 blocked 단계를 active.
 * - 자식 계획이 바뀜(`thread.plan.changed`) → `thread_plan_link` 로 부모를 찾아 부모 이벤트를 **청중 맵**으로 낸다(W5).
 *   1단만 간다 — 전파로 낸 부모 이벤트(`via: 'linked'`)는 다시 전파하지 않는다.
 * - 위 자동 갱신·부모 전파 때문에 새로 시작 가능해진 노드가 있으면 시스템 줄 하나(W4, 멘션 없음 K6).
 *
 * 자동 쓰기도 `writeThreadPlan(..., { system: true }, build)` 한 경로를 탄다(W2) — 잠근 판(for update)에서 병합하고,
 * 바꿀 것이 없으면 `unchanged` 로 되돌려 rev 를 올리지 않는다. 그 쓰기가 내는 `thread.plan.changed` 는 이 구독기를
 * 다시 깨우지만, 그 경로는 부모 전파·ready 캐시 갱신만 하고 계획을 쓰지 않으므로 고리가 생기지 않는다(W6).
 */
import type { Pool } from 'pg';
import { derivePlan, planProgress, type PlanDoc, type PlanDerived } from '@harkroom/shared';
import { emitEvent, emitPosted, onEvent, type WorkspaceEvent } from '../events.js';
import { assertChannelVisible, audienceFor } from './channels.js';
import { getThreadPlan, linkedFor, writeThreadPlan, type ThreadPlanRow } from './threadPlan.js';
import { postMessage } from './messages.js';
import { systemI18n } from './systemI18n.js';
import { wakePlanAuto } from './threadPlanAuto.js';

type Unchanged = { code: 'unchanged' };

/** 머지 줄 → 그 PR 을 단 단계를 done 으로. 바꿀 것이 없으면 null. */
export function applyMergedPr(doc: PlanDoc, repo: string, number: number): PlanDoc | null {
  const r = repo.toLowerCase();
  let changed = false;
  const steps = doc.steps.map((s) => {
    if (s.state === 'done') return s;
    const hit = s.links.some((l) => l.kind === 'pr' && l.number === number && l.repo.toLowerCase() === r);
    if (!hit) return s;
    changed = true;
    return { ...s, state: 'done' as const, blockedReason: null };
  });
  return changed ? { ...doc, steps } : null;
}

/** 카드 답 → 그 카드를 단 blocked 단계를 active 로. 바꿀 것이 없으면 null. */
export function applyAnsweredCard(doc: PlanDoc, messageId: string): PlanDoc | null {
  const id = messageId.toLowerCase();
  let changed = false;
  const steps = doc.steps.map((s) => {
    if (s.state !== 'blocked') return s;
    if (!s.links.some((l) => l.kind === 'card' && l.messageId.toLowerCase() === id)) return s;
    changed = true;
    return { ...s, state: 'active' as const, blockedReason: null };
  });
  return changed ? { ...doc, steps } : null;
}

/**
 * 새로 시작 가능해진 노드(N2): **앞 판에도 있던** 노드 중 앞에선 ready 가 아니었고 지금 ready 인 것.
 * 새로 더한 노드는 세지 않는다 — 방금 세운 단계로 「이제 시작 가능」 줄이 서면 소음이다.
 * hidden(청중이 못 보는 연결 그룹)은 ready 가 될 수 없으므로 자연히 빠진다.
 */
export function readyDiff(before: PlanDerived, after: PlanDerived): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(after)) {
    const prev = before[id];
    if (!prev) continue;
    if (node.derived === 'ready' && prev.derived !== 'ready') out.push(id);
  }
  return out;
}

/**
 * D1: 이번 변화의 원인이 청중이 못 보는 연결 그룹이면 줄을 내지 않는다. ready 가 된 노드가 기다리던 것 중 하나라도
 * 앞 판에서 hidden 이었으면(= 못 보는 자식이 끝나서 풀렸다) 그 노드는 뺀다.
 */
function dropHiddenCaused(ids: string[], doc: PlanDoc, before: PlanDerived): string[] {
  const groups = new Map(doc.groups.map((g) => [g.id, g]));
  const steps = new Map(doc.steps.map((s) => [s.id, s]));
  return ids.filter((id) => {
    const deps = [...(groups.get(id)?.dependsOn ?? []), ...(steps.get(id)?.dependsOn ?? [])];
    const parent = steps.get(id)?.groupId ? groups.get(steps.get(id)!.groupId!) : undefined;
    deps.push(...(parent?.dependsOn ?? []));
    return !deps.some((d) => before[d]?.derived === 'hidden');
  });
}

function titleOf(doc: PlanDoc, id: string): string {
  return doc.groups.find((g) => g.id === id)?.title ?? doc.steps.find((s) => s.id === id)?.title ?? id;
}

/** 청중 맵(부모 채널 청중 전원에게 한 값)으로 센 파생 상태. */
async function audienceDerived(pool: Pool, row: ThreadPlanRow): Promise<PlanDerived> {
  const { map } = await linkedFor(pool, row.doc, { audience: row.channelId });
  return derivePlan(row.doc, map);
}

export function startThreadPlanWatcher(
  pool: Pool,
  opts: { debounceMs?: number; onError?: (err: unknown) => void } = {},
): { stop(): void; flush(): Promise<void> } {
  const debounceMs = opts.debounceMs ?? 300;
  const onError = opts.onError ?? ((err) => console.error('thread plan watcher error:', err));

  /**
   * 루트별 마지막 청중 파생 상태 — 부모 전파 때 「앞 판」 역할을 한다(자식이 바뀐 뒤에는 부모의 앞 판을 DB 에서 다시
   * 셀 수 없다). 처음 보는 루트는 앞 판이 없으므로 줄을 내지 않는다(N2 쪽으로 보수적). 프로세스 메모리라 재시작하면 빈다.
   */
  const lastDerived = new Map<string, PlanDerived>();
  const remember = (rootId: string, d: PlanDerived) => {
    lastDerived.delete(rootId);
    lastDerived.set(rootId, d);
    if (lastDerived.size > 5000) lastDerived.delete(lastDerived.keys().next().value!);
  };

  /** 루트마다 일감 큐를 두고 한 번에 하나만 돈다(threadStatus N1 과 같은 이유 — 낡은 판이 나중에 써지지 않게). */
  const queues = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();
  const enqueue = (rootId: string, job: () => Promise<void>) => {
    const prev = queues.get(rootId) ?? Promise.resolve();
    const p = prev.then(job).catch(onError).finally(() => {
      inflight.delete(p);
      if (queues.get(rootId) === p) queues.delete(rootId);
    });
    queues.set(rootId, p);
    inflight.add(p);
  };

  /**
   * 이미 반영한 카드 답(architect R2) — 답한 카드 글은 그 뒤에도 다른 이유로 `message.updated` 가 난다. 처음 답이 실린
   * 갱신에서만 단계를 active 로 바꾼다. 그러지 않으면 에이전트가 새 이유로 다시 막아 둔 단계가 다음 갱신에 뒤집힌다.
   */
  const answeredCards = new Set<string>();
  const markAnswered = (cardId: string): boolean => {
    if (answeredCards.has(cardId)) return false;
    answeredCards.add(cardId);
    if (answeredCards.size > 5000) answeredCards.delete(answeredCards.values().next().value!);
    return true;
  };

  /** 부모 전파는 debounce 한다 — 자식 에이전트가 단계를 몇 번 연달아 고쳐도 부모 이벤트는 한 번. */
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const schedule = (rootId: string, job: () => Promise<void>) => {
    const prev = pending.get(rootId);
    if (prev) clearTimeout(prev);
    pending.set(rootId, setTimeout(() => { pending.delete(rootId); enqueue(rootId, job); }, debounceMs));
  };
  const scheduled = new Map<string, () => Promise<void>>();
  const scheduleJob = (rootId: string, job: () => Promise<void>) => {
    scheduled.set(rootId, job);
    schedule(rootId, async () => { scheduled.delete(rootId); await job(); });
  };

  /**
   * ready 줄. 저자는 후보 중 **그 채널을 볼 수 있는** 첫 계정이다(architect R3) — 부모 전파면 자식을 쓴 계정이 부모 채널
   * 멤버가 아닐 수 있다. 아무도 없으면 내지 않는다.
   *
   * 본문·i18n 인자에는 고정 문구와 노드 id 만 싣는다(architect R1) — 단계 제목은 남이 쓴 글이라 본문에 넣으면 `postMessage` 가
   * 그 안의 `@handle` 을 멘션으로 푼다(K6 「멘션 없음」). 제목은 meta.planReady.titles 에만 둔다.
   */
  const postReady = async (row: ThreadPlanRow, before: PlanDerived, after: PlanDerived, authors: (string | null)[]) => {
    const ids = dropHiddenCaused(readyDiff(before, after), row.doc, before);
    if (!ids.length) return;
    let authorId: string | null = null;
    for (const a of authors) {
      if (a && await assertChannelVisible(pool, row.channelId, a)) { authorId = a; break; }
    }
    if (!authorId) return;
    const list = ids.join(' · ');
    const posted = await postMessage(pool, {
      channelId: row.channelId, threadRootId: row.rootId, authorId, kind: 'system', serverNotice: true, noMentions: true,
      body: `▶ 이제 시작할 수 있는 단계 ${ids.length}개: ${list}`,
      meta: {
        planReady: { ids, rev: row.rev, titles: Object.fromEntries(ids.map((id) => [id, titleOf(row.doc, id)])) },
        i18n: systemI18n('system.plan.ready', { n: ids.length, ids: list }),
      },
    } as Parameters<typeof postMessage>[1]);
    if (!posted.failure) emitPosted(posted, await audienceFor(pool, row.channelId));
  };

  /** 자동 갱신 한 번. build 가 null 이면 바꿀 것이 없다(rev 를 올리지 않는다). */
  const autoUpdate = async (rootId: string, authorId: string, build: (doc: PlanDoc) => PlanDoc | null) => {
    const res = await writeThreadPlan<Unchanged>(pool, rootId, { system: true }, (prev) => {
      if (!prev) return { error: { code: 'unchanged' } };
      const next = build(prev.doc);
      return next ? { doc: next } : { error: { code: 'unchanged' } };
    });
    if (!res.ok || !('row' in res) || !res.before) return;
    const after = await audienceDerived(pool, res.row);
    const { map } = await linkedFor(pool, res.before, { audience: res.row.channelId });
    remember(rootId, after);
    await postReady(res.row, derivePlan(res.before, map), after, [authorId]);
  };

  /** 자식 계획이 바뀌었다 → 부모마다 청중 맵으로 이벤트, 새로 ready 가 된 것이 있으면 줄. */
  /** 자동 진행 한 번. 실패가 구독기를 멈추지 않는다 — 다음 판 변화에서 다시 돈다. */
  const wakeAuto = async (rootId: string): Promise<void> => {
    try {
      await wakePlanAuto(pool, rootId);
    } catch (err) {
      console.error(`[threadPlanWatcher] 자동 진행 실패 root=${rootId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const propagate = async (childRoot: string, authorId: string | null) => {
    const parents = await pool.query(`select parent_root from thread_plan_link where child_root = $1`, [childRoot]);
    for (const { parent_root: parentRoot } of parents.rows as { parent_root: string }[]) {
      enqueue(parentRoot, async () => {
        const row = await getThreadPlan(pool, parentRoot);
        if (!row) return;
        const after = await audienceDerived(pool, row);
        const before = lastDerived.get(parentRoot);
        remember(parentRoot, after);
        const { map } = await linkedFor(pool, row.doc, { audience: row.channelId });
        emitEvent({
          type: 'thread.plan.changed', channelId: row.channelId, rootId: parentRoot, rev: row.rev,
          progress: planProgress(row.doc, map), audience: await audienceFor(pool, row.channelId), via: 'linked',
        });
        // 저자: 자식을 쓴 계정이 부모 채널을 보면 그 계정, 아니면 부모 계획을 마지막으로 쓴 계정(R3).
        if (before) await postReady(row, before, after, [authorId, row.updatedBy]);
        await wakeAuto(parentRoot);
      });
    }
  };

  const off = onEvent((e: WorkspaceEvent) => {
    if (e.type === 'thread.plan.changed') {
      // 전파로 낸 부모 이벤트는 다시 전파하지 않는다(1단, W5·W6).
      if (e.via === 'linked') return;
      const rootId = e.rootId;
      scheduleJob(rootId, async () => {
        const row = await getThreadPlan(pool, rootId);
        if (row) remember(rootId, await audienceDerived(pool, row));
        else lastDerived.delete(rootId);
        await wakeAuto(rootId);
        await propagate(rootId, row?.updatedBy ?? null);
      });
      return;
    }
    if (e.type !== 'message.created' && e.type !== 'message.updated') return;
    const m = e.message;
    const meta = (m.meta ?? {}) as Record<string, unknown>;
    const rootId = m.threadRootId ?? m.id;
    // 래퍼 머지 줄 — 시스템 줄만 믿는다(사람·에이전트가 같은 꼴 meta 를 실어 단계를 끝내지 못하게).
    const merge = meta.merge as { repo?: unknown; number?: unknown; result?: unknown } | undefined;
    if (e.type === 'message.created' && m.kind === 'system' && merge?.result === 'merged'
      && typeof merge.repo === 'string' && typeof merge.number === 'number') {
      const repo = merge.repo; const number = merge.number;
      enqueue(rootId, () => autoUpdate(rootId, m.authorId, (doc) => applyMergedPr(doc, repo, number)));
      return;
    }
    // 카드 답 — 답이 실린 카드 글의 갱신.
    const ask = meta.ask as { answeredWith?: unknown } | undefined;
    if (e.type === 'message.updated' && meta.kind === 'ask' && ask?.answeredWith != null) {
      const cardId = m.id;
      if (!markAnswered(cardId.toLowerCase())) return;
      enqueue(rootId, () => autoUpdate(rootId, m.authorId, (doc) => applyAnsweredCard(doc, cardId)));
    }
  });

  return {
    stop() {
      off();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
    /** 미뤄 둔 일을 지금 돌리고 끝날 때까지 기다린다(테스트용). */
    async flush() {
      for (const [rootId, t] of [...pending]) {
        clearTimeout(t);
        pending.delete(rootId);
        const job = scheduled.get(rootId);
        if (job) { scheduled.delete(rootId); enqueue(rootId, job); }
      }
      while (inflight.size) await Promise.all([...inflight]);
      if (pending.size) await this.flush();
    },
  };
}

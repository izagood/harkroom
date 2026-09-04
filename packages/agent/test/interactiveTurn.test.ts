// #337 — 사람이 스스로 여는 인터랙티브 턴. 전부 스텁으로 검증한다(계획 Task 7):
// 3분기 · plan 에 권한 플래그 부재 · 고아 회수 타이머(schedule 주입) · lastFedSeq 클램프.
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentView, MessageRow } from '@murmur/shared';
import { createInteractiveManager, type InteractiveRelay, type InteractiveTurnDeps, type RunInteractiveTurn } from '../src/interactiveTurn.js';
import { MentionQueue } from '../src/mentionQueue.js';
import { SessionStore } from '../src/sessions.js';
import { TurnRegistry } from '../src/turnRegistry.js';
import type { PtyControls, TurnResult } from '../src/pty.js';
import type { TurnPlan } from '../src/turn.js';

const ME = { id: 'agent-1', handle: 'forge' };
const CHANNEL = 'c1';
const ROOT = 'root-1';
const KEY = SessionStore.threadKey(CHANNEL, ROOT);

function defOf(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: ME.id, handle: ME.handle, displayName: 'forge', kind: 'agent', isAdmin: false,
    instructions: '친절하게 답한다', harness: 'claude-code', model: null, effort: null,
    // workingDir null — 인터랙티브 열기는 avcs 없이도 성립해야 한다(resolveWorkspaceDir 의
    // mkdir 경로). avcs 경로 자체는 mentionTurn 테스트가 지킨다 — 같은 함수를 쓴다.
    workingDir: null, mentionPermission: 'auto', ownerAccountId: 'human-1', disabled: false,
    runnerVersion: null, stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
    status: 'available', statusText: null, avatarAttachmentId: null,
    ...overrides,
  };
}

function msg(seq: number): MessageRow {
  return {
    id: `m${seq}`, seq, channelId: CHANNEL, threadRootId: ROOT, authorId: 'human-1', body: `msg ${seq}`,
    kind: 'user', meta: {}, createdAt: new Date(2026, 8, 4, 0, 0, seq).toISOString(), editedAt: null,
    reactions: [], attachments: [], replyCount: null, lastReplyAt: null, participantIds: null, alsoInChannel: false,
  };
}

/** 예약을 배열로 들고 테스트가 직접 터뜨리는 가짜 타이머. 취소도 기록한다. */
function fakeSchedule() {
  const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      return () => { entry.cancelled = true; };
    },
    pending,
    /** 아직 살아 있는(취소 안 된) 예약들. */
    armed: () => pending.filter((p) => !p.cancelled),
    fire: (index: number) => { const p = pending[index]!; if (!p.cancelled) p.fn(); },
  };
}

interface Harness {
  deps: InteractiveTurnDeps;
  registry: TurnRegistry;
  queue: MentionQueue;
  store: SessionStore;
  plans: TurnPlan[];
  turnOpts: Parameters<RunInteractiveTurn>[1][];
  controls: { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
  /** 진행 중인 턴을 끝낸다(exit 흉내). */
  endTurn: (result?: TurnResult) => void;
  sched: ReturnType<typeof fakeSchedule>;
  relayLog: {
    closed: number;
    viewerCount: ((n: number) => void) | undefined;
    /** 세션마다 러너가 신고한 "입력을 받을 수 있는가"(#369). 인터랙티브 턴은 true 여야 한다. */
    acceptsInput: boolean[];
  };
  murmur: { definition: () => Promise<AgentView>; readThread: ReturnType<typeof vi.fn> };
}

async function makeHarness(overrides: Partial<InteractiveTurnDeps> = {}, def: AgentView = defOf()): Promise<Harness> {
  const stateDir = await mkdtemp(join(tmpdir(), 'interactive-state-'));
  const store = new SessionStore(join(await mkdtemp(join(tmpdir(), 'interactive-turn-')), 'sessions.json'));
  await store.load();
  const workspaceBaseDir = join(await mkdtemp(join(tmpdir(), 'interactive-ws-')), 'workspaces');
  await mkdir(workspaceBaseDir, { recursive: true });

  const registry = new TurnRegistry();
  const queue = new MentionQueue();
  const sched = fakeSchedule();

  const plans: TurnPlan[] = [];
  const turnOpts: Parameters<RunInteractiveTurn>[1][] = [];
  const controls = { write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
  let resolveTurn: ((r: TurnResult) => void) | null = null;
  const runTurn: RunInteractiveTurn = (plan, opts) => {
    plans.push(plan);
    turnOpts.push(opts);
    opts.onSpawn?.(controls as unknown as PtyControls);
    return new Promise<TurnResult>((resolve) => { resolveTurn = resolve; });
  };

  const relayLog: Harness['relayLog'] = { closed: 0, viewerCount: undefined, acceptsInput: [] };
  let sessionSeq = 0;
  const relay: InteractiveRelay = {
    openSession(input) {
      relayLog.viewerCount = input.onViewerCount;
      relayLog.acceptsInput.push(input.acceptsInput);
      sessionSeq += 1;
      return {
        sessionId: `relay-${sessionSeq}`,
        push: () => {},
        bindInput: () => {},
        close: () => { relayLog.closed += 1; },
      };
    },
  };

  const murmur = {
    definition: () => Promise.resolve(def),
    readThread: vi.fn(async () => [] as MessageRow[]),
  };

  const deps: InteractiveTurnDeps = {
    murmur, store, exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    runTurn, me: ME, workspaceBaseDir,
    mcpConfigPath: '/tmp/mcp.json', murmurUrl: 'http://localhost:3400', pat: 'murp_fake',
    codexHome: join(stateDir, 'codex-home'),
    relay, registry, queue,
    orphanMs: 60_000, killGraceMs: 5_000,
    schedule: sched.schedule,
    // 기본: 세션이 실재하게 됐다(사람이 대화했다). 반대 방향은 테스트가 덮는다.
    sessionMaterialized: async () => true,
    ...overrides,
  };

  return {
    deps, registry, queue, store, plans, turnOpts, controls, sched, relayLog, murmur,
    endTurn: (result = { exitCode: 0, timedOut: false, tail: '' }) => { resolveTurn?.(result); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * 종료 처리(finish)가 끝날 때까지 기다린다. 레지스트리 해제가 finish 의 **마지막** 정리
 * 단계라(주석: "해제가 마지막이다") 이것이 풀린 시점에는 store.put·queue.clear 도 끝나
 * 있다 — 고정 tick 으로 갈음하면 디스크 flush 속도에 따라 테스트가 흔들린다.
 */
const waitReleased = async (registry: TurnRegistry, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (registry.get(KEY) !== undefined) {
    if (Date.now() - start > ms) throw new Error('finish 가 끝나지 않았다');
    await flush();
  }
};

describe('#337 분기 ③ — 아무 턴도 없으면 새로 연다', () => {
  it('세션을 만들고(uuid 발급) 인터랙티브 plan 으로 spawn 하며, exit 을 기다리지 않고 돌아온다', async () => {
    const h = await makeHarness();
    const manager = createInteractiveManager(h.deps);

    const opened = await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin', cols: 100, rows: 30 });
    // endTurn 을 아직 안 불렀다 — open 이 여기 도달한 것 자체가 "exit 을 기다리지 않는다"다.
    expect(opened.created).toBe(true);
    expect(opened.sessionId).toBe('relay-1');

    // 첫 턴 조립: --session-id(비-p), 권한 플래그 없음(하네스 기본 — 사람이 답한다),
    // stdin 파일 없음(stdin 은 사람의 것).
    expect(h.plans).toHaveLength(1);
    expect(h.plans[0]!.args).toContain('--session-id');
    expect(h.plans[0]!.args).not.toContain('-p');
    expect(h.plans[0]!.args).not.toContain('--permission-mode');
    expect(h.plans[0]!.stdinFile).toBeNull();
    // #369: 그래서 이 PTY 는 사람의 입력을 **실제로 받는다** — 세션이 그 사실을 서버에
    // 신고해야 writer 차례가 열린다. 위 `stdinFile: null` 과 이 줄은 같은 사실의 양면이고,
    // 둘을 함께 두는 이유는 판정이 계획에서 나온다는 것을 회귀선에 박아 두기 위해서다.
    expect(h.relayLog.acceptsInput).toEqual([true]);
    // 무기한 + 요청한 크기로 spawn 된다.
    expect(h.turnOpts[0]).toMatchObject({ timeoutMs: 0, cols: 100, rows: 30 });

    // 레지스트리에 인터랙티브 턴이 등록됐다 — main 루프의 멘션 유예가 이것을 본다.
    expect(h.registry.get(KEY)).toMatchObject({ kind: 'interactive', openedByHandle: 'jaebin' });
  });

  it('디스크에 세션이 있으면 resume(-r)으로 조립한다 — 멘션 턴이 만든 대화를 이어받는다', async () => {
    const h = await makeHarness();
    await h.store.put(KEY, { workspaceDir: '/tmp/ws', sessionId: 'uuid-known', harness: 'claude-code', lastFedSeq: 3, turnsRun: 2 });
    const manager = createInteractiveManager(h.deps);

    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    expect(h.plans[0]!.args).toEqual(expect.arrayContaining(['-r', 'uuid-known']));
    expect(h.plans[0]!.args).not.toContain('--session-id');
  });

  it('codex 에이전트도 첫 인터랙티브 턴을 열고 격리 CODEX_HOME 을 사용한다', async () => {
    const h = await makeHarness({}, defOf({ harness: 'codex' }));
    const manager = createInteractiveManager(h.deps);

    const opened = await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    expect(opened).toEqual({ sessionId: 'relay-1', created: true });
    expect(h.plans).toHaveLength(1);
    expect(h.plans[0]!.args).not.toContain('resume');
    expect(h.plans[0]!.env.CODEX_HOME).toBe(h.deps.codexHome);
    expect(h.registry.get(KEY)).toMatchObject({ kind: 'interactive' });

    h.endTurn();
    await waitReleased(h.registry);
  });
});

describe('#337 분기 ①·② — 이미 도는 턴에는 합류한다', () => {
  it('멘션 턴이 진행 중이면 그 세션 id 를 created:false 로 돌려주고 spawn 하지 않는다', async () => {
    const h = await makeHarness();
    h.registry.register(KEY, { kind: 'mention', sessionId: 'sess-mention' });
    const manager = createInteractiveManager(h.deps);

    const opened = await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    expect(opened).toEqual({ sessionId: 'sess-mention', created: false });
    expect(h.plans).toHaveLength(0);
  });

  it('인터랙티브가 이미 열려 있으면 기존 세션을 돌려준다 — 창 두 개가 PTY 두 개가 되지 않는다', async () => {
    const h = await makeHarness();
    const manager = createInteractiveManager(h.deps);

    const first = await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    const second = await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    expect(second).toEqual({ sessionId: first.sessionId, created: false });
    expect(h.plans).toHaveLength(1);
  });

  it('릴레이 없는 멘션 턴이 돌고 있으면 명확히 거절한다 — 붙을 화면이 없다', async () => {
    const h = await makeHarness();
    h.registry.register(KEY, { kind: 'mention', sessionId: null });
    const manager = createInteractiveManager(h.deps);
    await expect(manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' }))
      .rejects.toThrow(/관찰 릴레이가 없다/);
  });
});

describe('#337 고아 회수 — viewer 0 → 유예 → SIGTERM → SIGKILL (§5-2 결정 5)', () => {
  it('spawn 직후(아무도 attach 전) 유예가 흐르고, 만료되면 SIGTERM, 유예 뒤 SIGKILL 로 승격한다', async () => {
    const h = await makeHarness();
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });

    // spawn 시점에 viewer 는 0 — 유예 타이머 하나가 걸려 있다.
    expect(h.sched.armed().map((p) => p.ms)).toEqual([60_000]);

    h.sched.fire(0);
    expect(h.controls.kill).toHaveBeenCalledWith('SIGTERM');
    // SIGTERM 을 무시하는 하네스를 위한 승격 타이머가 새로 걸린다.
    const killTimer = h.sched.pending.at(-1)!;
    expect(killTimer.ms).toBe(5_000);
    h.sched.fire(h.sched.pending.length - 1);
    expect(h.controls.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('viewer 가 붙으면(count>0) 유예가 취소되고, 다시 0 이 되면 새로 흐른다', async () => {
    const h = await makeHarness();
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });

    h.relayLog.viewerCount!(1);
    expect(h.sched.armed()).toEqual([]);

    h.relayLog.viewerCount!(0);
    expect(h.sched.armed().map((p) => p.ms)).toEqual([60_000]);
    // 진행 중 유예에 0 이 또 와도 타이머를 다시 세우지 않는다 — 세우면 유예가 늘어난다.
    h.relayLog.viewerCount!(0);
    expect(h.sched.armed()).toHaveLength(1);
  });

  it('exit 이 먼저 오면 타이머는 취소되고 kill 은 불리지 않는다', async () => {
    const h = await makeHarness();
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });

    h.endTurn();
    await waitReleased(h.registry);
    expect(h.sched.armed()).toEqual([]);
    expect(h.controls.kill).not.toHaveBeenCalled();
  });

  it('shutdown(러너 SIGTERM)이 진행 중 인터랙티브 PTY 를 같은 경로로 회수한다', async () => {
    const h = await makeHarness();
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });

    manager.shutdown();
    expect(h.controls.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('#337 턴의 끝 — 레지스트리 해제·클램프·turnsRun (§5-2 결정 7)', () => {
  it('exit 후 레지스트리가 해제되고 세션이 닫힌다', async () => {
    const h = await makeHarness();
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    expect(h.registry.get(KEY)).toBeDefined();

    h.endTurn();
    await waitReleased(h.registry);
    expect(h.registry.get(KEY)).toBeUndefined();
    expect(h.relayLog.closed).toBe(1);
  });

  it('대기 멘션이 없으면 lastFedSeq 가 스레드 끝까지 전진한다', async () => {
    const h = await makeHarness();
    h.murmur.readThread.mockResolvedValue([msg(4), msg(5), msg(6)]);
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });

    h.endTurn();
    await waitReleased(h.registry);
    expect(h.store.get(KEY)!.lastFedSeq).toBe(6);
  });

  it('대기 멘션이 있으면 min seq − 1 로 클램프한다 — 안 하면 그 부름의 델타가 비어 소실된다', async () => {
    const h = await makeHarness();
    h.murmur.readThread.mockResolvedValue([msg(4), msg(5), msg(6)]);
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    // 조종 중에 멘션 둘이 유예됐다(seq 5, 6). min 은 5 — 커서는 4 까지만 간다.
    h.queue.defer(KEY, 10, 5);
    h.queue.defer(KEY, 11, 6);

    h.endTurn();
    await waitReleased(h.registry);
    expect(h.store.get(KEY)!.lastFedSeq).toBe(4);
    // 장부는 비워진다 — 다음 조종의 통지가 1회부터 시작한다.
    expect(h.queue.minSeq(KEY)).toBeNull();
  });

  it('클램프가 커서를 되돌리지는 않는다 — 이미 먹인 것을 다시 먹이면 중복 발화다', async () => {
    const h = await makeHarness();
    await h.store.put(KEY, { workspaceDir: '/tmp/ws', sessionId: 'uuid-known', harness: 'claude-code', lastFedSeq: 9, turnsRun: 1 });
    h.murmur.readThread.mockResolvedValue([]);
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    // 유예 멘션의 seq(5)가 이미 먹인 구간(lastFedSeq 9)보다 뒤에 있다 — min−1(4)로
    // 되돌리면 그 구간을 다시 먹는다.
    h.queue.defer(KEY, 10, 5);

    h.endTurn();
    await waitReleased(h.registry);
    expect(h.store.get(KEY)!.lastFedSeq).toBe(9);
  });

  it('첫 턴에서 사람이 대화했으면(세션 파일 있음) turnsRun 이 1 — 다음 턴이 resume 으로 간다', async () => {
    const h = await makeHarness({ sessionMaterialized: async () => true });
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    h.endTurn();
    await waitReleased(h.registry);
    expect(h.store.get(KEY)!.turnsRun).toBe(1);
  });

  it('열었다 그냥 닫았으면(세션 파일 없음) turnsRun 0 유지 — --session-id 재시도가 성립한다', async () => {
    // 스파이크 실측: 첫 메시지 전에는 세션 파일이 없고, 그 uuid 의 resume 은 실패한다.
    // 여기서 turnsRun 을 올리면 다음 멘션 턴이 존재한 적 없는 세션을 -r 로 이어받으려다 죽는다.
    const h = await makeHarness({ sessionMaterialized: async () => false });
    const manager = createInteractiveManager(h.deps);
    await manager.open({ channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin' });
    h.endTurn();
    await waitReleased(h.registry);
    expect(h.store.get(KEY)!.turnsRun).toBe(0);
    // 발급했던 uuid 는 저장돼 있다 — 다음 시도가 같은 uuid 로 첫 턴을 다시 연다.
    expect(h.store.get(KEY)!.sessionId).not.toBeNull();
  });
});

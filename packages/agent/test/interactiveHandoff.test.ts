// #384 — 멘션 턴에서 인터랙티브 턴으로 이어받기.
//
// **프로덕션 배선을 그대로 지나간다**: 진짜 `TurnRegistry`·`MentionQueue`·`SessionStore` 와
// 진짜 `createInteractiveManager`·`buildTurnCommand`·`acceptsPtyInput` 을 쓰고, 스텁은 PTY
// (`runTurn`)와 릴레이 소켓뿐이다. 가짜 객체로 판정까지 흉내내면 판정을 지워도 초록이다.
//
// 이 파일이 지키는 것(운영자 결정 A: 진행 중인 멘션 턴을 **멈추지 않고 기다린다**):
//   ① 이어받기는 예약으로 답한다(waiting) — 그 턴이 도는 동안 PTY 를 하나도 더 띄우지 않는다.
//   ② 그 턴이 끝난 뒤 `resumeHandoff` 가 **같은 하네스 세션 id** 로 인터랙티브 턴을 띄운다.
//   ③ 그 턴은 `stdinFile: null` 이라 #369 의 판정(acceptsPtyInput)만으로 writer 가 열린다.
//   ④ 멘션 턴 자체는 그대로 관찰 전용이다 — 이어받기를 눌러도 그 세션은 바뀌지 않는다.
//   ⑥ 이어받기 구간의 멘션은 #337 과 **같은 큐 규칙**을 탄다(controlOf → 유예, 종료 시 클램프).
//   ⑦ 같은 세션 id 로 두 프로세스가 뜨지 않는다.
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentView, MessageRow } from '@murmur/shared';
import { createInteractiveManager, type InteractiveRelay, type InteractiveTurnDeps, type RunInteractiveTurn } from '../src/interactiveTurn.js';
import { MentionQueue } from '../src/mentionQueue.js';
import { SessionStore } from '../src/sessions.js';
import { TurnRegistry } from '../src/turnRegistry.js';
import { acceptsPtyInput, type PtyControls, type TurnResult } from '../src/pty.js';
import type { TurnPlan } from '../src/turn.js';

const ME = { id: 'agent-1', handle: 'forge' };
const CHANNEL = 'c1';
const ROOT = 'root-1';
const KEY = SessionStore.threadKey(CHANNEL, ROOT);
/** 멘션 턴이 이미 만들어 놓은 하네스 세션. 이어받기 턴은 **이것**을 resume 해야 한다. */
const HARNESS_SESSION = 'uuid-from-mention-turn';

function defOf(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: ME.id, handle: ME.handle, displayName: 'forge', kind: 'agent', isAdmin: false,
    instructions: '친절하게 답한다', harness: 'claude-code', model: null, effort: null,
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

interface Harness {
  deps: InteractiveTurnDeps;
  registry: TurnRegistry;
  queue: MentionQueue;
  store: SessionStore;
  plans: TurnPlan[];
  turnOpts: Parameters<RunInteractiveTurn>[1][];
  /** 러너가 릴레이에 신고한 "이 세션에 사람이 입력할 수 있는가"(#369). 세션 열린 순서대로. */
  acceptsInput: boolean[];
  endTurn: (result?: TurnResult) => void;
  murmur: { definition: () => Promise<AgentView>; readThread: ReturnType<typeof vi.fn> };
}

async function makeHarness(def: AgentView = defOf()): Promise<Harness> {
  const stateDir = await mkdtemp(join(tmpdir(), 'handoff-state-'));
  const store = new SessionStore(join(await mkdtemp(join(tmpdir(), 'handoff-turn-')), 'sessions.json'));
  await store.load();
  const workspaceBaseDir = join(await mkdtemp(join(tmpdir(), 'handoff-ws-')), 'workspaces');
  await mkdir(workspaceBaseDir, { recursive: true });

  const registry = new TurnRegistry();
  const queue = new MentionQueue();
  const plans: TurnPlan[] = [];
  const turnOpts: Parameters<RunInteractiveTurn>[1][] = [];
  const acceptsInput: boolean[] = [];
  const controls = { write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
  let resolveTurn: ((r: TurnResult) => void) | null = null;

  const runTurn: RunInteractiveTurn = (plan, opts) => {
    plans.push(plan);
    turnOpts.push(opts);
    opts.onSpawn?.(controls as unknown as PtyControls);
    return new Promise<TurnResult>((resolve) => { resolveTurn = resolve; });
  };

  let sessionSeq = 0;
  const relay: InteractiveRelay = {
    openSession(input) {
      acceptsInput.push(input.acceptsInput);
      sessionSeq += 1;
      return {
        sessionId: `relay-${sessionSeq}`,
        push: () => {}, bindInput: () => {}, close: () => {},
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
    // 예약·기동만 재는 파일이다 — 유예 타이머를 실제로 걸지 않는다(고아 회수는 #337 이 지킨다).
    schedule: () => () => {},
    sessionMaterialized: async () => true,
  };

  return {
    deps, registry, queue, store, plans, turnOpts, acceptsInput, murmur,
    endTurn: (result = { exitCode: 0, timedOut: false, tail: '' }) => { resolveTurn?.(result); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * 멘션 턴이 도는 상태를 만든다 — 러너 관점의 사실 둘이 전부다: 레지스트리에 등록된
 * 멘션 턴 하나(관찰 세션 id 를 가진다)와, 디스크에 있는 그 스레드의 하네스 세션.
 */
async function startMentionTurn(h: Harness): Promise<void> {
  await h.store.put(KEY, {
    workspaceDir: '/tmp/ws', sessionId: HARNESS_SESSION, harness: 'claude-code', lastFedSeq: 3, turnsRun: 1,
  });
  h.registry.register(KEY, { kind: 'mention', sessionId: 'sess-mention' });
}

/** 멘션 턴이 끝났다 — 레지스트리 해제(턴의 finally)와 상태 저장이 끝난 상태. */
function endMentionTurn(h: Harness): void {
  h.registry.release(KEY);
}

const HANDOFF = { channelId: CHANNEL, threadRootId: ROOT, openedByHandle: 'jaebin', handoff: true } as const;

describe('#384 ① 이어받기는 예약으로 답한다 — 진행 중인 턴을 멈추지 않는다', () => {
  it('멘션 턴이 도는 동안 waiting 을 돌려주고 PTY 를 하나도 더 띄우지 않는다', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);

    const opened = await manager.open({ ...HANDOFF, cols: 100, rows: 30 });

    // 사람은 지금 도는 멘션 턴의 화면을 계속 본다 — 새 세션이 아니다.
    expect(opened).toEqual({ sessionId: 'sess-mention', created: false, waiting: true });
    // **아무것도 뜨지 않았다.** 여기서 PTY 가 떴다면 같은 하네스 세션을 두 프로세스가 밟는다.
    expect(h.plans).toEqual([]);
    expect(h.acceptsInput).toEqual([]);
    // 예약이 남았다 — 누른 사람과 창 크기까지(대기 뒤에 뜨는 PTY 는 그 사람의 창이어야 한다).
    expect(h.registry.handoff(KEY)).toEqual({
      openedByHandle: 'jaebin', channelId: CHANNEL, threadRootId: ROOT, cols: 100, rows: 30,
    });
    // 진행 중인 멘션 턴의 등록은 그대로다 — 이어받기가 그 턴을 건드리지 않았다.
    expect(h.registry.get(KEY)).toEqual({ kind: 'mention', sessionId: 'sess-mention' });
  });

  it('handoff:false 는 지금까지의 답 그대로다 — 관찰로 합류하고 예약하지 않는다(#369 의 자리)', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);

    const opened = await manager.open({ ...HANDOFF, handoff: false });

    expect(opened).toEqual({ sessionId: 'sess-mention', created: false, waiting: false });
    expect(h.registry.handoff(KEY)).toBeUndefined();
    expect(h.plans).toEqual([]);
  });

  it('누르는 사이에 멘션 턴이 끝났으면 기다리지 않고 지금 연다', async () => {
    const h = await makeHarness();
    // 진행 중인 턴이 없다(끝난 뒤에 눌렀다) — 세션 레코드만 남아 있다.
    await h.store.put(KEY, {
      workspaceDir: '/tmp/ws', sessionId: HARNESS_SESSION, harness: 'claude-code', lastFedSeq: 3, turnsRun: 1,
    });
    const manager = createInteractiveManager(h.deps);

    const opened = await manager.open(HANDOFF);

    expect(opened).toEqual({ sessionId: 'relay-1', created: true, waiting: false });
    expect(h.registry.handoff(KEY)).toBeUndefined();
    expect(h.plans).toHaveLength(1);
  });
});

describe('#384 ② 멘션 턴이 끝나면 같은 하네스 세션 id 로 인터랙티브 턴이 뜬다', () => {
  it('resumeHandoff 가 예약을 풀어 -r <세션 id> 로 조립한다', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);
    await manager.open({ ...HANDOFF, cols: 100, rows: 30 });

    endMentionTurn(h);
    await manager.resumeHandoff(KEY);

    expect(h.plans).toHaveLength(1);
    // **같은 하네스 세션 id 다** — 멘션 턴이 하던 그 대화를 사람이 이어서 친다.
    expect(h.plans[0]!.args).toEqual(expect.arrayContaining(['-r', HARNESS_SESSION]));
    // 새로 시작하는 조립(`--session-id`)이면 하네스가 "Session ID already in use" 로 죽는다.
    expect(h.plans[0]!.args).not.toContain('--session-id');
    // 인터랙티브 턴이다: 프롬프트도 권한 프리셋도 없고(사람이 답한다), 시계도 없다.
    expect(h.plans[0]!.args).not.toContain('-p');
    expect(h.plans[0]!.args).not.toContain('--permission-mode');
    expect(h.turnOpts[0]).toMatchObject({ timeoutMs: 0, cols: 100, rows: 30 });
    // 레지스트리는 이제 인터랙티브 턴이고, 예약은 그 턴으로 이행돼 사라졌다.
    expect(h.registry.get(KEY)).toMatchObject({ kind: 'interactive', sessionId: 'relay-1', openedByHandle: 'jaebin' });
    expect(h.registry.handoff(KEY)).toBeUndefined();
  });

  it('예약이 없는 스레드에서는 아무 일도 없다 — 모든 멘션 턴 뒤에 불리는 함수다', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);

    endMentionTurn(h);
    await manager.resumeHandoff(KEY);

    expect(h.plans).toEqual([]);
    expect(h.registry.get(KEY)).toBeUndefined();
  });

  it('러너가 물러나는 중이면 예약을 버린다 — 회수한 PTY 를 다시 띄우지 않는다', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);
    await manager.open(HANDOFF);

    manager.shutdown();
    endMentionTurn(h);
    await manager.resumeHandoff(KEY);

    expect(h.plans).toEqual([]);
    // 예약도 남기지 않는다 — 남으면 그 스레드의 멘션이 영원히 유예된다.
    expect(h.registry.handoff(KEY)).toBeUndefined();
    expect(h.registry.controlOf(KEY)).toBeNull();
  });
});

describe('#384 ③④ writer 는 #369 의 판정만으로 열린다 — 멘션 턴은 그대로 관찰 전용이다', () => {
  it('이어받기 턴은 stdinFile 이 없고, 러너가 그 사실을 acceptsInput:true 로 신고한다', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);
    await manager.open(HANDOFF);

    endMentionTurn(h);
    await manager.resumeHandoff(KEY);

    const plan = h.plans[0]!;
    // #369 의 판정 그대로다 — 새 판정을 만들지 않았다: 근거는 자식의 fd 0 하나다.
    expect(plan.stdinFile).toBeNull();
    expect(acceptsPtyInput(plan)).toBe(true);
    // 그 사실이 릴레이로 나간다. 서버의 writer 판정(inputDenial)이 읽는 값이 이것뿐이다 —
    // 여기서 false 가 나가면 사람은 이어받고도 못 친다.
    expect(h.acceptsInput).toEqual([true]);
  });

  it('이어받기를 눌러도 진행 중인 멘션 턴의 세션은 열리지 않는다 — 세션을 새로 열지 않는다', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);

    await manager.open(HANDOFF);

    // 멘션 턴의 세션은 mentionTurn 이 이미 `acceptsInput: false` 로 열어 둔 것이고, 이
    // 경로는 세션을 열지도 고치지도 않는다 — 멘션 턴은 여전히 관찰 전용이다(#369).
    expect(h.acceptsInput).toEqual([]);
  });
});

describe('#384 ⑥ 이어받기 구간은 #337 과 같은 큐 규칙을 탄다', () => {
  it('예약만 있어도 그 스레드는 조종 중이다 — 멘션 유예 판정(controlOf)이 그것을 본다', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);

    // 이어받기 전: 멘션 턴만 도는 스레드는 유예 대상이 아니다(그 턴은 어차피 돌고 있다).
    expect(h.registry.controlOf(KEY)).toBeNull();

    await manager.open(HANDOFF);
    // 예약 구간 — 사람이 기다리는 26초다. 여기서 유예가 빠지면 그 사이에 시작된 멘션
    // 턴이 사람이 기다린 자리를 가져간다.
    expect(h.registry.controlOf(KEY)).toEqual({ openedByHandle: 'jaebin' });

    endMentionTurn(h);
    await manager.resumeHandoff(KEY);
    // 인터랙티브 턴이 뜬 뒤에도 그대로 조종 중이다(#337 의 판정으로 이어진다).
    expect(h.registry.controlOf(KEY)).toEqual({ openedByHandle: 'jaebin' });
  });

  it('이어받기 턴이 끝나면 대기 멘션의 min seq - 1 로 lastFedSeq 를 클램프한다(#337 결정 7)', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);
    await manager.open(HANDOFF);
    endMentionTurn(h);
    await manager.resumeHandoff(KEY);

    // 이어받는 동안 온 멘션 — main 루프가 유예하며 이 장부에 적는다.
    h.queue.defer(KEY, 77, 9);
    // 그 사이 스레드에는 12까지 쌓였다.
    h.murmur.readThread.mockResolvedValue([msg(7), msg(9), msg(12)]);

    h.endTurn();
    // finish 의 마지막이 레지스트리 해제다 — 풀렸으면 저장도 끝났다.
    for (let i = 0; i < 200 && h.registry.get(KEY) !== undefined; i += 1) await flush();

    // 클램프 없이 12 로 전진하면 유예됐다 풀려나는 멘션(seq 9)의 델타가 비어 그 부름이
    // 조용히 소실된다 — 새 큐를 만들지 않았다는 것이 이 값 하나로 드러난다.
    expect(h.store.get(KEY)?.lastFedSeq).toBe(8);
  });
});

describe('#384 ⑤ codex 는 이어받기가 거절되고 이유가 사람에게 간다', () => {
  it('누른 순간 거절한다 — 예약도 남기지 않는다(26초를 기다린 뒤 거절하면 그 기다림이 헛것이다)', async () => {
    const h = await makeHarness(defOf({ harness: 'codex' }));
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);

    // 던진 문구가 relay 의 interactive.error → 서버 → 화면으로 **그대로** 간다.
    await expect(manager.open(HANDOFF)).rejects.toThrow(/codex .*이어받기가 열려 있지 않다/);
    // 이유가 실려 있다 — "안 된다"만 적으면 임의의 제약으로 읽혀 결함으로 다시 올라온다.
    await expect(manager.open(HANDOFF)).rejects.toThrow(/codex resume 이 이어받는지가 실측되지 않았다/);
    // 다음 행동도 적혀 있다 — 새 턴은 열 수 있다(#337 은 그대로다).
    await expect(manager.open(HANDOFF)).rejects.toThrow(/터미널 열기/);

    expect(h.registry.handoff(KEY)).toBeUndefined();
    expect(h.registry.controlOf(KEY)).toBeNull();
    expect(h.plans).toEqual([]);
  });

  it('기다리는 사이에 하네스가 codex 로 바뀌면 예약을 풀 때도 거절한다', async () => {
    let def = defOf();
    const h = await makeHarness();
    h.deps.murmur.definition = () => Promise.resolve(def);
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);
    await manager.open(HANDOFF);
    expect(h.registry.handoff(KEY)).toBeDefined();

    // 사람이 UI 에서 하네스를 바꿨다 — 조용히 열면 "이어받았다"고 믿는 화면에서 다른
    // 대화가 시작된다.
    def = defOf({ harness: 'codex' });
    endMentionTurn(h);
    await manager.resumeHandoff(KEY);

    expect(h.plans).toEqual([]);
    // 예약을 남기지 않는다 — 남으면 그 스레드의 멘션이 영원히 유예된다.
    expect(h.registry.handoff(KEY)).toBeUndefined();
    expect(h.registry.controlOf(KEY)).toBeNull();
  });

  it('codex 의 [터미널 열기](handoff:false)는 그대로 열린다 — 닫은 것은 이어받기뿐이다', async () => {
    const h = await makeHarness(defOf({ harness: 'codex' }));
    const manager = createInteractiveManager(h.deps);

    const opened = await manager.open({ ...HANDOFF, handoff: false });

    expect(opened).toEqual({ sessionId: 'relay-1', created: true, waiting: false });
    expect(h.plans).toHaveLength(1);
  });
});

describe('#384 ⑦ 같은 세션 id 로 두 프로세스가 뜨지 않는다', () => {
  it('두 사람이 눌러도 예약은 하나이고 턴도 하나 뜬다', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);

    const first = await manager.open(HANDOFF);
    const second = await manager.open({ ...HANDOFF, openedByHandle: 'someone-else' });
    expect(first).toEqual(second);
    // 먼저 누른 사람이 남는다 — 예약은 턴 하나이고 그 턴은 하나뿐이다.
    expect(h.registry.handoff(KEY)?.openedByHandle).toBe('jaebin');

    endMentionTurn(h);
    await manager.resumeHandoff(KEY);
    await manager.resumeHandoff(KEY);

    expect(h.plans).toHaveLength(1);
  });

  it('이미 인터랙티브 턴이 도는 스레드에서는 예약을 버리고 아무것도 띄우지 않는다', async () => {
    const h = await makeHarness();
    await startMentionTurn(h);
    const manager = createInteractiveManager(h.deps);
    await manager.open(HANDOFF);

    // 멘션 턴이 끝나고 사람이 다시 눌러 인터랙티브 턴이 먼저 떴다(경합).
    endMentionTurn(h);
    await manager.open({ ...HANDOFF, handoff: false });
    expect(h.plans).toHaveLength(1);

    // 그 뒤에 예약이 풀리더라도 두 번째 PTY 는 뜨지 않는다.
    await manager.resumeHandoff(KEY);
    expect(h.plans).toHaveLength(1);
    expect(h.registry.handoff(KEY)).toBeUndefined();
  });

  it('관찰 릴레이가 없는 멘션 턴은 이어받을 수 없다 — 사실을 말하고 거절한다', async () => {
    const h = await makeHarness();
    await h.store.put(KEY, {
      workspaceDir: '/tmp/ws', sessionId: HARNESS_SESSION, harness: 'claude-code', lastFedSeq: 3, turnsRun: 1,
    });
    // 릴레이 없이 도는 멘션 턴 — 기다리는 동안 볼 화면이 없고, 예약해도 사람은 아무것도 못 본다.
    h.registry.register(KEY, { kind: 'mention', sessionId: null });
    const manager = createInteractiveManager(h.deps);

    await expect(manager.open(HANDOFF)).rejects.toThrow('관찰 릴레이가 없다');
    expect(h.registry.handoff(KEY)).toBeUndefined();
    expect(h.plans).toEqual([]);
  });
});

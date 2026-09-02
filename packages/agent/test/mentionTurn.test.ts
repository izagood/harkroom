// 통합 테스트 — 인메모리 murmur 클라이언트 + 가짜 하네스(runTurn 주입)로 main.ts 의 폴
// 루프에서 분리된 조립 함수(runMentionTurn)를 프로세스 경계·네트워크 없이 검증한다.
//
// "에이전트가 스스로 발화한다"는 실제로는 하네스 프로세스 안에서 murmur MCP 를 불러
// 일어나는 일이라 이 테스트(프로세스 경계 밖)에서 직접 재현할 수 없다 — 그래서 runTurn
// 스텁이 하네스 대신 fakeMurmur.post 를 호출해 "턴 도중 에이전트가 답을 올렸다"를
// 흉내낸다(task-9 브리프 시나리오 1 주석 그대로).
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentView, MessageRow } from '@murmur/shared';
import { runMentionTurn, type MentionTurnDeps, type MentionTurnMurmur, type RunTurn } from '../src/mentionTurn.js';
import { NO_REPLY_NOTICE } from '../src/prompt.js';
import { SessionStore } from '../src/sessions.js';
import type { Exec } from '../src/workspace.js';
import type { TurnPlan } from '../src/turn.js';
import type { TurnResult } from '../src/pty.js';

const ME = { id: 'agent-1', handle: 'forge' };
const CHANNEL = 'c1';

function msg(seq: number, authorId: string, body: string, threadRootId: string | null = null): MessageRow {
  return {
    id: `m${seq}`, seq, channelId: CHANNEL, threadRootId, authorId, body, kind: 'user', meta: {},
    createdAt: new Date(2026, 8, 1, 0, 0, seq).toISOString(), editedAt: null, reactions: [], attachments: [],
  };
}

// workingDir 은 기본으로 명시된 값('/repo')을 쓴다 — null(아무도 지정하지 않음)과
// "avcs repo 를 지정했다"는 서로 다른 코드 경로를 타므로(mentionTurn.ts::resolveWorkspaceDir,
// fix round 2), 그 구분 자체를 테스트하는 시나리오만 명시적으로 `workingDir: null` 을 준다.
function defOf(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: ME.id, handle: ME.handle, displayName: 'forge', kind: 'agent', isAdmin: false,
    instructions: '친절하게 답한다', harness: 'claude-code', model: null, effort: null,
    workingDir: '/repo', mentionPermission: 'auto', ownerAccountId: 'human-1',
    ...overrides,
  };
}

/** MentionTurnMurmur 표면의 인메모리 fake. 스레드 하나(channelId 고정)만 다룬다. */
class FakeMurmur implements MentionTurnMurmur {
  messages: MessageRow[] = [];
  posts: { channelId: string; body: string; threadRootId: string | null }[] = [];
  private seq = 0;
  def: AgentView;

  constructor(def: AgentView) {
    this.def = def;
  }

  definition(): Promise<AgentView> {
    return Promise.resolve(this.def);
  }

  readThread(channelId: string, threadRootId: string | null): Promise<MessageRow[]> {
    return Promise.resolve(this.messages.filter((m) => m.channelId === channelId && m.threadRootId === threadRootId));
  }

  post(channelId: string, body: string, threadRootId: string | null): Promise<void> {
    this.posts.push({ channelId, body, threadRootId });
    this.seedFrom(ME.id, body, threadRootId);
    return Promise.resolve();
  }

  /** 사람/동료 에이전트의 메시지를 스레드에 심는다. seq 는 이 fake 가 채번한다. */
  seedFrom(authorId: string, body: string, threadRootId: string | null = null): MessageRow {
    this.seq += 1;
    const m = msg(this.seq, authorId, body, threadRootId);
    this.messages.push(m);
    return m;
  }
}

async function makeDeps(fake: FakeMurmur, overrides: Partial<MentionTurnDeps> = {}): Promise<{
  deps: MentionTurnDeps;
  execCalls: string[][];
  plans: TurnPlan[];
  runTurn: RunTurn & { script: RunTurn };
}> {
  const store = new SessionStore(join(await mkdtemp(join(tmpdir(), 'mention-turn-')), 'sessions.json'));
  await store.load();
  // workingDir===null 경로(resolveWorkspaceDir)는 avcs 를 거치지 않고 실제 mkdir 을 한다
  // (fix round 2) — exec 가 완전히 fake 인 avcs 경로와 달리 진짜 쓰기 가능한 디렉터리가
  // 있어야 한다.
  const workspaceBaseDir = await mkdtemp(join(tmpdir(), 'mention-turn-ws-'));

  const execCalls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    execCalls.push([cmd, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };

  const plans: TurnPlan[] = [];
  // 기본 스크립트: 아무 것도 안 하고 exitCode 0 으로 끝난다(발화 없음) — 시나리오마다
  // runTurn.script 를 갈아 끼워 다른 행동(에이전트가 답을 올림 등)을 흉내낸다.
  const runTurn = Object.assign(
    (plan: TurnPlan, opts: { cwd: string; timeoutMs: number }) => {
      plans.push(plan);
      return runTurn.script(plan, opts);
    },
    { script: (_plan: TurnPlan, _opts: { cwd: string; timeoutMs: number }) => Promise.resolve<TurnResult>({ exitCode: 0, timedOut: false, tail: '' }) },
  );

  const deps: MentionTurnDeps = {
    murmur: fake,
    store,
    exec,
    runTurn,
    me: ME,
    guide: '워크스페이스 규칙',
    channelName: 'general',
    handles: { [ME.id]: ME.handle },
    workspaceBaseDir,
    mcpConfigPath: '/fake/mcp.json',
    murmurUrl: 'http://localhost:3400',
    pat: 'murp_test',
    turnTimeoutMs: 10_000,
    ...overrides,
  };

  return { deps, execCalls, plans, runTurn };
}

describe('runMentionTurn', () => {
  // 시나리오 1
  it('첫 멘션: ensureWorkspace 1회 + 세션 생성 + 에이전트가 스스로 답을 올리면 NO_REPLY 없음', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps, execCalls, plans, runTurn } = await makeDeps(fake);
    runTurn.script = async () => {
      // 하네스가 아니라 이 테스트가 "에이전트가 message.post 를 불렀다"를 흉내낸다
      // (프로세스 경계 밖이라 실제로 fakeMurmur.post 를 부를 수 없다).
      await fake.post(CHANNEL, '안녕하세요!', null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]![0]).toBe('avcs');
    const key = SessionStore.threadKey(CHANNEL, null);
    const rec = deps.store.get(key);
    expect(rec).toBeDefined();
    expect(rec!.sessionId).not.toBeNull(); // claude 는 러너가 미리 uuid 를 발급한다
    expect(rec!.turnsRun).toBe(1);
    expect(plans[0]!.args).toContain('--session-id');
    expect(plans[0]!.args).toContain(rec!.sessionId);
    // 시스템 프롬프트에 channelId·threadRootId 를 알려줘야 에이전트가 message.post 대상을 안다.
    expect(plans[0]!.args.join(' ')).toContain(`channelId: ${CHANNEL}`);
    expect(fake.posts).toHaveLength(1); // 에이전트의 답 하나뿐 — NO_REPLY 가 추가되지 않았다
  });

  // 시나리오 2 (+ 안전 거부 케이스 커버 — task-9 브리프 "다섯 가지" 항목 5): 하네스가
  // exit 0 으로 끝났는데 스스로 발화하지 않았다. 원인이 "쓸 말이 없었다"든 "안전 거부"든
  // 러너 입장에서는 구별할 방법이 없다(더 이상 출력을 파싱하지 않으므로) — 그래서 두
  // 경우 다 같은 NO_REPLY_NOTICE 경로로 들어와야 한다. 이 경로가 없으면 사람 눈에는
  // 에이전트가 조용히 죽은 것과 똑같아 보인다(옛 reply.ts::extractReply 가 막던 바로 그것).
  it('발화 없는 턴(쓸 말 없음 또는 안전 거부, 둘 다 exit 0): NO_REPLY_NOTICE 가 남는다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 뭐라도 답해줘');
    const { deps } = await makeDeps(fake); // 기본 스크립트: exit 0, 발화 없음

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]!.body).toBe(NO_REPLY_NOTICE);
  });

  describe('같은 threadKey 두 번째 멘션', () => {
    it('ensureWorkspace 재호출 없음 + isFirstTurn=false 로 -r 조립', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '첫 질문');
      const { deps, execCalls, plans, runTurn } = await makeDeps(fake);
      runTurn.script = async () => {
        await fake.post(CHANNEL, '첫 답', null);
        return { exitCode: 0, timedOut: false, tail: '' };
      };

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });
      const firstSessionId = deps.store.get(SessionStore.threadKey(CHANNEL, null))!.sessionId;

      fake.seedFrom('human-1', '두 번째 질문');
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

      expect(execCalls).toHaveLength(1); // 두 번째 턴에서 avcs 를 다시 부르지 않았다
      expect(plans).toHaveLength(2);
      expect(plans[1]!.args).toContain('-r');
      expect(plans[1]!.args).toContain(firstSessionId);
      expect(plans[1]!.args).not.toContain('--session-id');

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
      expect(rec!.turnsRun).toBe(2);
    });

    // 시나리오 4
    it('lastFedSeq 전진: 두 번째 턴의 promptCtx 에 첫 턴 메시지가 없다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '첫번째메시지고유문구');
      const { deps, plans, runTurn } = await makeDeps(fake);
      runTurn.script = async () => {
        await fake.post(CHANNEL, '첫번째답변고유문구', null);
        return { exitCode: 0, timedOut: false, tail: '' };
      };

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });
      fake.seedFrom('human-1', '두번째메시지고유문구');
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

      const secondTurnArgs = plans[1]!.args.join(' ');
      expect(secondTurnArgs).toContain('두번째메시지고유문구');
      expect(secondTurnArgs).not.toContain('첫번째메시지고유문구');
      expect(secondTurnArgs).not.toContain('첫번째답변고유문구'); // 세션이 이미 아는 자기 발화도 다시 넘기지 않는다
    });
  });

  // task-9 브리프 수정 항목 — harness 변경은 세션을 무효화한다.
  it('harness 를 바꾸면 다음 턴이 isFirstTurn: true 로 조립되고 옛 sessionId 가 남지 않는다', async () => {
    const fake = new FakeMurmur(defOf({ harness: 'claude-code' }));
    fake.seedFrom('human-1', '첫 질문');
    const { deps, execCalls, plans, runTurn } = await makeDeps(fake);
    runTurn.script = async () => {
      await fake.post(CHANNEL, '첫 답', null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });
    const claudeSessionId = deps.store.get(SessionStore.threadKey(CHANNEL, null))!.sessionId;
    const workspaceDirAfterFirst = deps.store.get(SessionStore.threadKey(CHANNEL, null))!.workspaceDir;

    fake.def = defOf({ harness: 'codex' }); // UI 에서 harness 를 codex 로 바꿨다
    fake.seedFrom('human-1', '두 번째 질문');
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

    // 워크스페이스는 재사용한다 — 그 안의 작업 산출물은 harness 와 무관하다. 그래서
    // ensureWorkspace(avcs 호출)가 다시 일어나지 않는다.
    expect(execCalls).toHaveLength(1);
    const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
    expect(rec!.workspaceDir).toBe(workspaceDirAfterFirst);
    expect(rec!.harness).toBe('codex');
    expect(rec!.turnsRun).toBe(1); // 세션은 리셋됐지만, 이번 턴 자체는 돌았다

    const secondPlanArgs = plans[1]!.args;
    expect(secondPlanArgs[0]).toBe('exec'); // codex 첫 턴 — resume 이 아니다
    expect(secondPlanArgs).not.toContain('resume');
    expect(secondPlanArgs.join(' ')).not.toContain(String(claudeSessionId));
  });

  // #81 테스트: 실패한 턴에서 lastFedSeq 와 turnsRun 은 전진하지 않는다.
  // 재시도 시점이 델타가 비어있어도 하네스가 다시 떠야 하기 때문이다.
  describe('실패한 턴의 상태 저장 (#81 수정)', () => {
    it('실패 시 lastFedSeq 와 turnsRun 은 전진하지 않는다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => ({ exitCode: 1, timedOut: false, tail: 'some error' });

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null }))
        .rejects.toThrow();

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null))!;
      expect(rec.lastFedSeq).toBe(0); // 전진하지 않음
      expect(rec.turnsRun).toBe(0); // 전진하지 않음
      expect(rec.workspaceDir).toBeDefined(); // workspaceDir 은 저장됨
      expect(rec.sessionId).not.toBeNull(); // sessionId 는 저장됨
    });

    it('타임아웃 시 lastFedSeq 와 turnsRun 도 전진하지 않는다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => ({ exitCode: 0, timedOut: true, tail: 'timeout' });

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null }))
        .rejects.toThrow();

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null))!;
      expect(rec.lastFedSeq).toBe(0);
      expect(rec.turnsRun).toBe(0);
    });

    // 실패했어도 발화가 이미 있었다면 커서는 전진해야 한다 — 대표적으로 타임아웃이다
    // (답을 올린 뒤 계속 일하다 SIGTERM 을 맞는다). 전진시키지 않으면 재시도가 같은
    // 메시지를 다시 먹여 같은 질문에 두 번 답한다.
    it('실패했어도 이미 발화했다면 lastFedSeq 는 전진한다 (중복 발화 방지)', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => {
        // 답은 올렸는데 그 뒤에 시간이 다 됐다.
        await fake.post(CHANNEL, '답변은 올렸다', null);
        return { exitCode: 0, timedOut: true, tail: 'timeout' };
      };

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null }))
        .rejects.toThrow();

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null))!;
      expect(rec.lastFedSeq).toBeGreaterThan(0); // 발화가 있었으니 전진한다
      expect(rec.turnsRun).toBe(0); // turnsRun 은 여전히 올리지 않는다
    });

    // 발화 확인 자체가 실패하면(murmur 네트워크 끊김) 전진시키지 않는다 —
    // "한 번 더 시도한다"가 "중복 발화"보다 회복 가능한 쪽이다.
    it('실패 턴의 발화 확인이 던지면 lastFedSeq 를 전진시키지 않는다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => ({ exitCode: 1, timedOut: false, tail: 'boom' });
      const original = deps.murmur.readThread.bind(deps.murmur);
      let calls = 0;
      deps.murmur.readThread = async (...args: Parameters<typeof original>) => {
        calls += 1;
        if (calls > 1) throw new Error('murmur 연결 끊김');
        return original(...args);
      };

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null }))
        .rejects.toThrow(/harness 종료/);

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null))!;
      expect(rec.lastFedSeq).toBe(0);
    });

    it('실패 후 재시도에서 델타가 비어있어도 하네스가 다시 실행된다 (#81 핵심 재현)', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '첫 번째 질문');
      const { deps, plans, runTurn } = await makeDeps(fake);
      let callCount = 0;
      runTurn.script = async () => {
        callCount += 1;
        if (callCount === 1) {
          return { exitCode: 1, timedOut: false, tail: 'error' };
        }
        // 두 번째 실행(재시도)부터는 성공 — 에이전트가 실제로 답변을 올림
        await fake.post(CHANNEL, '재시도 답변', null);
        return { exitCode: 0, timedOut: false, tail: '' };
      };

      // 첫 턴: 실패
      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null }))
        .rejects.toThrow();
      expect(plans).toHaveLength(1); // 첫 턴에서 하네스 실행됨

      // 재시도: 이전 턴이 실패했으면 turnsRun 이 0 이므로,
      // 델타가 비어있어도 하네스를 실행해야 함 (이게 #81 의 핵심 수정)
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });
      expect(plans).toHaveLength(2); // 재시도에서도 하네스가 실행됨
    });
  });

  // task-9 브리프 수정 항목 — 프롬프트가 빈 턴을 건너뛴 뒤에도 다음 턴은 정확히 재개된다.
  // (분석: 이 구현에서 "건너뛴 턴"은 오직 이미 최소 한 번 실제 턴이 돈 뒤에만 일어날 수
  // 있다 — buildTurnPrompt 는 진짜 첫 턴에는 자기 발화 필터를 안 걸어 toShow 가 절대
  // 비지 않는다. 그래서 이 케이스가 "isFirstTurn 을 잘못 true 로 되돌리는" 사고는 안
  // 나지만, turnsRun 이 건너뛴 턴을 거치고도 세션 진행 상태를 정확히 지키는지는 별개로
  // 고정해 둘 가치가 있다.)
  it('건너뛴 턴(전부 자기 발화) 이후에도 세션은 그대로 이어진다 — turnsRun 유지, 같은 sessionId 로 resume', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '첫 질문');
    const { deps, plans, runTurn } = await makeDeps(fake);
    runTurn.script = async () => {
      await fake.post(CHANNEL, '첫 답', null); // 자기 발화 — 다음 턴 프롬프트에서는 걸러진다
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });
    const key = SessionStore.threadKey(CHANNEL, null);
    const afterFirst = deps.store.get(key)!;
    expect(afterFirst.turnsRun).toBe(1);

    // 다음 폴에서 새 메시지가 자기 발화(예: 다른 프로세스가 같은 계정으로 후속 메모를
    // 남김)뿐이면 프롬프트가 비어 턴을 건너뛴다 — runTurn 이 아예 불리지 않아야 한다.
    fake.seedFrom(ME.id, '자기 후속 메모');
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });
    expect(plans).toHaveLength(1); // 두 번째 호출은 runTurn 을 안 불렀다

    const afterSkip = deps.store.get(key)!;
    expect(afterSkip.turnsRun).toBe(1); // 하네스가 안 돌았으니 그대로다
    expect(afterSkip.lastFedSeq).toBeGreaterThan(afterFirst.lastFedSeq); // 그래도 fedSeq 는 전진

    // 세 번째: 사람이 진짜로 말을 걸면 resume 이 정상적으로(같은 sessionId, isFirstTurn=false) 조립된다.
    fake.seedFrom('human-1', '진짜 두 번째 질문');
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });
    expect(plans).toHaveLength(2);
    expect(plans[1]!.args).toContain('-r');
    expect(plans[1]!.args).toContain(afterFirst.sessionId);
  });

  // task-9 브리프 수정 항목 — handles 맵이 배치 단위로 채워져야 동료 발화가 handle 로 렌더된다.
  it('handles 맵에 있는 다른 계정의 메시지는 handle 로 렌더된다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 이 스레드 좀 봐줘');
    const { deps, plans } = await makeDeps(fake, { handles: { [ME.id]: ME.handle, 'human-1': 'jaebin' } });

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

    const args = plans[0]!.args.join(' ');
    expect(args).toContain('jaebin: @forge 이 스레드 좀 봐줘');
    expect(args).not.toContain('알 수 없는 사용자');
  });

  it('handles 맵에 없는 작성자는 여전히 "알 수 없는 사용자"로 표시된다 — 회귀 대조', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('ghost-1', '@forge 나 누군지 모를걸');
    const { deps, plans } = await makeDeps(fake, { handles: { [ME.id]: ME.handle } });

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

    expect(plans[0]!.args.join(' ')).toContain('알 수 없는 사용자');
  });

  it('하네스가 비정상 종료하면 던진다 — tail 을 담아 policy.ts::isCredentialFailure 가 판단할 수 있게 한다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps, runTurn } = await makeDeps(fake);
    runTurn.script = async () => ({ exitCode: 1, timedOut: false, tail: 'Could not resolve authentication method' });

    await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null }))
      .rejects.toThrow(/Could not resolve authentication method/);

    // 실패해도 세션 상태는 저장된다 — workspaceDir 과 sessionId 는 남는다.
    // 하지만 #81 수정이 적용되어 lastFedSeq 와 turnsRun 은 전진하지 않는다
    // (전진하면 재시도 시 델타가 비어있을 때 하네스를 안 돌리고 조용히 끝난다).
    const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
    expect(rec).toBeDefined();
    expect(rec!.workspaceDir).toBeDefined();
    expect(rec!.sessionId).not.toBeNull();
    expect(rec!.turnsRun).toBe(0); // 전진하지 않음
    expect(rec!.lastFedSeq).toBe(0); // 전진하지 않음
  });

  // fix round 1 — 리뷰 Important: store.put 이 관측(readThread)·통보(post) 보다 뒤에 있으면,
  // 하네스는 정상 종료했는데 그 둘 중 하나가 예외를 던졌을 때(예: murmur 네트워크 순간
  // 끊김) 실제로 돌아간 턴이 디스크에 기록되지 않는다 — workspace 는 이미 만들어졌고
  // claude 세션도 이미 생겼는데 turnsRun 이 0 인 채로 남아, 다음 재시도가 새 uuid 를
  // 발급해 세션을 고아로 만들거나 이미 먹인 메시지를 다시 먹인다. 두 실패 지점(post,
  // readThread) 을 각각 재현해 store.put 이 이미 끝나 있음을 고정한다.
  describe('세션 상태는 관측·통보보다 먼저 저장된다 (fix round 1)', () => {
    it('발화 확인 뒤 post 가 던져도 세션은 이미 저장돼 있다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps } = await makeDeps(fake); // 기본 스크립트: exit 0, 발화 없음 → NO_REPLY 시도
      vi.spyOn(fake, 'post').mockRejectedValueOnce(new Error('network blip'));

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null })).resolves.toBeUndefined();

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
      expect(rec).toBeDefined();
      expect(rec!.turnsRun).toBe(1);
      expect(rec!.sessionId).not.toBeNull(); // 다음 턴이 이 sessionId 로 resume 할 수 있다
    });

    it('발화 확인용 readThread 가 던져도 세션은 이미 저장돼 있다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps } = await makeDeps(fake);
      const original = fake.readThread.bind(fake);
      let calls = 0;
      // 첫 호출(턴 시작 전 thread 조회)은 정상 통과시키고, 두 번째 호출(턴 뒤 발화 확인)만 던진다.
      vi.spyOn(fake, 'readThread').mockImplementation((...args: Parameters<typeof original>) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('network blip'));
        return original(...args);
      });

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null })).resolves.toBeUndefined();

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
      expect(rec).toBeDefined();
      expect(rec!.turnsRun).toBe(1);
      expect(rec!.sessionId).not.toBeNull();
    });
  });

  // fix round 2 — 리뷰 지적: isFirstTurn 을 turnsRun 하나로만 판단하면, codex 턴이 실제로
  // 돌았는데(turnsRun>=1) 그 뒤 세션 발견(findCodexSessionId)이 실패해 sessionId 가 여전히
  // null 인 경우를 못 잡는다. 그러면 다음 턴이 isFirstTurn:false + sessionId:null 로
  // 조립되고 assertValidSession 이 던지는데, turnsRun 은 그 실패로 줄지 않으니 이 스레드가
  // 재시도 한도까지 영원히 실패한다(리뷰가 실물로 재현). 테스트 환경엔 실제 rollout 파일이
  // 없어 findCodexSessionId 가 항상 null 을 돌려주므로, 이 시나리오를 그대로 재현할 수 있다.
  it('codex 세션 발견이 실패해도(turnsRun>=1, sessionId 여전히 null) 다음 턴은 isFirstTurn:true 로 다시 시작한다 — 영구 벽돌 방지', async () => {
    const fake = new FakeMurmur(defOf({ harness: 'codex' }));
    fake.seedFrom('human-1', '@forge 첫 질문');
    const { deps, plans, runTurn } = await makeDeps(fake);
    runTurn.script = async () => {
      await fake.post(CHANNEL, '답변', null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });
    const rec1 = deps.store.get(SessionStore.threadKey(CHANNEL, null))!;
    expect(rec1.turnsRun).toBe(1);
    expect(rec1.sessionId).toBeNull(); // 테스트 cwd 와 일치하는 실제 rollout 파일이 없어 발견 실패

    fake.seedFrom('human-1', '두 번째 질문');
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

    expect(plans).toHaveLength(2);
    expect(plans[1]!.args[0]).toBe('exec'); // resume 이 아니다 — 이어받을 세션 id 가 없다
    expect(plans[1]!.args).not.toContain('resume');
  });

  // #82 테스트: MAX_ATTEMPTS 소진 시 채널에 한 번만 통지한다.
  // 이 테스트는 notice 가 있다는 것만 확인하고, 실제 발화는 main.ts 가 한다.
  describe('실패 통지 (#82 수정)', () => {
    it('FAILURE_NOTICE 상수가 정의되어 있다', async () => {
      const { FAILURE_NOTICE } = await import('../src/prompt.js');
      expect(FAILURE_NOTICE).toBeDefined();
      expect(typeof FAILURE_NOTICE).toBe('string');
      expect(FAILURE_NOTICE.length).toBeGreaterThan(0);
    });
  });

  // fix round 2 — 리뷰 지적: `def.workingDir ?? process.cwd()` 가 "지정 안 함"과 "명시적으로
  // 지정함"을 뭉갠다. 전자에서 러너 자신의 체크아웃으로 떨어지는 것은 누구도 요청한 적
  // 없는 동작이라, workingDir===null 일 땐 avcs 를 아예 시도하지 않고 스레드 전용
  // 디렉터리만 만든다.
  describe('workingDir 이 지정되지 않았을 때', () => {
    it('avcs 를 시도하지 않고 평범한 mkdir 로 스레드 전용 디렉터리를 실제로 만든다', async () => {
      const fake = new FakeMurmur(defOf({ workingDir: null }));
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps, execCalls } = await makeDeps(fake);

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

      expect(execCalls).toHaveLength(0); // avcs 를 부르지 않았다
      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
      expect(rec).toBeDefined();
      const info = await stat(rec!.workspaceDir); // mkdir 이 실제로 일어났는지 확인
      expect(info.isDirectory()).toBe(true);
    });

    // 대조: workingDir 이 명시됐는데 avcs repo 가 아니면 지금처럼 그 디렉터리를 그대로
    // 쓴다(폴백 유지) — 사용자가 그 파일들에서 일하라고 지정한 것이라 빈 디렉터리로
    // 갈아치우면 설정이 장식이 된다.
    it('workingDir 이 명시됐지만 avcs repo 가 아니면 지정된 디렉터리를 그대로 쓴다', async () => {
      const fake = new FakeMurmur(defOf({ workingDir: '/some/explicit/repo' }));
      fake.seedFrom('human-1', '@forge 안녕');
      const notAvcsExec: Exec = async () => ({
        code: 1, stdout: '', stderr: 'error: not an AVCS repo: /some/explicit/repo',
      });
      const { deps } = await makeDeps(fake, { exec: notAvcsExec });

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null });

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
      expect(rec!.workspaceDir).toBe('/some/explicit/repo');
    });
  });
});

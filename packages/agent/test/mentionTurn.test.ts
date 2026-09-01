// 통합 테스트 — 인메모리 murmur 클라이언트 + 가짜 하네스(runTurn 주입)로 main.ts 의 폴
// 루프에서 분리된 조립 함수(runMentionTurn)를 프로세스 경계·네트워크 없이 검증한다.
//
// "에이전트가 스스로 발화한다"는 실제로는 하네스 프로세스 안에서 murmur MCP 를 불러
// 일어나는 일이라 이 테스트(프로세스 경계 밖)에서 직접 재현할 수 없다 — 그래서 runTurn
// 스텁이 하네스 대신 fakeMurmur.post 를 호출해 "턴 도중 에이전트가 답을 올렸다"를
// 흉내낸다(task-9 브리프 시나리오 1 주석 그대로).
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

function defOf(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: ME.id, handle: ME.handle, displayName: 'forge', kind: 'agent', isAdmin: false,
    instructions: '친절하게 답한다', harness: 'claude-code', model: null, effort: null,
    workingDir: null, mentionPermission: 'auto', ownerAccountId: 'human-1',
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
    workspaceBaseDir: '/fake/workspaces',
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

    // 실패했어도 세션 상태는 저장된다 — 재시도가 존재하지 않는 세션을 다시 만들려 들면 안 된다.
    const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
    expect(rec).toBeDefined();
    expect(rec!.turnsRun).toBe(1);
  });
});

// 통합 테스트 — 인메모리 murmur 클라이언트 + 가짜 하네스(runTurn 주입)로 main.ts 의 폴
// 루프에서 분리된 조립 함수(runMentionTurn)를 프로세스 경계·네트워크 없이 검증한다.
//
// "에이전트가 스스로 발화한다"는 실제로는 하네스 프로세스 안에서 murmur MCP 를 불러
// 일어나는 일이라 이 테스트(프로세스 경계 밖)에서 직접 재현할 수 없다 — 그래서 runTurn
// 스텁이 하네스 대신 fakeMurmur.post 를 호출해 "턴 도중 에이전트가 답을 올렸다"를
// 흉내낸다(task-9 브리프 시나리오 1 주석 그대로).
import { lstat, mkdir, mkdtemp, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentView, MessageRow } from '@murmur/shared';
import { mentionAnchor, runMentionTurn, syncSkills, type MentionTurnDeps, type MentionTurnMurmur, type RunTurn } from '../src/mentionTurn.js';
import { NO_REPLY_NOTICE } from '../src/prompt.js';
import { MurmurAgentClient } from '../src/murmur.js';
import { SessionStore } from '../src/sessions.js';
import type { Exec } from '../src/workspace.js';
import type { TurnPlan } from '../src/turn.js';
import type { TurnResult } from '../src/pty.js';

const ME = { id: 'agent-1', handle: 'forge' };
const CHANNEL = 'c1';
// 리액션 대상은 멘션 메시지 자체다(앵커가 아니다). 앵커와 다른 값을 쓰는 테스트가
// 있어야 둘을 혼동한 회귀를 잡을 수 있으므로 별도 상수로 둔다.
const MENTION = 'mention-msg';

function msg(seq: number, authorId: string, body: string, threadRootId: string | null = null): MessageRow {
  return {
    id: `m${seq}`, seq, channelId: CHANNEL, threadRootId, authorId, body, kind: 'user', meta: {},
    createdAt: new Date(2026, 8, 1, 0, 0, seq).toISOString(), editedAt: null, reactions: [], attachments: [],
    // #161: 스레드 메타데이터는 **루트에만** 붙는다. 러너는 이것을 읽지 않으므로 여기서는
    // 항상 null 이다 — 옵셔널이 아니라 명시적 null 이라 fixture 도 그것을 적어야 한다.
    replyCount: null, lastReplyAt: null, participantIds: null, alsoInChannel: false,
  };
}

// workingDir 은 기본으로 명시된 값('/repo')을 쓴다 — null(아무도 지정하지 않음)과
// "avcs repo 를 지정했다"는 서로 다른 코드 경로를 타므로(mentionTurn.ts::resolveWorkspaceDir,
// fix round 2), 그 구분 자체를 테스트하는 시나리오만 명시적으로 `workingDir: null` 을 준다.
function defOf(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: ME.id, handle: ME.handle, displayName: 'forge', kind: 'agent', isAdmin: false,
    instructions: '친절하게 답한다', harness: 'claude-code', model: null, effort: null,
    workingDir: '/repo', mentionPermission: 'auto', ownerAccountId: 'human-1', disabled: false,
    runnerVersion: null,
    // #129: 종료 요청 없음이 기본이다. 종료를 검증하는 테스트가 이 값을 덮는다.
    stopRequestedAt: null,
    stopAckedAt: null,
    // #176: 마지막 활동은 **서버가** 들고 있는 사실이고 러너는 그것을 읽지 않는다.
    // 옵셔널이 아니라 명시적 null 이라 fixture 도 그것을 적어야 한다.
    lastTurnAt: null,
    // #186: 에이전트는 상태를 고를 수 없다(서버가 거절한다). DB 기본값 그대로이지만
    // AccountView 의 필수 필드라 fixture 도 적어야 한다.
    status: 'available', statusText: null,
    // #159: 에이전트는 스스로 아바타를 올리지 않는다. AccountView 의 필수 필드라 fixture 도 적는다.
    avatarAttachmentId: null,
    ...overrides,
  };
}

/** MentionTurnMurmur 표면의 인메모리 fake. 스레드 하나(channelId 고정)만 다룬다. */
class FakeMurmur implements MentionTurnMurmur {
  messages: MessageRow[] = [];
  posts: { channelId: string; body: string; threadRootId: string | null }[] = [];
  private seq = 0;
  def: AgentView;
  /** #80 테스트를 위해 readThread 호출 기록 */
  readThreadCalls: { channelId: string; threadRootId: string | null; since?: number }[] = [];
  /** 프로덕션 클라이언트(`murmur.ts::readThread`)의 기본값은 30 이다. 테스트는 창 밖으로
   *  밀려나는 상황을 작은 수로 만들기 위해 이 값을 낮춘다. */
  limit = 30;
  /** 리액션 호출 기록 */
  reactions: { channelId: string; messageId: string; emoji: string; action: 'add' | 'remove' }[] = [];

  constructor(def: AgentView) {
    this.def = def;
  }

  definition(): Promise<AgentView> {
    return Promise.resolve(this.def);
  }

  /**
   * 서버 `listMessages` 의 계약을 그대로 흉내낸다 — **`limit` 까지 포함해서다.**
   * `limit` 을 빼고 "since 만" 흉내내면 이 fake 는 프로덕션이 실제로 갖는 창(window)을
   * 갖지 않게 되고, "창 밖으로 밀려난 구간이 커서 점프에 묻힌다"는 #80 의 결함 자체를
   * 재현할 수 없다(그러면 회귀 테스트가 초록이어도 아무것도 증명하지 못한다).
   *
   * - `since > 0`  → `seq > since` 중 **가장 오래된** limit 개 (델타 경로, 오름차순)
   * - `since` 없음/0 → **가장 최신** limit 개를 오름차순으로 (첫 턴 맥락 경로)
   */
  readThread(channelId: string, threadRootId: string | null, since?: number): Promise<MessageRow[]> {
    this.readThreadCalls.push({ channelId, threadRootId, since });
    const all = this.messages.filter((m) => m.channelId === channelId && m.threadRootId === threadRootId);
    if (since === undefined || since === 0) {
      return Promise.resolve(all.slice(-this.limit));
    }
    return Promise.resolve(all.filter((m) => m.seq > since).slice(0, this.limit));
  }

  post(channelId: string, body: string, threadRootId: string | null): Promise<number> {
    this.posts.push({ channelId, body, threadRootId });
    const m = this.seedFrom(ME.id, body, threadRootId);
    return Promise.resolve(m.seq);
  }

  // #144: 진행 설명 메시지 — 결과 발화로 세지 않는다.
  progress(channelId: string, body: string, threadRootId: string | null): Promise<number> {
    this.posts.push({ channelId, body, threadRootId });
    const m = this.seedFrom(ME.id, body, threadRootId);
    m.kind = 'progress';
    return Promise.resolve(m.seq);
  }

  /**
   * 0보다 크면 addReaction 이 그만큼의 마이크로태스크 틱을 지난 **뒤에** 기록한다.
   * 추가와 제거의 순서 역전을 관측하기 위한 장치다 — 호출 즉시 기록하면 실제 도착
   * 순서를 볼 수 없다.
   *
   * 타이머가 아니라 틱을 쓰는 이유: 타이머는 실행 속도에 의존해 흔들리는데 마이크로
   * 태스크 순서는 결정적이다.
   */
  addDelayTicks = 0;

  /** #139: 기본은 "조회 성공, 저장소 비어 있음". 테스트가 필요하면 갈아끼운다. */
  memory: { core: string | null; slugs: string[] } | Error = { core: null, slugs: [] };

  memoryReads = 0;

  readMemory(): Promise<{ core: string | null; slugs: string[] }> {
    this.memoryReads += 1;
    if (this.memory instanceof Error) return Promise.reject(this.memory);
    return Promise.resolve(this.memory);
  }

  /**
   * #140: 기본은 "조회 성공, 승인된 스킬 없음". 테스트가 배열이나 Error 로 갈아끼운다.
   * Error 를 담을 수 있어야 "조회 실패에도 턴이 진행된다"를 실제로 빨갛게 만들 수 있다 —
   * 프로덕션 클라이언트가 실패를 빈 배열로 삼키면 이 테스트는 아무것도 증명하지 못한다.
   */
  skills: { slug: string; body: string }[] | Error = [];

  skillReads = 0;

  listApprovedSkills(): Promise<{ slug: string; body: string }[]> {
    this.skillReads += 1;
    if (this.skills instanceof Error) return Promise.reject(this.skills);
    return Promise.resolve(this.skills);
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    for (let i = 0; i < this.addDelayTicks; i += 1) await Promise.resolve();
    this.reactions.push({ channelId, messageId, emoji, action: 'add' });
  }

  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji, action: 'remove' });
    return Promise.resolve();
  }

  /** #176: 활동 보고 횟수. 인자가 없으므로(시각은 서버가 찍는다) 셀 것은 이것뿐이다. */
  activityReports = 0;
  /** 보고가 실패하는 상황. 프로덕션 클라이언트도 던진다 — 삼키는 판단은 호출자 몫이다. */
  activityError: Error | null = null;

  reportActivity(): Promise<void> {
    this.activityReports += 1;
    if (this.activityError) return Promise.reject(this.activityError);
    return Promise.resolve();
  }

  /** 사람/동료 에이전트의 메시지를 스레드에 심는다. seq 는 이 fake 가 채번한다. */
  seedFrom(authorId: string, body: string, threadRootId: string | null = null): MessageRow {
    this.seq += 1;
    const m = msg(this.seq, authorId, body, threadRootId);
    this.messages.push(m);
    return m;
  }

  /** 테스트용: 호출 기록 초기화 */
  clearCalls(): void {
    this.readThreadCalls = [];
    this.reactions = [];
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
  // 프로덕션의 배치를 그대로 흉내낸다(main.ts): stateDir 아래에 workspaces/ 가 있고,
  // 지시문 파일은 stateDir 에 직접 놓인다 — 즉 워크스페이스의 **형제**다. stateDir 와
  // workspaceBaseDir 를 같은 디렉터리로 두면 "워크스페이스 밖" 단언이 우연히 통과한다.
  const stateDir = await mkdtemp(join(tmpdir(), 'mention-turn-state-'));
  const workspaceBaseDir = join(stateDir, 'workspaces');
  await mkdir(workspaceBaseDir, { recursive: true });

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
    stateDir,
    murmurUrl: 'http://localhost:3400',
    pat: 'murp_test',
    turnTimeoutMs: 10_000,
    ...overrides,
  };

  return { deps, execCalls, plans, runTurn };
}

/**
 * #117:.plan.stdinFile 에서 프롬프트 내용을 읽는다. stdinFile 이 없으면(인터랙티브·resume)
 * args 에서 찾는다. 이 헬퍼는 argv 에서 stdinFile 로 바뀐 변경(#117) 를 반영한다.
 */
async function getPlanContent(plans: TurnPlan[]): Promise<string[]> {
  return Promise.all(plans.map(async (p) => {
    if (p.stdinFile) {
      return readFile(p.stdinFile, 'utf8');
    }
    return p.args.join(' ');
  }));
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

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

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
    // #117: 프롬프트가 stdin 파일로 이동했다.
    const planContent = await getPlanContent(plans);
    expect(planContent[0]).toContain(`channelId: ${CHANNEL}`);
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

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]!.body).toBe(NO_REPLY_NOTICE);
  });

  // #90: 한 턴에서 두 번 이상 발화하면 경고가 나지만 채널에는 통보하지 않는다.
  it('한 턴에 두 번 이상 발화하면 경고가 나고, NO_REPLY_NOTICE 는 안 난다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 질문');
    const { deps, runTurn } = await makeDeps(fake);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 하네스가 두 번 발화하도록 조립 — FakeMurmur.post 가 불릴 때마다 실제 메시지가 남는다
    runTurn.script = async () => {
      await fake.post(CHANNEL, '첫 번째 답', null);
      await fake.post(CHANNEL, '두 번째 답', null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // 채널에는 실제 답 두 개만 남고(세 번째 통보를 더하지 않는다), 경고는 러너 로그에만 남는다
    expect(fake.posts.filter((p) => p.body !== NO_REPLY_NOTICE)).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('한 턴에 발화가 2건'));
    warnSpy.mockRestore();
  });

  // 실패한 턴에서도 중복 발화는 일어난다 — 답을 두 번 올리고 나서 죽는 경우다.
  // 성공 경로만 관측하면 "실패했으니 안 보였다"가 되어 #90 의 관측이 반쪽이 된다.
  it('실패한 턴에서도 두 번 발화하면 경고가 난다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 질문');
    const { deps, runTurn } = await makeDeps(fake);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    runTurn.script = async () => {
      await fake.post(CHANNEL, '첫 번째 답', null);
      await fake.post(CHANNEL, '두 번째 답', null);
      return { exitCode: 1, timedOut: false, tail: '답은 올렸는데 그 뒤에 죽었다' };
    };

    await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION })).rejects.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('한 턴에 발화가 2건'));
    warnSpy.mockRestore();
  });

  it('한 턴에 한 번만 발화하면 경고 없고 NO_REPLY_NOTICE 도 안 난다(회귀)', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 질문');
    const { deps, runTurn } = await makeDeps(fake);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    runTurn.script = async () => {
      await fake.post(CHANNEL, '한 번만 답', null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]!.body).not.toBe(NO_REPLY_NOTICE);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
      const firstSessionId = deps.store.get(SessionStore.threadKey(CHANNEL, null))!.sessionId;

      fake.seedFrom('human-1', '두 번째 질문');
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

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

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
      fake.seedFrom('human-1', '두번째메시지고유문구');
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      // #117: 프롬프트가 stdin 파일로 이동했다.
      const planContent = await getPlanContent(plans);
      const secondTurnArgs = planContent[1];
      expect(secondTurnArgs).toContain('두번째메시지고유문구');
      expect(secondTurnArgs).not.toContain('첫번째메시지고유문구');
      expect(secondTurnArgs).not.toContain('첫번째답변고유문구'); // 세션이 이미 아는 자기 발화도 다시 넘치지 않는다
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

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    const claudeSessionId = deps.store.get(SessionStore.threadKey(CHANNEL, null))!.sessionId;
    const workspaceDirAfterFirst = deps.store.get(SessionStore.threadKey(CHANNEL, null))!.workspaceDir;

    fake.def = defOf({ harness: 'codex' }); // UI 에서 harness 를 codex 로 바꿨다
    fake.seedFrom('human-1', '두 번째 질문');
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

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

  // #92: 지시문이 argv 로 새지 않는지는 **프로덕션 경로**에서 봐야 한다. buildTurnCommand 만
  // 단위 테스트하면 "파일을 쓰는 호출자가 아무도 없다"는 상태를 놓친다(실제로 그랬다).
  it('지시문을 argv 가 아니라 파일로 넘긴다 (#92)', async () => {
    const fake = new FakeMurmur(defOf({ instructions: '절대-argv에-없어야-하는-지시문' }));
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps, plans } = await makeDeps(fake);

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    const argv = plans[0]!.args.join(' ');
    expect(argv).not.toContain('절대-argv에-없어야-하는-지시문');
    expect(plans[0]!.args).toContain('--append-system-prompt-file');

    // 그 경로의 파일에 지시문이 실제로 들어 있고, 퍼미션이 0600 이어야 한다 —
    // argv 에서 빼면서 world-readable 파일에 두면 아무 의미가 없다.
    const i = plans[0]!.args.indexOf('--append-system-prompt-file');
    const filePath = plans[0]!.args[i + 1]!;
    const { readFile, stat } = await import('node:fs/promises');
    expect(await readFile(filePath, 'utf8')).toContain('절대-argv에-없어야-하는-지시문');
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  // 지시문 파일은 러너의 상태 디렉터리에 있어야 한다 — 에이전트 워크스페이스 안에 두면
  // mentionPermission:'auto'(bypassPermissions) 에이전트가 자기 지시문을 고칠 수 있다.
  it('지시문 파일은 에이전트 워크스페이스 밖에 쓴다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps, plans } = await makeDeps(fake);

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    const i = plans[0]!.args.indexOf('--append-system-prompt-file');
    const filePath = plans[0]!.args[i + 1]!;
    const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null))!;
    expect(filePath.startsWith(rec.workspaceDir)).toBe(false);
  });

  // #81 테스트: 실패한 턴에서 lastFedSeq 와 turnsRun 은 전진하지 않는다.
  // 재시도 시점이 델타가 비어있어도 하네스가 다시 떠야 하기 때문이다.
  describe('실패한 턴의 상태 저장 (#81 수정)', () => {
    it('실패 시 lastFedSeq 와 turnsRun 은 전진하지 않는다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => ({ exitCode: 1, timedOut: false, tail: 'some error' });

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
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

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
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

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
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

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
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
      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
        .rejects.toThrow();
      expect(plans).toHaveLength(1); // 첫 턴에서 하네스 실행됨

      // 재시도: 이전 턴이 실패했으면 turnsRun 이 0 이므로,
      // 델타가 비어있어도 하네스를 실행해야 함 (이게 #81 의 핵심 수정)
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
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

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    const key = SessionStore.threadKey(CHANNEL, null);
    const afterFirst = deps.store.get(key)!;
    expect(afterFirst.turnsRun).toBe(1);

    // 다음 폴에서 새 메시지가 자기 발화(예: 다른 프로세스가 같은 계정으로 후속 메모를
    // 남김)뿐이면 프롬프트가 비어 턴을 건너뛴다 — runTurn 이 아예 불리지 않아야 한다.
    fake.seedFrom(ME.id, '자기 후속 메모');
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    expect(plans).toHaveLength(1); // 두 번째 호출은 runTurn 을 안 불렀다

    const afterSkip = deps.store.get(key)!;
    expect(afterSkip.turnsRun).toBe(1); // 하네스가 안 돌았으니 그대로다
    expect(afterSkip.lastFedSeq).toBeGreaterThan(afterFirst.lastFedSeq); // 그래도 fedSeq 는 전진

    // 세 번째: 사람이 진짜로 말을 걸면 resume 이 정상적으로(같은 sessionId, isFirstTurn=false) 조립된다.
    fake.seedFrom('human-1', '진짜 두 번째 질문');
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    expect(plans).toHaveLength(2);
    expect(plans[1]!.args).toContain('-r');
    expect(plans[1]!.args).toContain(afterFirst.sessionId);
  });

  // task-9 브리프 수정 항목 — handles 맵이 배치 단위로 채워져야 동료 발화가 handle 로 렌더된다.
  it('handles 맵에 있는 다른 계정의 메시지는 handle 로 렌더된다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 이 스레드 좀 봐줘');
    const { deps, plans } = await makeDeps(fake, { handles: { [ME.id]: ME.handle, 'human-1': 'jaebin' } });

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // #117: 프롬프트가 stdin 파일로 이동했다.
    const planContent = await getPlanContent(plans);
    expect(planContent[0]).toContain('jaebin: @forge 이 스레드 좀 봐줘');
    expect(planContent[0]).not.toContain('알 수 없는 사용자');
  });

  it('handles 맵에 없는 작성자는 여전히 "알 수 없는 사용자"로 표시된다 — 회귀 대조', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('ghost-1', '@forge 나 누군지 모를걸');
    const { deps, plans } = await makeDeps(fake, { handles: { [ME.id]: ME.handle } });

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // #117: 프롬프트가 stdin 파일로 이동했다.
    const planContent = await getPlanContent(plans);
    expect(planContent[0]).toContain('알 수 없는 사용자');
  });

  it('하네스가 비정상 종료하면 던진다 — tail 을 담아 policy.ts::isCredentialFailure 가 판단할 수 있게 한다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps, runTurn } = await makeDeps(fake);
    runTurn.script = async () => ({ exitCode: 1, timedOut: false, tail: 'Could not resolve authentication method' });

    await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
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

      // #129: 반환값이 생겼다. 여기서 확인하려는 것은 여전히 "던지지 않는다"이고,
      // 종료 요청이 없었다는 사실도 함께 고정한다.
      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
        .resolves.toEqual({ stopRequestedAt: null });

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

      // #129: 반환값이 생겼다. 여기서 확인하려는 것은 여전히 "던지지 않는다"이고,
      // 종료 요청이 없었다는 사실도 함께 고정한다.
      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
        .resolves.toEqual({ stopRequestedAt: null });

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

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    const rec1 = deps.store.get(SessionStore.threadKey(CHANNEL, null))!;
    expect(rec1.turnsRun).toBe(1);
    expect(rec1.sessionId).toBeNull(); // 테스트 cwd 와 일치하는 실제 rollout 파일이 없어 발견 실패

    fake.seedFrom('human-1', '두 번째 질문');
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

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

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      expect(execCalls).toHaveLength(0); // avcs 를 부르지 않았다
      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
      expect(rec).toBeDefined();
      const info = await stat(rec!.workspaceDir); // mkdir 이 실제로 일어났는지 확인
      expect(info.isDirectory()).toBe(true);
    });

    // 대조: workingDir 이 명시됐지만 avcs repo 가 아니면 지금처럼 그 디렉터리를 그대로
    // 쓴다(폴백 유지) — 사용자가 그 파일들에서 일하라고 지정한 것이라 빈 디렉터리로
    // 갈아치우면 설정이 장식이 된다.
    it('workingDir 이 명시됐지만 avcs repo 가 아니면 지정된 디렉터리를 그대로 쓴다', async () => {
      const fake = new FakeMurmur(defOf({ workingDir: '/some/explicit/repo' }));
      fake.seedFrom('human-1', '@forge 안녕');
      const notAvcsExec: Exec = async () => ({
        code: 1, stdout: '', stderr: 'error: not an AVCS repo: /some/explicit/repo',
      });
      const { deps } = await makeDeps(fake, { exec: notAvcsExec });

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null));
      expect(rec!.workspaceDir).toBe('/some/explicit/repo');
    });
  });

  // #80 테스트: since 커서 wiring
  describe('readThread 에 since 가 실려 간다 (#80 수정)', () => {
    it('첫 턴에서 since=0 으로 읽으면 전체 맥락이 반환된다(회귀 방지)', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '메시지1');
      fake.seedFrom('human-1', '메시지2');
      fake.seedFrom('human-1', '메시지3');
      const { deps } = await makeDeps(fake);

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      // 첫 턴: since=0 이면 서버가 최신 N 개를 반환하므로 전체가 보인다
      // ( 턴 시작 읽기 + 발화 확인 읽기 )
      expect(fake.readThreadCalls).toHaveLength(2);
      expect(fake.readThreadCalls[0]!.since).toBe(0); // 첫 번째: 턴 시작 since=0
    });

    it('재시도 턴에서 lastFedSeq 로 since 를 건다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '첫 질문');
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => {
        await fake.post(CHANNEL, '첫 답', null);
        return { exitCode: 0, timedOut: false, tail: '' };
      };

      // 첫 턴: 성공
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
      fake.clearCalls();

      // 두 번째 턴: lastFedSeq 가 0이 아니므로 since 로 그 값을 건다
      fake.seedFrom('human-1', '두 번째 질문');
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      expect(fake.readThreadCalls).toHaveLength(2); // 턴 시작 + 발화 확인
      // 턴 시작 읽기에서 lastFedSeq 가 since 로 전달된다
      expect(fake.readThreadCalls[0]!.since).toBeGreaterThan(0);
    });

    // 첫 턴은 창(window) 안의 최신 N 개만 본다 — 이건 결함이 아니라 설계다. 에이전트는
    // 대화 도중에 합류하는 것이고, 그 앞은 그가 볼 필요가 없던 이력이다(`messages.ts` 의
    // "since 미지정(0): 오래된 200개가 아니라 최신 N개를 반환한다" 주석과 같은 결).
    // 이 테스트는 그 경계를 사실로 못 박는다 — 아래 회귀 테스트가 무엇을 보장하고
    // 무엇을 보장하지 않는지가 여기서 갈린다.
    it('첫 턴은 창 안의 최신 N 개만 본다 (그 앞은 이력으로 남는다)', async () => {
      const fake = new FakeMurmur(defOf());
      fake.limit = 3;
      for (const b of ['옛1', '옛2', '최근1', '최근2', '최근3']) fake.seedFrom('human-1', b);
      const { deps, plans } = await makeDeps(fake);

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      // #117: 대화 본문이 stdin 파일로 이동했다 — plan.stdinFile 에서 내용을 확인한다.
      const fed = await Promise.all(plans.map(async (p) => {
        if (p.stdinFile) {
          return readFile(p.stdinFile, 'utf8');
        }
        return p.args.join(' ');
      }));
      const fedText = fed.join('\n');
      expect(fedText).toContain('최근3');
      expect(fedText).not.toContain('옛1');
      // 그리고 커서는 본 것 중 최대까지 전진한다 — 옛 것을 다시 새 것으로 들이밀지 않는다.
      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, null))!;
      expect(rec.lastFedSeq).toBe(5);
    });

    // ⚠️ 이 태스크의 존재 이유인 테스트다. **커서가 생긴 뒤로는 유실이 없어야 한다.**
    // desc(최신 N)로만 읽으면, 한 턴 사이에 창보다 많이 쌓였을 때 앞쪽 구간이 프롬프트에
    // 없는데 커서만 최댓값으로 뛰어(`prompt.ts` 의 fedSeq = 받은 것 중 최대 seq) 그 구간이
    // 영영 안 먹힌다. since 커서로 읽으면 창이 델타의 '앞쪽'을 잡으므로 건너뛰지 않는다.
    //
    // #117 수정: 이 테스트는 prompt content 가 stdin 파일로 이동하면서 same content 를
    // 포함해야 한다. fake.limit=3 이라 3 개만 표시되므로, limit 를 높여서 모두 확인한다.
    it('커서가 생긴 뒤에는 창보다 많이 쌓여도 건너뛰는 메시지가 없다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.limit = 10; // #117: limit 를 높여 모든 메시지가 포함되도록 한다
      fake.seedFrom('human-1', '첫 질문');
      const { deps, plans } = await makeDeps(fake);

      // 턴 1: 커서를 세운다.
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      // 그 사이에 창보다 많이 쌓인다.
      const burst = ['폭주1', '폭주2', '폭주3', '폭주4', '폭주5'];
      for (const b of burst) fake.seedFrom('human-1', b);

      // 사람이 더 쓰지 않아도, 아직 안 먹인 것이 남아 있으면 다음 턴들이 그것을 먹는다.
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      // #117: 대화 본문이 stdin 파일로 이동했다 — plan.stdinFile 에서 내용을 확인한다.
      const fed = await Promise.all(plans.map(async (p) => {
        if (p.stdinFile) {
          return readFile(p.stdinFile, 'utf8');
        }
        return p.args.join(' ');
      }));
      const fedText = fed.join('\n');
      for (const b of burst) {
        expect(fedText, `'${b}' 이 어느 턴에도 먹여지지 않았다 — 창 밖에서 유실됐다`).toContain(b);
      }
    });

    it('발화 확인 읽기에서 turnStartSeq 로 since 를 건다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => {
        await fake.post(CHANNEL, '답변', null);
        return { exitCode: 0, timedOut: false, tail: '' };
      };
      fake.clearCalls();

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      // 발화 확인(readThread 2번째 호출)에서 turnStartSeq 가 since 로 전달된다
      expect(fake.readThreadCalls).toHaveLength(2); // 턴 시작 + 발화 확인
      const secondCall = fake.readThreadCalls[1]!;
      expect(secondCall.since).toBeDefined();
      expect(secondCall.since).toBeGreaterThan(0);
    });
  });

  // #98 테스트: 채널 최상위 멘션의 앵커 변경
  describe('채널 최상위 멘션 앵커 (#98 수정)', () => {
    // 시나리오 1: 채널 최상위 멘션 두 건이 서로 다른 세션 키를 갖는다
    // 수정 전: 같은 `_root` 로 뭉쳐 실패
    // 수정 후: 각 멘션의 messageId 로 다른 키를 갖는다
    it('채널 최상위 멘션 두 건이 서로 다른 세션 키를 갖는다', async () => {
      const fake = new FakeMurmur(defOf());
      const m1 = fake.seedFrom('human-1', '@forge 첫 번째 질문');
      const m2 = fake.seedFrom('human-2', '@forge 두 번째 질문');
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => {
        await fake.post(CHANNEL, '답변', m1.id);
        return { exitCode: 0, timedOut: false, tail: '' };
      };

      // 첫 번째 멘션: messageId 를 threadRootId 로 넘긴다 (main.ts 의 계산 결과)
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: m1.id, mentionId: m1.id });

      // 두 번째 멘션: 다른 messageId 를 threadRootId 로 넘긴다
      runTurn.script = async () => {
        await fake.post(CHANNEL, '답변2', m2.id);
        return { exitCode: 0, timedOut: false, tail: '' };
      };
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: m2.id, mentionId: m2.id });

      // 두-mention 이 다른 키를 가져서 세션이 나뉜다
      const key1 = SessionStore.threadKey(CHANNEL, m1.id);
      const key2 = SessionStore.threadKey(CHANNEL, m2.id);
      expect(key1).not.toBe(key2);

      const rec1 = deps.store.get(key1);
      const rec2 = deps.store.get(key2);
      expect(rec1).toBeDefined();
      expect(rec2).toBeDefined();
      expect(rec1!.sessionId).not.toBe(rec2!.sessionId);
    });

    // 시나리오 2: 채널 최상위 멘션의 답이 그 멘션을 루트로 하는 스레드
    it('채널 최상위 멘션의 답이 멘션 messageId 를 루트로 하는 스레드로 간다', async () => {
      const fake = new FakeMurmur(defOf());
      const mentionMsg = fake.seedFrom('human-1', '@forge 안녕');
      mentionMsg.threadRootId = mentionMsg.id;
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => {
        await fake.post(CHANNEL, '안녕하세요!', mentionMsg.id);
        return { exitCode: 0, timedOut: false, tail: '' };
      };

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id });

      // post 가 그 멘션 메시지 id 를 threadRootId 로 받아 스레드가 만들어진다
      expect(fake.posts).toHaveLength(1);
      expect(fake.posts[0]!.threadRootId).toBe(mentionMsg.id);
    });

    // 시나리오 3: 스레드 안의 멘션은 기존 대 로 그 스레드에 답한다 (회귀)
    it('스레드 안의 멘션은 기존대로 그 스레드의 루트를 쓴다 (회귀)', async () => {
      const fake = new FakeMurmur(defOf());
      const rootMsg = fake.seedFrom('human-1', '첫 메시지');
      rootMsg.threadRootId = rootMsg.id;
      fake.seedFrom('human-1', '@forge 스레드 안 질문', rootMsg.id);
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => {
        await fake.post(CHANNEL, '스레드 답변', rootMsg.id);
        return { exitCode: 0, timedOut: false, tail: '' };
      };

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: rootMsg.id, mentionId: rootMsg.id });

      // threadRootId 가 그대로 유지된다
      const key = SessionStore.threadKey(CHANNEL, rootMsg.id);
      expect(deps.store.get(key)).toBeDefined();
      expect(fake.posts[0]!.threadRootId).toBe(rootMsg.id);
    });

    // 시나리오 4: 같은 스레드의 두 번째 멘션이 첫 턴의 세션을 이어받는다 (회귀)
    it('같은 스레드의 두 번째 멘션이 첫 턴의 세션을 이어받는다 (회귀)', async () => {
      const fake = new FakeMurmur(defOf());
      const rootMsg = fake.seedFrom('human-1', '첫 질문');
      rootMsg.threadRootId = rootMsg.id;
      const { deps, runTurn } = await makeDeps(fake);
      runTurn.script = async () => {
        await fake.post(CHANNEL, '첫 답', rootMsg.id);
        return { exitCode: 0, timedOut: false, tail: '' };
      };

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: rootMsg.id, mentionId: rootMsg.id });
      const firstSessionId = deps.store.get(SessionStore.threadKey(CHANNEL, rootMsg.id))!.sessionId;

      // 두 번째 턴
      fake.seedFrom('human-1', '두 번째 질문', rootMsg.id);
      runTurn.script = async () => {
        await fake.post(CHANNEL, '두 번째 답', rootMsg.id);
        return { exitCode: 0, timedOut: false, tail: '' };
      };
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: rootMsg.id, mentionId: rootMsg.id });

      const rec = deps.store.get(SessionStore.threadKey(CHANNEL, rootMsg.id));
      expect(rec!.sessionId).toBe(firstSessionId);
      expect(rec!.turnsRun).toBe(2);
    });
  });

  // #144: progress 메시지는 결과 발화로 세지 않는다.
// 에이전트가 message.progress MCP 도구로 진행 설명을 올리면, kind='progress'로 저장되어
// countOwnPostsSince에서 자동으로 제외된다.
describe('진행 설명 메시지 (#144)', () => {
  // runTurn 스텁 안에서 에이전트가 progress 메서드를 호출하는 것을 흉내낸다.
  // FakeMurmur.progress()는 kind='progress' 메시지를 생성한다.
  const withProgress = (body: () => Promise<void>) => async () => {
    await body();
    return { exitCode: 0, timedOut: false, tail: '' };
  };

  it('progress 메시지만 있으면 NO_REPLY_NOTICE가 나간다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 질문');
    const { deps, runTurn } = await makeDeps(fake, {});
    // 에이전트가 progress 메시지만 올림 (결과 없음)
    runTurn.script = withProgress(async () => {
      await fake.progress(CHANNEL, 'avcs intent 작업을 시작합니다 — 서너 턴 걸립니다', null);
    });

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // progress 메시지가 있음
    const progressPosts = fake.posts.filter((p) => p.body.includes('avcs intent'));
    expect(progressPosts).toHaveLength(1);
    // NO_REPLY_NOTICE가 나감 — progress 메시지는 결과 발화로 세지 않음
    const noReplyPosts = fake.posts.filter((p) => p.body === NO_REPLY_NOTICE);
    expect(noReplyPosts).toHaveLength(1);
  });

  it('progress + 결과 메시지가 있으면 NO_REPLY_NOTICE가 나가지 않는다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 질문');
    const { deps, runTurn } = await makeDeps(fake, {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 에이전트가 progress 메시지와 결과 메시지를 둘 다 올림
    runTurn.script = withProgress(async () => {
      await fake.progress(CHANNEL, 'avcs intent 작업을 시작합니다', null);
      await fake.post(CHANNEL, '결과를 만들었습니다', null);
    });

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // 경고가 나지 않음 — progress + 결과는 2개의 게시물이 아님
    expect(warnSpy).not.toHaveBeenCalled();
    expect(fake.posts.filter((p) => p.body === NO_REPLY_NOTICE)).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('결과 메시지만 있으면 NO_REPLY_NOTICE가 나가지 않는다 (기존 회귀선)', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 질문');
    const { deps, runTurn } = await makeDeps(fake, {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 에이전트가 결과 메시지만 올림 (progress 없음)
    runTurn.script = withProgress(async () => {
      await fake.post(CHANNEL, '답변입니다', null);
    });

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    expect(fake.posts.filter((p) => p.body === NO_REPLY_NOTICE)).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('결과 메시지 2건이면 중복 발화 경고가 난다 (#90 관측)', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 질문');
    const { deps, runTurn } = await makeDeps(fake, {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 에이전트가 결과 메시지를 2번 올림
    runTurn.script = withProgress(async () => {
      await fake.post(CHANNEL, '첫 번째 답', null);
      await fake.post(CHANNEL, '두 번째 답', null);
    });

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('한 턴에 발화가 2건'));
    warnSpy.mockRestore();
  });
});

  // #126: 턴 시작/종료 로그
  describe('턴 시작/종료 로그 (#126 수정)', () => {
    it('턴 시작 로그가 남는다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 질문');
      const { deps } = await makeDeps(fake);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('턴 시작'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(`채널=${CHANNEL}`),
      );
      logSpy.mockRestore();
    });

    it('턴 종료 로그가 남는다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 질문');
      const { deps } = await makeDeps(fake);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('턴 종료'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('경과='),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('exitCode=0'),
      );
      logSpy.mockRestore();
    });

    it('타임아웃 시 종료 로그에 timeout 이 포함된다', async () => {
      const fake = new FakeMurmur(defOf());
      fake.seedFrom('human-1', '@forge 질문');
      const { deps, runTurn } = await makeDeps(fake);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      runTurn.script = async () => ({ exitCode: 0, timedOut: true, tail: 'timeout' });

      await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
        .rejects.toThrow();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('timeout'),
      );
      logSpy.mockRestore();
    });
  });
});

// 👀 💬 리액션 신호 회귀 테스트
describe('리액션 신호 (👀 💬)', () => {
  it('👀 가 runTurn 호출 전에 걸린다 (순서 검증)', async () => {
    const fake = new FakeMurmur(defOf());
    const mentionMsg = fake.seedFrom('human-1', '@forge 안녕');
    mentionMsg.threadRootId = mentionMsg.id; // 채널 최상위 멘션을 스레드로 만든다
    const { deps, runTurn } = await makeDeps(fake);

    let turnCalled = false;
    runTurn.script = async () => {
      turnCalled = true;
      // runTurn 이 불린 시점에 👀 가 이미 추가돼 있어야 한다
      const eyesReaction = fake.reactions.find(
        (r) => r.messageId === mentionMsg.id && r.emoji === '👀' && r.action === 'add',
      );
      expect(eyesReaction).toBeDefined();
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id });

    expect(turnCalled).toBe(true);
  });

  // 스레드 안의 멘션에서 앵커는 **스레드 루트**이고 리액션 대상은 방금 온 멘션이다.
  // 두 값이 같은 테스트만 있으면 앵커를 대상으로 쓰는 회귀가 통과해 버린다 — 실제로
  // main.ts 가 mentionId 를 넘기지 않아 앵커가 대상이 되던 결함이 그렇게 숨어 있었다.
  it('리액션 대상은 앵커가 아니라 멘션 메시지다', async () => {
    const fake = new FakeMurmur(defOf());
    const root = fake.seedFrom('human-1', '스레드 루트');
    root.threadRootId = root.id;
    const mentionMsg = fake.seedFrom('human-1', '@forge 이것 좀', root.id);
    const { deps } = await makeDeps(fake);

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: root.id, mentionId: mentionMsg.id });

    const targets = new Set(fake.reactions.map((r) => r.messageId));
    expect(targets).toEqual(new Set([mentionMsg.id]));
    expect(targets.has(root.id)).toBe(false);
  });

  // 턴이 아주 짧으면 제거가 추가를 앞질러 서버에 닿아 💬 가 영구히 남는다. 같은 파일의
  // ackInFlight 가 이미 이 함정을 기록한다 — 리액션에서 같은 실수를 반복했다.
  it('추가가 늦어도 제거가 추가를 앞지르지 않는다', async () => {
    const fake = new FakeMurmur(defOf());
    const mentionMsg = fake.seedFrom('human-1', '@forge 안녕');
    mentionMsg.threadRootId = mentionMsg.id;
    const { deps, runTurn } = await makeDeps(fake);
    // 턴은 즉시 끝난다 — 추가 왕복이 아직 진행 중인 상태에서 finally 에 들어간다.
    runTurn.script = async () => ({ exitCode: 0, timedOut: false, tail: '' });
    fake.addDelayTicks = 5;

    await runMentionTurn(deps, {
      channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id,
    });

    const speaking = fake.reactions.filter((r) => r.emoji === '💬');
    expect(speaking.map((r) => r.action)).toEqual(['add', 'remove']);
  });

  it('💬 가 턴 시작 시 걸리고 턴 종료 후 제거된다', async () => {
    const fake = new FakeMurmur(defOf());
    const mentionMsg = fake.seedFrom('human-1', '@forge 안녕');
    mentionMsg.threadRootId = mentionMsg.id;
    const { deps, runTurn } = await makeDeps(fake);

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id });

    // 💬 가 add 되고 remove 된다
    const speakingAdd = fake.reactions.filter(
      (r) => r.messageId === mentionMsg.id && r.emoji === '💬' && r.action === 'add',
    );
    const speakingRemove = fake.reactions.filter(
      (r) => r.messageId === mentionMsg.id && r.emoji === '💬' && r.action === 'remove',
    );
    expect(speakingAdd).toHaveLength(1);
    expect(speakingRemove).toHaveLength(1);
    // 추가 후 제거 순서
    expect(fake.reactions.indexOf(speakingAdd[0]!)).toBeLessThan(fake.reactions.indexOf(speakingRemove[0]!));
  });

  it('runTurn 이 던져도 💬 가 제거된다', async () => {
    const fake = new FakeMurmur(defOf());
    const mentionMsg = fake.seedFrom('human-1', '@forge 안녕');
    mentionMsg.threadRootId = mentionMsg.id;
    const { deps, runTurn } = await makeDeps(fake);

    runTurn.script = async () => {
      throw new Error('하네스 실패');
    };

    await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id }))
      .rejects.toThrow();

    // 💬 가 제거됐는지 확인
    const speakingRemove = fake.reactions.find(
      (r) => r.messageId === mentionMsg.id && r.emoji === '💬' && r.action === 'remove',
    );
    expect(speakingRemove).toBeDefined();
  });

  it('runTurn 이 타임아웃이어도 💬 가 제거된다', async () => {
    const fake = new FakeMurmur(defOf());
    const mentionMsg = fake.seedFrom('human-1', '@forge 안녕');
    mentionMsg.threadRootId = mentionMsg.id;
    const { deps, runTurn } = await makeDeps(fake);

    runTurn.script = async () => ({ exitCode: 0, timedOut: true, tail: 'timeout' });

    await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id }))
      .rejects.toThrow();

    // 💬 가 제거됐는지 확인
    const speakingRemove = fake.reactions.find(
      (r) => r.messageId === mentionMsg.id && r.emoji === '💬' && r.action === 'remove',
    );
    expect(speakingRemove).toBeDefined();
  });

  it('리액션 호출이 실패해도 턴이 정상 완료된다', async () => {
    const fake = new FakeMurmur(defOf());
    const mention = fake.seedFrom('human-1', '@forge 질문');
    mention.threadRootId = mention.id;
    const { deps, runTurn } = await makeDeps(fake);

    // 리액션을 실패하도록 조립
    vi.spyOn(fake, 'addReaction').mockRejectedValueOnce(new Error('network error'));
    vi.spyOn(fake, 'removeReaction').mockRejectedValueOnce(new Error('network error'));

    runTurn.script = async () => {
      await fake.post(CHANNEL, '답변', mention.id);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    // 에러 없이 완료되어야 함
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mention.id, mentionId: mention.id });

    // 발화는 정상적으로 되었는지 확인
    const actualPosts = fake.posts.filter((p: { body: string }) => p.body !== NO_REPLY_NOTICE);
    expect(actualPosts).toHaveLength(1);
  });

  it('리액션을 추가해도 post 호출 횟수가 늘지 않는다 (리액션 != 발화)', async () => {
    const fake = new FakeMurmur(defOf());
    const mentionMsg = fake.seedFrom('human-1', '@forge 안녕');
    mentionMsg.threadRootId = mentionMsg.id;
    const { deps } = await makeDeps(fake);

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id });

    // 기본 runTurn.script 는 발화 없이 끝나므로 NO_REPLY_NOTICE 가 하나 있음
    const noReplyCount = fake.posts.filter((p: { body: string }) => p.body === NO_REPLY_NOTICE).length;
    expect(noReplyCount).toBe(1); // 기본 스크립트라 NO_REPLY_NOTICE 만 있음
  });
});

// #98 의 본론은 "채널 최상위 멘션의 앵커를 무엇으로 삼는가"이고, 그 규칙은 순수 함수 하나가
// 갖는다. 초판은 이 계산을 main.ts 에 인라인으로 뒀는데 main.ts 는 top-level 스크립트라
// 테스트가 겨눌 수 없어서, 규칙을 되돌려도 이 파일의 테스트가 전부 초록이었다(확인했다).
describe('mentionAnchor', () => {
  it('스레드 안의 멘션은 그 스레드의 루트를 쓴다', () => {
    expect(mentionAnchor({ id: 'msg-2', threadRootId: 'root-1' })).toBe('root-1');
  });

  it('채널 최상위 멘션은 그 멘션 메시지 자신을 쓴다 — _root 로 뭉치지 않는다', () => {
    expect(mentionAnchor({ id: 'msg-9', threadRootId: null })).toBe('msg-9');
  });

  it('서로 다른 최상위 멘션은 서로 다른 앵커를 갖는다 (세션 격리의 근거)', () => {
    const a = mentionAnchor({ id: 'msg-a', threadRootId: null });
    const b = mentionAnchor({ id: 'msg-b', threadRootId: null });
    expect(a).not.toBe(b);
    expect(SessionStore.threadKey(CHANNEL, a)).not.toBe(SessionStore.threadKey(CHANNEL, b));
  });
});

describe('메모리 주입 (#139)', () => {
  // 매 턴 다시 읽는다. 시스템 프롬프트가 매 턴 새로 쓰이므로 캐시 없이 다음 턴부터
  // 반영된다 — 캐시를 넣으면 그 이점을 없애고 무효화 문제를 새로 만든다.
  //
  // 프롬프트 내용은 buildSystemPrompt 단위 테스트가 덮는다(#117 이후 지시문은 파일로
  // 나가므로 plan.systemPrompt 로는 볼 수 없다). 여기서 지킬 것은 **읽는 횟수**다.
  it('턴마다 메모리를 다시 읽는다', async () => {
    const fake = new FakeMurmur(defOf());
    const mentionMsg = fake.seedFrom('human-1', '@forge 안녕');
    mentionMsg.threadRootId = mentionMsg.id;
    const { deps } = await makeDeps(fake);

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id });
    expect(fake.memoryReads).toBe(1);

    // 스레드에 새 메시지가 있어야 두 번째 턴이 돈다 — 먹일 것이 없으면 조기 반환한다.
    fake.seedFrom('human-1', '@forge 또', mentionMsg.id);
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id });
    expect(fake.memoryReads).toBe(2);
  });

  // 조회가 실패해도 턴은 돈다 — 기억이 없다고 응답을 못 하게 만들면 장애가 침묵이 된다.
  it('메모리 조회가 실패해도 턴이 정상 진행된다', async () => {
    const fake = new FakeMurmur(defOf());
    const mentionMsg = fake.seedFrom('human-1', '@forge 안녕');
    mentionMsg.threadRootId = mentionMsg.id;
    fake.memory = new Error('db down');
    const { deps, runTurn } = await makeDeps(fake);
    let ran = false;
    runTurn.script = async () => {
      ran = true;
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: mentionMsg.id, mentionId: mentionMsg.id });

    expect(ran).toBe(true);
    expect(fake.memoryReads).toBe(1);
  });
});

describe('종료 요청 (#129)', () => {
  // #129 회귀: 종료 요청은 턴 **시작 직후**에 읽는 정의에 실려 오지만, 그것을 본 즉시
  // 물러나면 사람이 기다리는 답이 사라진다. 이 함수는 사실만 돌려주고 물러날지는
  // 호출자(main.ts 의 폴 루프)가 턴이 끝난 뒤에 정한다.
  it('종료 요청이 와 있어도 턴을 끝까지 마치고, 요청은 반환값으로만 알린다', async () => {
    const REQUESTED_AT = '2026-09-03T10:00:00.000Z';
    const fake = new FakeMurmur(defOf({ stopRequestedAt: REQUESTED_AT }));
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps, plans, runTurn } = await makeDeps(fake);
    runTurn.script = async () => {
      await fake.post(CHANNEL, '답이다', null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    const result = await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // 턴이 실제로 돌았다: 하네스를 띄웠고, 답이 올라갔고, 세션이 저장됐다.
    expect(plans).toHaveLength(1);
    expect(fake.posts.map((p) => p.body)).toEqual(['답이다']);
    expect(deps.store.get(SessionStore.threadKey(CHANNEL, null))!.turnsRun).toBe(1);
    // 💬 도 제거됐다 — 정상 종료 경로를 그대로 탔다는 증거다(중간에 돌아섰다면 남는다).
    expect(fake.reactions.filter((r) => r.emoji === '💬' && r.action === 'remove')).toHaveLength(1);
    // 그리고 요청은 호출자에게 전달된다.
    expect(result.stopRequestedAt).toBe(REQUESTED_AT);
  });
});

describe('활동 보고 (#176)', () => {
  // 이 값이 화면의 "마지막 활동: N분 전"이 되는 유일한 원천이다 — 러너가 부르지 않으면
  // 화면은 영원히 '활동 없음'을 그린다(서버는 러너 프로세스를 보지 못한다).
  it('턴이 끝나면 보고한다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps, runTurn } = await makeDeps(fake);
    runTurn.script = async () => {
      // 보고는 턴이 **끝난 뒤**여야 한다 — 시작 시각을 보고하면 긴 턴이 도는 동안 화면이
      // 계속 오래된 값을 보여 준다. 여기서 아직 보고가 없어야 그 순서가 지켜진 것이다.
      expect(fake.activityReports).toBe(0);
      await fake.post(CHANNEL, '답이다', null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    expect(fake.activityReports).toBe(1);
  });

  // 발화 없이 끝나는 턴(도구만 쓰고 끝난다)도 활동이다 — 발화를 활동으로 삼으면 그런 턴이
  // 화면에서 사라진다. 그래서 보고는 발화 여부와 무관하다.
  it('발화가 없는 턴도 보고한다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps } = await makeDeps(fake);

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    expect(fake.activityReports).toBe(1);
    // 발화가 없었다는 것 자체도 확인한다 — 있었다면 위 단언이 다른 것을 증명한 셈이 된다.
    // (NO_REPLY_NOTICE 통보는 러너가 올린 것이지 에이전트의 답이 아니다.)
    expect(fake.posts.map((p) => p.body)).toEqual([NO_REPLY_NOTICE]);
  });

  // 활동 보고가 안 됐다고 사람이 기다리는 답을 못 준 것은 아니다. 여기서 던지면 세션 상태
  // 저장·발화 확인까지 건너뛰고, 다음 턴이 같은 메시지를 다시 먹인다.
  it('보고가 실패해도 턴은 성공으로 끝난다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    fake.activityError = new Error('agent/activity 실패: 503');
    const { deps, runTurn } = await makeDeps(fake);
    runTurn.script = async () => {
      await fake.post(CHANNEL, '답이다', null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    // 던지지 않는다.
    const result = await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    expect(fake.activityReports).toBe(1);
    expect(result.stopRequestedAt).toBeNull();
    // 그리고 턴의 결과가 전부 남았다: 답이 올라갔고, 세션이 전진했고, 💬 가 제거됐다.
    expect(fake.posts.map((p) => p.body)).toEqual(['답이다']);
    expect(deps.store.get(SessionStore.threadKey(CHANNEL, null))!.turnsRun).toBe(1);
    expect(fake.reactions.filter((r) => r.emoji === '💬' && r.action === 'remove')).toHaveLength(1);
  });

  // 실패한 턴도 움직인 턴이다 — "마지막으로 언제 움직였나"에 성공 여부는 들어 있지 않다.
  // 이것이 없으면 계속 실패하는 러너가 화면에서 '활동 없음'으로 보여, 운영자는 러너가 아예
  // 안 붙었다고 오해한다.
  it('턴이 실패해도 활동은 보고한다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps, runTurn } = await makeDeps(fake);
    runTurn.script = async () => ({ exitCode: 1, timedOut: false, tail: 'boom' });

    await expect(
      runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }),
    ).rejects.toThrow(/harness 종료 1/);

    expect(fake.activityReports).toBe(1);
  });
});

// #140 워크스페이스 스킬 — 러너 쪽 보증.
//
// **전부 runMentionTurn 을 통과시킨다.** syncSkills 를 손으로만 부르는 테스트는 러너가
// 그것을 부르지 않아도(또는 await 하지 않아도) 초록이다 — 첫 구현이 실제로 await 없이
// 불러서, 하네스는 아직 없는 스킬 디렉터리를 읽고 스킬은 항상 한 턴 늦게 붙었다.
// 그 결함을 잡는 것은 "턴 도중에 읽힌다"는 단언뿐이다.
describe('runMentionTurn: 스킬 동기화(#140)', () => {
  const BODY = '# 배포 절차\n1. 확인한다';

  /** exec 기록에서 워크스페이스 경로를 읽는다: avcs workspace project <name> --out <dir> */
  function workspaceOf(execCalls: string[][]): string {
    const call = execCalls.find((c) => c[0] === 'avcs' && c[2] === 'project');
    return call![5]!;
  }

  // 요구 6.
  it('승인된 스킬을 상태 디렉터리에 쓰고 하네스 디렉터리로 심볼릭 링크한다 — 복사가 아니다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    fake.skills = [{ slug: 'deploy-runbook', body: BODY }];
    const { deps, execCalls, runTurn } = await makeDeps(fake);

    // 하네스가 도는 **그 시점에** 스킬이 읽혀야 한다. 동기화를 await 하지 않으면 null 이다.
    let seenDuringTurn: string | null = null;
    runTurn.script = async (_plan, opts) => {
      seenDuringTurn = await readFile(
        join(opts.cwd, '.claude', 'skills', 'deploy-runbook', 'SKILL.md'), 'utf8',
      ).catch(() => null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // 본문은 워크스페이스 **밖** 상태 디렉터리에 있다(avcs 가 쓸어 가지 못하는 자리).
    const skillDir = join(deps.stateDir, 'skills', 'deploy-runbook');
    expect(await readFile(join(skillDir, 'SKILL.md'), 'utf8')).toBe(BODY);

    // 워크스페이스 안에 있는 것은 링크뿐이다 — 복사로 되돌리면 isSymbolicLink 가 false 로 빨개진다.
    const link = join(workspaceOf(execCalls), '.claude', 'skills', 'deploy-runbook');
    const st = await lstat(link);
    expect(st.isSymbolicLink()).toBe(true);
    // 링크는 **디렉터리**를 가리킨다. SKILL.md 를 직접 링크하면 하네스는
    // `<링크>/SKILL.md` = `.../SKILL.md/SKILL.md` 를 찾아 아무것도 읽지 못한다.
    expect(await readlink(link)).toBe(skillDir);
    expect(seenDuringTurn).toBe(BODY);
  });

  it('codex 하네스 디렉터리에도 같은 링크가 걸린다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    fake.skills = [{ slug: 'deploy-runbook', body: BODY }];
    const { deps, execCalls } = await makeDeps(fake);

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    const link = join(workspaceOf(execCalls), '.codex', 'skills', 'deploy-runbook');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  // 요구 7.
  it('목록에서 사라진 스킬(비활성·삭제)은 파일과 링크가 함께 사라진다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    fake.skills = [{ slug: 'keep-me', body: '남는다' }, { slug: 'drop-me', body: '사라진다' }];
    const { deps, execCalls } = await makeDeps(fake);

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    const ws = workspaceOf(execCalls);
    expect(await lstat(join(ws, '.claude', 'skills', 'drop-me')).then(() => true, () => false)).toBe(true);

    // 두 번째 턴: 하나가 비활성돼 목록에서 빠졌다.
    fake.skills = [{ slug: 'keep-me', body: '남는다' }];
    fake.seedFrom('human-1', '@forge 또 안녕');
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // 상태 디렉터리의 파일도, 워크스페이스의 링크도 없어야 한다.
    expect(await stat(join(deps.stateDir, 'skills', 'drop-me')).then(() => true, () => false)).toBe(false);
    expect(await lstat(join(ws, '.claude', 'skills', 'drop-me')).then(() => true, () => false)).toBe(false);
    expect(await lstat(join(ws, '.codex', 'skills', 'drop-me')).then(() => true, () => false)).toBe(false);
    // 남은 것은 그대로다.
    expect((await lstat(join(ws, '.claude', 'skills', 'keep-me'))).isSymbolicLink()).toBe(true);
  });

  // 요구 8.
  it('스킬 조회가 실패해도 턴은 진행되고 실패가 stderr 에 한 줄 남는다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    fake.skills = new Error('skills 실패: 503');
    const { deps, runTurn } = await makeDeps(fake);
    runTurn.script = async () => {
      await fake.post(CHANNEL, '답이다', null);
      return { exitCode: 0, timedOut: false, tail: '' };
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // 던지지 않는다.
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

      expect(fake.skillReads).toBe(1);
      expect(fake.posts.map((p) => p.body)).toEqual(['답이다']);
      expect(deps.store.get(SessionStore.threadKey(CHANNEL, null))!.turnsRun).toBe(1);
      // 조용히 넘어가지 않는다 — 운영자가 로그에서 볼 수 있어야 한다.
      const logged = errors.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toMatch(/스킬 동기화 실패/);
      expect(logged).toMatch(/503/);
    } finally {
      errors.mockRestore();
    }
  });

  // 조회 실패를 빈 목록으로 삼키면 "승인된 스킬이 없다"와 같아져, 동기화가 이미 붙어 있는
  // 스킬을 '사라진 것'으로 보고 지운다. 그 삼킴을 되돌리면 이 테스트가 빨개진다.
  it('조회가 실패하면 이미 실체화된 스킬을 지우지 않는다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    fake.skills = [{ slug: 'deploy-runbook', body: BODY }];
    const { deps, execCalls } = await makeDeps(fake);
    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    const ws = workspaceOf(execCalls);

    fake.skills = new Error('skills 실패: 503');
    fake.seedFrom('human-1', '@forge 또 안녕');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    } finally {
      errors.mockRestore();
    }

    expect(await readFile(join(deps.stateDir, 'skills', 'deploy-runbook', 'SKILL.md'), 'utf8')).toBe(BODY);
    expect((await lstat(join(ws, '.claude', 'skills', 'deploy-runbook'))).isSymbolicLink()).toBe(true);
  });
});

describe('syncSkills 단독(#140)', () => {
  async function dirs(): Promise<{ stateDir: string; workspaceDir: string }> {
    const stateDir = await mkdtemp(join(tmpdir(), 'skill-state-'));
    const workspaceDir = join(stateDir, 'workspaces', 'ws');
    await mkdir(workspaceDir, { recursive: true });
    return { stateDir, workspaceDir };
  }

  // 앞선 턴(또는 이전 버전)이 남긴 **복사본**은 갈라진 사본이다 — 링크로 갈아 끼워야 한다.
  it('이전에 남은 복사본을 링크로 갈아 끼운다', async () => {
    const { stateDir, workspaceDir } = await dirs();
    const stale = join(workspaceDir, '.claude', 'skills', 'copied');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'SKILL.md'), '오래된 사본', 'utf8');

    await syncSkills(stateDir, workspaceDir, async () => [{ slug: 'copied', body: '새 본문' }]);

    expect((await lstat(stale)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(stale, 'SKILL.md'), 'utf8')).toBe('새 본문');
  });

  // 워크스페이스는 사람의 작업 공간이다. 우리 상태 디렉터리를 가리키지 않는 것은 남의 것이다.
  it('사람이 직접 둔 스킬 디렉터리와 남의 링크는 지우지 않는다', async () => {
    const { stateDir, workspaceDir } = await dirs();
    const harness = join(workspaceDir, '.claude', 'skills');
    const mine = join(harness, 'hand-written');
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, 'SKILL.md'), '사람이 쓴 것', 'utf8');
    const elsewhere = await mkdtemp(join(tmpdir(), 'other-skill-'));
    await symlink(elsewhere, join(harness, 'other-tool'));

    await syncSkills(stateDir, workspaceDir, async () => []);

    expect(await readFile(join(mine, 'SKILL.md'), 'utf8')).toBe('사람이 쓴 것');
    expect((await lstat(join(harness, 'other-tool'))).isSymbolicLink()).toBe(true);
  });

  it('본문이 바뀌면 링크는 그대로 두고 파일만 갱신한다', async () => {
    const { stateDir, workspaceDir } = await dirs();
    await syncSkills(stateDir, workspaceDir, async () => [{ slug: 's', body: '처음' }]);
    const link = join(workspaceDir, '.claude', 'skills', 's');
    const target = await readlink(link);
    await syncSkills(stateDir, workspaceDir, async () => [{ slug: 's', body: '나중' }]);
    expect(await readlink(link)).toBe(target);
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toBe('나중');
  });
});

// 위 시나리오들은 FakeMurmur 를 태운다 — 그것만으로는 **프로덕션 클라이언트**가 실패를
// 빈 배열로 삼켜도 전부 초록이다(가짜가 대신 던져 주기 때문이다). 그래서 실제 클라이언트를
// 스텁 fetch 로 한 번 태운다: 러너가 stderr 에 한 줄 남길 수 있는지는 여기서 갈린다.
describe('MurmurAgentClient.listApprovedSkills(#140)', () => {
  it('승인된 것만 요청한다 — 미승인 스킬을 실체화하면 승인 게이트가 없는 것과 같다', async () => {
    const original = globalThis.fetch;
    let seen = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen = String(url);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await new MurmurAgentClient('http://localhost:3400', 'murp_t').listApprovedSkills();
      expect(seen).toContain('/skills?state=approved');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('조회 실패를 빈 배열로 삼키지 않고 던진다', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    try {
      const client = new MurmurAgentClient('http://localhost:3400', 'murp_t');
      await expect(client.listApprovedSkills()).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * #141 Phase 2 — 턴을 attach 가능한 세션으로 감싼다. 여기서 지키는 것은 두 가지다:
 *
 * 1. **attach 는 그 턴의 권한을 바꾸지 않는다**(스펙 §6, 요구 7). 지금은 읽기만 하므로
 *    자연히 성립하지만, 그것이 *우연히* 성립하는 상태를 회귀선으로 고정한다 — 나중에
 *    입력을 열 때(별도 후속) 이 선이 빨개지는 것이 그 작업의 시작점이어야 한다.
 * 2. 릴레이가 있어도 없어도 턴은 같은 plan 으로 돈다 — 관찰이 답의 모양을 바꾸면 안 된다.
 */
describe('#141 릴레이 세션 (Phase 2 attach)', () => {
  /** 릴레이 스텁. 열린 세션과 받은 바이트를 기록만 한다. */
  function fakeRelay() {
    const opened: { agentAccountId: string; channelId: string; threadRootId: string | null; harness: string }[] = [];
    const bytes: Buffer[] = [];
    let closed = 0;
    return {
      opened, bytes, closedCount: () => closed,
      relay: {
        openSession(input: { agentAccountId: string; channelId: string; threadRootId: string | null; harness: 'claude-code' | 'codex' | 'gemini' }) {
          opened.push(input);
          return {
            sessionId: `sess-${opened.length}`,
            push: (chunk: Buffer) => { bytes.push(chunk); },
            close: () => { closed += 1; },
          };
        },
      },
    };
  }

  it('턴을 세션으로 감싸고 PTY 바이트를 흘린다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const r = fakeRelay();
    const { deps, runTurn } = await makeDeps(fake, { relay: r.relay });
    const raw = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xed, 0x95]);
    runTurn.script = async (_plan, opts) => {
      // 하네스가 바이트를 뱉는 것을 흉내낸다 — 프로덕션에서는 pty.ts 의 onData 가 부른다.
      opts.onData?.(raw);
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // 세션 스코프는 이 턴의 **앵커**와 같다 — (에이전트, 스레드)당 세션 하나(스펙 §5)를
    // 만드는 것이 그 등식이다. 여기서 `null` 인 이유는 이 파일의 다른 테스트와 같다:
    // 앵커 변환(`mentionAnchor`)은 `main.ts` 가 하고 `runMentionTurn` 은 받은 값을
    // 그대로 쓴다. 그 등식 자체는 아래 스레드 안 멘션 케이스가 확인한다.
    expect(r.opened).toEqual([{
      agentAccountId: ME.id, channelId: CHANNEL, threadRootId: null, harness: 'claude-code',
    }]);
    // 바이트가 **변형 없이** 그대로 온다 — 문자열로 뜨면 잘린 UTF-8 이 U+FFFD 가 된다.
    expect(r.bytes).toHaveLength(1);
    expect(r.bytes[0]!.equals(raw)).toBe(true);
    // 턴이 끝나면 세션도 닫힌다 — 안 닫으면 서버 목록에 끝난 턴이 영구히 남는다.
    expect(r.closedCount()).toBe(1);
  });

  it('스레드 안 멘션이면 세션 스코프가 그 스레드 루트다', async () => {
    // 위 테스트가 `null` 로 통과하는 것만으로는 "앵커를 그대로 쓴다"를 확인하지 못한다 —
    // 하드코딩된 null 도 초록이다. 앵커가 실제 값일 때 그 값이 세션에 실리는지를 본다.
    const root = 'thread-root';
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '루트', root);
    fake.seedFrom('human-1', '@forge 안녕', root);
    const r = fakeRelay();
    const { deps } = await makeDeps(fake, { relay: r.relay });

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: root, mentionId: MENTION });

    expect(r.opened.map((o) => o.threadRootId)).toEqual([root]);
  });

  it('턴이 실패해도 세션은 닫힌다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const r = fakeRelay();
    const { deps, runTurn } = await makeDeps(fake, { relay: r.relay });
    runTurn.script = async () => ({ exitCode: 1, timedOut: false, tail: 'boom' });

    await expect(
      runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }),
    ).rejects.toThrow(/harness 종료 1/);

    expect(r.closedCount()).toBe(1);
  });

  it('#141-7 릴레이가 붙어도 plan 이 그대로다 — 모드도 권한 프리셋도 바뀌지 않는다', async () => {
    // 같은 정의(mentionPermission: 'readonly')로 릴레이 없이 한 번, 릴레이를 붙여 한 번
    // 돌려 **조립된 plan 을 직접 비교**한다. "attach 해도 모드가 그대로다"를 화면이나
    // 로그로 갈음하면, 프리셋이 바뀌어도 초록인 테스트가 된다.
    const runOnce = async (relay?: ReturnType<typeof fakeRelay>['relay']) => {
      const fake = new FakeMurmur(defOf({ mentionPermission: 'readonly' }));
      fake.seedFrom('human-1', '@forge 안녕');
      const { deps, plans } = await makeDeps(fake, relay ? { relay } : {});
      await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
      return plans[0]!;
    };

    const without = await runOnce();
    const r = fakeRelay();
    const withRelay = await runOnce(r.relay);

    // 명령·인자가 한 글자도 다르지 않아야 한다 — 권한 프리셋은 전부 인자로 표현된다
    // (turn.ts::PRESETS: `--permission-mode` 등).
    //
    // 두 값만 정규화한다: 세션 UUID 와 임시 디렉터리 경로는 턴마다 새로 생기므로 비교가
    // 무조건 실패한다. **플래그 이름과 순서는 그대로 비교한다** — 정규화를 넓히면
    // `--permission-mode` 의 값까지 지워져 이 테스트가 아무것도 지키지 않게 된다.
    const normalize = (args: string[]) => args.map((a) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a) ? '<uuid>'
        : a.includes('mention-turn-state-') ? '<stateDir>/system-prompt.txt' : a);

    expect(withRelay.command).toBe(without.command);
    expect(normalize(withRelay.args)).toEqual(normalize(without.args));
    // 정규화가 프리셋 플래그를 삼키지 않았음을 직접 확인한다 — 'readonly' 프리셋의 증거다.
    expect(normalize(withRelay.args)).toContain('--permission-mode');
    expect(normalize(withRelay.args)[normalize(withRelay.args).indexOf('--permission-mode') + 1]).toBe('plan');
    // 세션은 실제로 열렸다 — 열리지도 않았는데 "그대로다"로 초록이 되면 안 된다.
    expect(r.opened).toHaveLength(1);
  });
});

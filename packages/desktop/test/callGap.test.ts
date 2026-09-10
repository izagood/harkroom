import { describe, it, expect } from 'vitest';
import type { AccountView, MessageRow } from '@murmur/shared';
import { callGap } from '../src/lib/callGap';
import type { RunnerState } from '../src/lib/runnerLauncher';

/**
 * 부름과 착수 사이의 침묵(`lib/callGap.ts`).
 *
 * 이 파일이 지키는 것은 **침묵이 기본값**이라는 것이다 — 다섯 관문 중 하나만 열려도 줄이
 * 서면 안 된다. 정상까지 줄을 받는 순간 진짜 조용한 부름의 줄이 나머지와 구별되지 않는다.
 */

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const QUIET = 30_000;

function account(over: Partial<AccountView> & Pick<AccountView, 'id' | 'handle' | 'kind'>): AccountView {
  return {
    displayName: over.handle, isAdmin: false, ownerAccountId: null, disabled: false,
    ...over,
  } as AccountView;
}

const HUMAN = account({ id: 'u1', handle: 'jaebin', kind: 'human' });
const AGENT = account({ id: 'a1', handle: 'murmur', kind: 'agent' });
const ACCOUNTS = { [HUMAN.id]: HUMAN, [AGENT.id]: AGENT };

function message(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'm1', seq: 10, channelId: 'c1', threadRootId: null, authorId: HUMAN.id,
    body: '@murmur 이거 좀 봐줘', kind: 'user', meta: {},
    createdAt: new Date(NOW - 60_000).toISOString(), editedAt: null,
    reactions: [], attachments: [], activityCount: 0, deletedAt: null,
    ...over,
  } as MessageRow;
}

function run(over: Partial<Parameters<typeof callGap>[0]> = {}) {
  return callGap({
    message: message(), accounts: ACCOUNTS, channelMessages: [], runnerStates: {},
    live: new Set([AGENT.id]), now: NOW, quietMs: QUIET,
    ...over,
  });
}

const restarting: RunnerState = { agentId: AGENT.id, status: 'restarting', exitCode: null, message: null };
const running: RunnerState = { agentId: AGENT.id, status: 'running', exitCode: null, message: null };

describe('callGap — 말을 거는 경우', () => {
  it('러너가 재기동 중이면 그 사실과 handle 을 돌려준다', () => {
    expect(run({ runnerStates: { [AGENT.id]: restarting } }))
      .toEqual({ handle: 'murmur', detail: 'restarting' });
  });

  it('러너 상태를 모르고 서버가 오프라인이라고 하면 offline 이다', () => {
    expect(run({ live: new Set() })).toEqual({ handle: 'murmur', detail: 'offline' });
  });

  it('러너 넷(failed·needs_*)은 한 갈래(attention)로 접힌다 — 문구가 갈리지 않는다', () => {
    for (const status of ['failed', 'needs_reissue', 'needs_harness', 'needs_login'] as const) {
      expect(run({ runnerStates: { [AGENT.id]: { ...restarting, status } } })?.detail)
        .toBe('attention');
    }
  });
});

describe('callGap — 침묵이 기본값이다', () => {
  it('러너가 돌고 있으면 아무 말도 하지 않는다', () => {
    expect(run({ runnerStates: { [AGENT.id]: running } })).toBeNull();
  });

  it('러너가 돈다고 알면 presence 로 되묻지 않는다 — 기동 직후 몇 초를 오프라인으로 읽지 않는다', () => {
    expect(run({ runnerStates: { [AGENT.id]: running }, live: new Set() })).toBeNull();
  });

  it('소켓이 끊겨 모르면(live=null) 오프라인이라고 단정하지 않는다', () => {
    expect(run({ live: null })).toBeNull();
  });

  it('아직 조용하지 않았으면 말하지 않는다', () => {
    expect(run({
      runnerStates: { [AGENT.id]: restarting },
      message: message({ createdAt: new Date(NOW - 5_000).toISOString() }),
    })).toBeNull();
  });

  it('그 에이전트가 뒤에 이미 말했으면 말하지 않는다', () => {
    expect(run({
      runnerStates: { [AGENT.id]: restarting },
      channelMessages: [message({ id: 'm2', seq: 11, authorId: AGENT.id, kind: 'progress' })],
    })).toBeNull();
  });

  it('앞선 발화(seq 가 작다)는 답이 아니다 — 그것으로 침묵이 깨지지 않는다', () => {
    expect(run({
      runnerStates: { [AGENT.id]: restarting },
      channelMessages: [message({ id: 'm0', seq: 9, authorId: AGENT.id, kind: 'progress' })],
    })?.detail).toBe('restarting');
  });

  it('스레드에 이미 뭔가 달렸으면(activityCount) 열어 보지 않아도 말하지 않는다', () => {
    expect(run({
      runnerStates: { [AGENT.id]: restarting },
      message: message({ activityCount: 3 }),
    })).toBeNull();
  });

  it('에이전트를 안 불렀으면 말하지 않는다', () => {
    expect(run({
      runnerStates: { [AGENT.id]: restarting },
      message: message({ body: '@jaebin 이거 봤어?' }),
    })).toBeNull();
  });

  it('인용 줄 안의 @handle 은 부름이 아니다 — 서버가 부르지 않는 것을 여기서도 안 센다', () => {
    expect(run({
      runnerStates: { [AGENT.id]: restarting },
      message: message({ body: '> @murmur 이거 좀 봐줘\n\n이 말 말이야' }),
    })).toBeNull();
  });

  it('사람의 말이 아니면(진행·대기) 부름이 아니다', () => {
    expect(run({
      runnerStates: { [AGENT.id]: restarting },
      message: message({ kind: 'progress' }),
    })).toBeNull();
  });
});

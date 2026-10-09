import { describe, expect, it } from 'vitest';
import { createRelayHub, type RelaySocket } from '../src/ws/relay.js';
import { visibleTo } from '../src/ws/wsPlugin.js';

/**
 * "사람 손이 필요하다"를 러너에서 받아 앱으로 넘기는 자리(2026-09-08).
 *
 * 허브를 직접 세운다 — 이 사실은 소켓 너머가 아니라 **허브의 세션 장부**에 산다:
 * 프레임은 세션 id 만 들고 오고, 채널·스레드는 허브가 알고 있어야 앱이 패널을 연다.
 */
function 세운다() {
  const 부름: unknown[] = [];
  const hub = createRelayHub({ onAttention: (ev) => { 부름.push(ev); } });
  const sent: string[] = [];
  const socket: RelaySocket = { send: (d) => sent.push(d), close: () => {} };
  hub.addRunner('agent-1', socket);
  return { hub, 부름, sent };
}

const 세션 = {
  sessionId: 's1', agentAccountId: 'agent-1', channelId: 'c1', threadRootId: 't1',
  harness: 'claude-code', startedAt: '2026-09-08T00:00:00.000Z',
};

describe('attention.required 중계', () => {
  it('세션의 채널·스레드를 붙여 넘긴다 — 세션 id 만으로는 패널을 못 연다', () => {
    const { hub, 부름 } = 세운다();
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'session.started', session: 세션 }));
    hub.onRunnerMessage('agent-1', JSON.stringify({
      type: 'attention.required', sessionId: 's1', accountLabel: 'aria',
      screen: Buffer.from('WARNING').toString('base64'),
    }));

    expect(부름).toEqual([{
      sessionId: 's1', channelId: 'c1', threadRootId: 't1',
      agentAccountId: 'agent-1', accountLabel: 'aria',
    }]);
  });

  it('모르는 세션이면 아무것도 넘기지 않는다 — 채널을 모르면 열 패널이 없다', () => {
    const { hub, 부름 } = 세운다();
    hub.onRunnerMessage('agent-1', JSON.stringify({
      type: 'attention.required', sessionId: '모르는세션', accountLabel: 'aria', screen: '',
    }));
    expect(부름).toHaveLength(0);
  });

  it('남의 세션 id 로는 못 부른다 — output 의 소유 검사와 같은 결이다', () => {
    // 러너 하나가 남의 세션 id 로 프레임을 보내 그 사람의 앱에 창을 띄우는 길을 막는다.
    const { hub, 부름 } = 세운다();
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'session.started', session: 세션 }));
    const 다른소켓: RelaySocket = { send: () => {}, close: () => {} };
    hub.addRunner('agent-2', 다른소켓);
    hub.onRunnerMessage('agent-2', JSON.stringify({
      type: 'attention.required', sessionId: 's1', accountLabel: 'aria', screen: '',
    }));
    expect(부름).toHaveLength(0);
  });

  it('화면 바이트를 열지 않는다 — 넘기는 것은 세션의 좌표뿐이다', () => {
    // 관문 화면에도 계정 이메일 같은 것이 실린다. `output` 과 같은 규율로, 서버는 이
    // 바이트를 이벤트에 담지 않는다 — 사람은 attach 해서 ring 재생으로 본다.
    const { hub, 부름 } = 세운다();
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'session.started', session: 세션 }));
    hub.onRunnerMessage('agent-1', JSON.stringify({
      type: 'attention.required', sessionId: 's1', accountLabel: 'aria',
      screen: Buffer.from('비밀이 섞인 화면').toString('base64'),
    }));
    expect(JSON.stringify(부름)).not.toContain('비밀');
    expect(JSON.stringify(부름)).not.toContain('screen');
  });

  it('콜백이 없어도 프레임을 조용히 넘긴다 — 구 배선이 죽지 않는다', () => {
    const hub = createRelayHub();
    hub.addRunner('agent-1', { send: () => {}, close: () => {} });
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'session.started', session: 세션 }));
    expect(() => hub.onRunnerMessage('agent-1', JSON.stringify({
      type: 'attention.required', sessionId: 's1', accountLabel: 'aria', screen: '',
    }))).not.toThrow();
  });
});

describe('관문 풀림 — 부른 세션이 끝나면 알린다 (2026-10-09)', () => {
  function 세운다2() {
    const 풀림: unknown[] = [];
    const hub = createRelayHub({ onAttentionCleared: (ev) => { 풀림.push(ev); } });
    hub.addRunner('agent-1', { send: () => {}, close: () => {} });
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'session.started', session: 세션 }));
    return { hub, 풀림 };
  }

  it('부른 적 있는 세션이 끝나면 좌표를 넘긴다 — 앱이 그 카드를 닫는다', () => {
    const { hub, 풀림 } = 세운다2();
    hub.onRunnerMessage('agent-1', JSON.stringify({
      type: 'attention.required', sessionId: 's1', accountLabel: 'aria', screen: '',
    }));
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'session.ended', sessionId: 's1' }));
    expect(풀림).toEqual([{ sessionId: 's1', channelId: 'c1', threadRootId: 't1', agentAccountId: 'agent-1' }]);
    // 두 번 끝나도 한 번만 — 러너가 session.ended 를 겹쳐 보내는 경로가 있다.
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'session.ended', sessionId: 's1' }));
    expect(풀림).toHaveLength(1);
  });

  it('부르지 않은 세션의 끝은 넘기지 않는다 — 턴 끝마다 소유자 소켓을 울리지 않는다', () => {
    const { hub, 풀림 } = 세운다2();
    hub.onRunnerMessage('agent-1', JSON.stringify({ type: 'session.ended', sessionId: 's1' }));
    expect(풀림).toHaveLength(0);
  });
});

describe('관문 이벤트의 수신자 (2026-10-09)', () => {
  const 부름 = {
    type: 'agent.attention' as const, sessionId: 's1', channelId: 'c1', threadRootId: 't1',
    agentAccountId: 'agent-1', agentHandle: 'aria', accountLabel: 'max', audience: ['owner-1'],
  };
  it('소유자에게만 간다 — 남의 앱에 배너가 뜨고 터미널이 열리면 안 된다', () => {
    expect(visibleTo(부름, 'owner-1')).toBe(true);
    expect(visibleTo(부름, 'someone-else')).toBe(false);
  });
  it('풀림도 같은 소유자에게만 간다', () => {
    const 풀림 = {
      type: 'agent.attention.cleared' as const, sessionId: 's1', channelId: 'c1', threadRootId: 't1',
      agentAccountId: 'agent-1', audience: ['owner-1'],
    };
    expect(visibleTo(풀림, 'owner-1')).toBe(true);
    expect(visibleTo(풀림, 'someone-else')).toBe(false);
  });
});

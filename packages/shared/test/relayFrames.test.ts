import { describe, expect, it } from 'vitest';
import type { RelayRunnerFrame, RunnerCap, WsServerEvent } from '../src/index.js';

/**
 * "사람 손이 필요하다"를 나르는 계약(2026-09-08). 이 사실은 러너에서 나서 서버를 거쳐
 * 데스크탑까지 가고, 층마다 모양이 다르다 — 그 세 모양이 서로 맞는지 여기서 고정한다.
 */
describe('attention 계약', () => {
  it('러너 프레임이 세션과 화면을 함께 싣는다', () => {
    const f: RelayRunnerFrame = {
      type: 'attention.required',
      sessionId: 's1',
      accountLabel: 'lime',
      screen: Buffer.from('WARNING: ...').toString('base64'),
    };
    expect(f.type).toBe('attention.required');
    // base64 규율(`output` 과 같다): 서버는 이 바이트를 열지 않는다. 관문 화면에도
    // 계정 이메일 같은 것이 실린다.
    expect(Buffer.from(f.screen, 'base64').toString('utf8')).toBe('WARNING: ...');
  });

  it("능력 문자열이 'attention' 이다 — 구 러너는 선언하지 않는다", () => {
    const cap: RunnerCap = 'attention';
    expect(cap).toBe('attention');
  });

  it('데스크탑 이벤트가 스레드를 가리킨다 — 세션 id 만으로는 패널을 못 연다', () => {
    const e: WsServerEvent = {
      type: 'agent.attention',
      sessionId: 's1',
      channelId: 'c1',
      threadRootId: 't1',
      agentHandle: 'murmur',
      accountLabel: 'lime',
    };
    expect(e.channelId).toBe('c1');
    expect(e.agentHandle).toBe('murmur');
  });

  it('채널 최상위 멘션은 threadRootId 가 null 이다', () => {
    // `AgentSessionView.threadRootId` 와 같은 규율. 여기가 string 이면 데스크탑이
    // 최상위 멘션의 세션을 못 그린다.
    const e: WsServerEvent = {
      type: 'agent.attention',
      sessionId: 's1',
      channelId: 'c1',
      threadRootId: null,
      agentHandle: 'murmur',
      accountLabel: '(기본)',
    };
    expect(e.threadRootId).toBeNull();
  });
});

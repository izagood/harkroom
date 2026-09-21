// 서버 ↔ 오퍼레이터 프레임(스펙 2026-09-20 §4)의 파서. 얕게 본다 — `type` 이 아는 것인지와
// 다중화 키(`runnerId`)가 필요한 프레임에 그것이 있는지. 본문의 깊은 검증은 받는 쪽의 일이다
// (릴레이 허브가 세션 프레임을 검증하듯). 모르는 타입은 null 로 버린다: 구·신 세대가 섞여도
// 한쪽이 죽지 않는다.
import { describe, it, expect } from 'vitest';
import { OPERATOR_PROTOCOL_VERSION } from '../src/operatorEndpoint.js';
import { parseOperatorFrame, parseServerFrame } from '../src/operatorProtocol.js';

describe('operatorProtocol', () => {
  it('프로토콜 버전은 1 이다', () => {
    expect(OPERATOR_PROTOCOL_VERSION).toBe(1);
  });
  it('hello 를 파싱한다', () => {
    const f = parseOperatorFrame(JSON.stringify({
      type: 'hello', protocol: 1, capabilities: { agentIds: ['a'], harnesses: {} }, runners: [], sessions: [],
    }));
    expect(f?.type).toBe('hello');
  });
  it('runnerId 가 필요한 프레임에 없으면 버린다', () => {
    expect(parseOperatorFrame(JSON.stringify({ type: 'runner.started', agentId: 'a' }))).toBeNull();
    expect(parseOperatorFrame(JSON.stringify({ type: 'runner.started', agentId: 'a', runnerId: 'r' }))?.type).toBe('runner.started');
  });
  it('모르는 타입·깨진 JSON 은 null', () => {
    expect(parseOperatorFrame(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseOperatorFrame('{not json')).toBeNull();
    expect(parseServerFrame(JSON.stringify({ type: 'nope' }))).toBeNull();
  });
  it('서버 프레임도 같은 규칙이다', () => {
    expect(parseServerFrame(JSON.stringify({ type: 'assign', agentId: 'a', definition: {} }))?.type).toBe('assign');
    expect(parseServerFrame(JSON.stringify({ type: 'pty.input', sessionId: 's', bytes: '' }))).toBeNull(); // runnerId 없음
    expect(parseServerFrame(JSON.stringify({ type: 'pty.input', runnerId: 'r', sessionId: 's', bytes: '' }))?.type).toBe('pty.input');
  });
});

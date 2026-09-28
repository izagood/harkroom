// 오퍼레이터의 배정 거절 사유가 에이전트에 붙어 화면까지 간다(실측 2026-09-21: 사유가 오퍼레이터
// 로그에만 남아 사람이 "왜 안 뜨나"를 볼 곳이 없었다). 러너가 뜨면 지워진다.
import { describe, it, expect } from 'vitest';
import { createOperatorHub } from '../src/ws/operatorHub.js';
import type { RelaySocket } from '../src/ws/relay.js';

const socket = () => ({ send: () => {}, close: () => {} }) as unknown as RelaySocket;

describe('OperatorHub.refusalOf', () => {
  it('reason·agentId 가 실린 runner.exited 를 기억하고, runner.started 가 오면 지운다', () => {
    const hub = createOperatorHub();
    hub.addOperator('op-1', socket());
    expect(hub.refusalOf('a-1')).toBeNull();
    hub.onOperatorMessage('op-1', JSON.stringify({ type: 'runner.exited', runnerId: 'x', code: null, reason: 'mcp_server_missing:ghost', agentId: 'a-1' }));
    expect(hub.refusalOf('a-1')).toMatchObject({ reason: 'mcp_server_missing:ghost' });
    hub.onOperatorMessage('op-1', JSON.stringify({ type: 'runner.started', runnerId: 'r-1', agentId: 'a-1' }));
    expect(hub.refusalOf('a-1')).toBeNull();
  });
  it('진짜 러너의 종료(reason 없음)는 사유가 아니다; hello 의 announce 도 지운다', () => {
    const hub = createOperatorHub();
    hub.addOperator('op-1', socket());
    hub.onOperatorMessage('op-1', JSON.stringify({ type: 'runner.exited', runnerId: 'r-1', code: 1, agentId: 'a-1' }));
    expect(hub.refusalOf('a-1')).toBeNull();
    hub.onOperatorMessage('op-1', JSON.stringify({ type: 'runner.exited', runnerId: 'x', code: null, reason: 'personal_on_foreign_operator', agentId: 'a-2' }));
    hub.onOperatorMessage('op-1', JSON.stringify({ type: 'hello', protocol: 1, capabilities: { agentIds: [], harnesses: {} }, runners: [{ agentId: 'a-2', runnerId: 'r-2', pid: 1 }], sessions: [] }));
    expect(hub.refusalOf('a-2')).toBeNull();
  });
});

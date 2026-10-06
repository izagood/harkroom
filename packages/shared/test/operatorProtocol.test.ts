// 서버 ↔ 오퍼레이터 프레임(스펙 2026-09-20 §4)의 파서. 얕게 본다 — `type` 이 아는 것인지와
// 다중화 키(`runnerId`)가 필요한 프레임에 그것이 있는지. 본문의 깊은 검증은 받는 쪽의 일이다
// (릴레이 허브가 세션 프레임을 검증하듯). 모르는 타입은 null 로 버린다: 구·신 세대가 섞여도
// 한쪽이 죽지 않는다.
import { describe, it, expect } from 'vitest';
import { OPERATOR_PROTOCOL_VERSION } from '../src/operatorEndpoint.js';
import { isMachineDigest, parseOperatorFrame, parseOperatorStatus, parseServerFrame, parseUpgradeProgress } from '../src/operatorProtocol.js';

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
  it('hello 의 version 은 그대로 싣고, 없으면 없다 — 옛 오퍼레이터는 버전을 모른다', () => {
    const base = { type: 'hello', protocol: 1, capabilities: { agentIds: [], harnesses: {} }, runners: [], sessions: [] };
    const withVersion = parseOperatorFrame(JSON.stringify({ ...base, version: '0.3.45' }));
    expect(withVersion?.type === 'hello' && withVersion.version).toBe('0.3.45');
    const old = parseOperatorFrame(JSON.stringify(base));
    expect(old?.type === 'hello' && 'version' in old).toBe(false);
  });
  it('hello 의 version 이 틀린 모양이면 hello 는 살리고 버전만 뗀다', () => {
    const base = { type: 'hello', protocol: 1, capabilities: { agentIds: [], harnesses: {} }, runners: [], sessions: [] };
    for (const version of ['', 42, null, 'x'.repeat(65)]) {
      const f = parseOperatorFrame(JSON.stringify({ ...base, version }));
      expect(f?.type).toBe('hello');
      expect(f && 'version' in f).toBe(false);
    }
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

describe('박동(status) — 원격 호스트 관리 P2a', () => {
  it('status 프레임은 runnerId 없이 받는다', () => {
    expect(parseOperatorFrame(JSON.stringify({ type: 'status', status: { turns: { running: 0 } } }))).toMatchObject({ type: 'status' });
  });

  it('허용한 칸만 남긴다 — 모르는 키·자격 증명의 값과 만료 시각은 버린다', () => {
    const out = parseOperatorStatus({
      turns: { running: 3, max: 16 }, token: 'x',
      memory: { totalBytes: 100, freeBytes: 40, turnRssBytes: 20, path: '/home' },
      disk: { totalBytes: 10, freeBytes: 20 },
      runners: [{ agentId: 'a', turns: 2, cwd: '/w' }, { agentId: '', turns: 1 }],
      credentials: [
        { kind: 'claude', name: 'acct-1', state: 'present', agentIds: ['a'], value: 'sk-…', expiresAt: 'soon' },
        { kind: 'ssh', name: 'k', state: 'present' },
        { kind: 'gh', name: 'izagood', state: 'leaked' },
      ],
    });
    expect(out).toEqual({
      turns: { running: 3, max: 16 },
      memory: { totalBytes: 100, freeBytes: 40, turnRssBytes: 20 },
      runners: [{ agentId: 'a', turns: 2 }],
      credentials: [{ kind: 'claude', name: 'acct-1', state: 'present', agentIds: ['a'] }],
    });
  });

  it('turns.running 이 없거나 틀리면 박동 전체를 버린다. 상한 0 은 상한 없음', () => {
    expect(parseOperatorStatus({ turns: {} })).toBeNull();
    expect(parseOperatorStatus({ turns: { running: -1 } })).toBeNull();
    expect(parseOperatorStatus('x')).toBeNull();
    expect(parseOperatorStatus({ turns: { running: 0, max: 0 } })).toEqual({ turns: { running: 0, max: null } });
  });

  it('머신 값은 sha256 hex 64자만', () => {
    expect(isMachineDigest('a'.repeat(64))).toBe(true);
    expect(isMachineDigest('A'.repeat(64))).toBe(false);
    expect(isMachineDigest('3f2a9c0d4e5b6a7f8091a2b3c4d5e6f7')).toBe(false);
  });
});

describe('업그레이드 단계 — P2b', () => {
  it('upgrade.progress 는 runnerId 없이 받고, 단계는 enum 만', () => {
    expect(parseOperatorFrame(JSON.stringify({ type: 'upgrade.progress', stage: 'verify' }))).toMatchObject({ type: 'upgrade.progress' });
    expect(parseUpgradeProgress({ stage: 'verify', from: '0.3.1', to: '' })).toEqual({ stage: 'verify', from: '0.3.1', to: null, error: null });
    expect(parseUpgradeProgress({ stage: 'rm -rf' })).toBeNull();
  });
  it('사유는 제어 문자를 걷고 300자에서 자른다', () => {
    const r = parseUpgradeProgress({ stage: 'failed', error: `bad\n\tsig ${'x'.repeat(400)}` });
    expect(r?.error?.startsWith('bad sig ')).toBe(true);
    expect(r?.error).toHaveLength(300);
  });
  it('박동의 platform 은 알려진 값만', () => {
    expect(parseOperatorStatus({ turns: { running: 0 }, platform: 'linux' })?.platform).toBe('linux');
    expect(parseOperatorStatus({ turns: { running: 0 }, platform: 'plan9' })?.platform).toBeUndefined();
  });
});

describe('자격 증명 이름 — security #1200 n3', () => {
  it('서버 이름·계정 핸들 꼴만 받는다 — 대문자·긴 난수 같은 토큰 조각은 그 항목을 버린다', () => {
    const out = parseOperatorStatus({ turns: { running: 0 }, credentials: [
      { kind: 'mcp', name: 'slack', state: 'present' },
      { kind: 'claude', name: 'sk-ant-oat01-AbCdEf', state: 'present' },
      { kind: 'gh', name: 'x'.repeat(49), state: 'present' },
    ] });
    expect(out?.credentials?.map((c) => c.name)).toEqual(['slack']);
  });
});

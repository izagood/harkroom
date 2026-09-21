import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

/** 오퍼레이터가 spawn 때 심는 넷(스펙 2026-09-20 §5). 이것 없이는 러너가 뜨지 않는다. */
const LINK_ENV = {
  HARKROOM_OPERATOR_SOCKET: '/tmp/op.sock', HARKROOM_RUNNER_ID: 'r-1', HARKROOM_RUNNER_SECRET: 's',
  HARKROOM_OPERATOR_BIN: '/opt/harkroom/harkroom-operator',
  HARKROOM_MCP_CONFIG: '/tmp/mcp/a-1.json',
};

describe('loadConfig — HARKROOM_AGENT_INSTANCE (#174)', () => {
  /**
   * 요구 1 — 인스턴스가 없으면 **지금과 완전히 같다.** `stateDir` 기본값까지 리터럴로
   * 확인한다: `toBeDefined()` 는 값이 무엇으로 바뀌어도 통과해 아무것도 지키지 않는다.
   */
  it('HARKROOM_AGENT_INSTANCE 가 없으면 인스턴스는 undefined 이고 stateDir 기본값이 그대로다', () => {
    const config = loadConfig({ ...LINK_ENV });
    expect(config.agentInstance).toBeUndefined();
    // **둘 중 하나다** — 개명(`~/.murmur-agent` → `~/.harkroom-agent`) 뒤로 이 값은
    // 기계에 무엇이 있느냐로 갈린다(`pickRenamedDir`). 어느 쪽이 나올지는 이 테스트가
    // 정할 수 없으므로 **고르는 규칙 자체는 `shared/test/renamedDir.test.ts` 가 재고**,
    // 여기서는 "홈 아래 그 둘 중 하나"까지만 고정한다.
    expect([join(homedir(), '.harkroom-agent'), join(homedir(), '.murmur-agent')])
      .toContain(config.stateDir);
  });

  /**
   * 빈 문자열은 **없는 것으로 본다.** 셸에서 `HARKROOM_AGENT_INSTANCE=` 를 남기는 것은
   * 값을 준 것이 아니라 지운 것이고, 이때 기동을 막으면 기존 배포 스크립트가 깨진다.
   * 오타(문자 집합 위반)와는 다른 경우다 — 아래가 그쪽을 지킨다.
   */
  it('빈 문자열은 없는 것으로 본다', () => {
    expect(loadConfig({ ...LINK_ENV, HARKROOM_AGENT_INSTANCE: '' }).agentInstance)
      .toBeUndefined();
  });

  it('소문자·숫자·하이픈 1~32자는 그대로 통과한다', () => {
    const env = { ...LINK_ENV };
    expect(loadConfig({ ...env, HARKROOM_AGENT_INSTANCE: 'a' }).agentInstance).toBe('a');
    expect(loadConfig({ ...env, HARKROOM_AGENT_INSTANCE: 'instance-a1' }).agentInstance).toBe('instance-a1');
    expect(loadConfig({ ...env, HARKROOM_AGENT_INSTANCE: 'a'.repeat(32) }).agentInstance).toBe('a'.repeat(32));
  });

  /**
   * 요구 3 — 문자 집합 위반은 **기동 실패**다. 조용히 무시하면 인스턴스 B 라고 믿고 띄운
   * 러너가 기본 경로에서 A 의 세션 파일을 밟는다.
   *
   * 경로를 벗어나려는 값(`..`, `/`)을 함께 확인한다 — 이 값은 경로 세그먼트가 되므로
   * 문법이 그 문을 닫는 유일한 자리다.
   */
  it.each([
    ['대문자', 'InstanceA'],
    ['밑줄', 'Invalid_Instance'],
    ['특수문자', 'instance@1'],
    ['33자', 'a'.repeat(33)],
    ['상위 디렉터리', '..'],
    ['경로 구분자', 'a/b'],
    ['공백', 'a b'],
  ])('%s 는 기동 실패다', (_name, value) => {
    expect(() => loadConfig({ ...LINK_ENV, HARKROOM_AGENT_INSTANCE: value }))
      .toThrow(/HARKROOM_AGENT_INSTANCE 가 유효하지 않다/);
  });

  /** 메시지에 **받은 값과 허용 문법**이 함께 있어야 운영자가 무엇을 고칠지 안다. */
  it('실패 메시지가 받은 값과 허용 문법을 함께 말한다', () => {
    expect(() => loadConfig({ ...LINK_ENV, HARKROOM_AGENT_INSTANCE: 'Bad' }))
      .toThrow(/"Bad"[\s\S]*\[a-z0-9-\]\{1,32\}/);
  });
});

describe('loadConfig — 오퍼레이터 링크 (스펙 2026-09-20 §5)', () => {
  it('넷이 다 있으면 링크와 오퍼레이터 실행 파일이 선다', () => {
    const c = loadConfig({ ...LINK_ENV });
    expect(c.operatorLink).toEqual({ socketPath: '/tmp/op.sock', runnerId: 'r-1', secret: 's' });
    expect(c.operatorBin).toBe('/opt/harkroom/harkroom-operator');
  });
  it('링크 셋 중 하나라도 없으면 기동 실패다 — 러너는 서버를 모르므로 링크 없이는 아무것도 못 한다', () => {
    expect(() => loadConfig({ ...LINK_ENV, HARKROOM_RUNNER_SECRET: '' })).toThrow(/HARKROOM_RUNNER_SECRET/);
    expect(() => loadConfig({ HARKROOM_PAT: 'murp_test' })).toThrow(/오퍼레이터/);
  });
  it('오퍼레이터 실행 파일이 없어도 기동 실패다 — 하네스가 harkroom MCP 에 닿을 길이 없다', () => {
    expect(() => loadConfig({ ...LINK_ENV, HARKROOM_OPERATOR_BIN: '' })).toThrow(/HARKROOM_OPERATOR_BIN/);
    // MCP 설정은 오퍼레이터가 쓴다(스펙 §6) — 러너는 경로만 받고, 없으면 만들지 않고 죽는다.
    expect(() => loadConfig({ ...LINK_ENV, HARKROOM_MCP_CONFIG: '' })).toThrow(/HARKROOM_MCP_CONFIG/);
    expect(loadConfig(LINK_ENV).mcpConfigPath).toBe('/tmp/mcp/a-1.json');
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig (#174 instance validation)', () => {
  // 회귀 테스트 1: MURMUR_AGENT_INSTANCE 가 없으면 stateDir 가 기존과 같다
  it('MURMUR_AGENT_INSTANCE 가 없으면 stateDir 가 기존과 같다', () => {
    const config = loadConfig({ MURMUR_PAT: 'murp_test' });
    expect(config.stateDir).toBeDefined();
    expect(config.agentInstance).toBeUndefined();
  });

  // 회귀 테스트 3: 문자 집합 위반은 기동 실패
  it('문자 집합 위반은 기동 실패', () => {
    expect(() =>
      loadConfig({ MURMUR_PAT: 'murp_test', MURMUR_AGENT_INSTANCE: 'Invalid_Instance' })
    ).toThrow(/MURMUR_AGENT_INSTANCE 가 유효하지 않다/);
  });

  it('대문자 포함은 기동 실패', () => {
    expect(() =>
      loadConfig({ MURMUR_PAT: 'murp_test', MURMUR_AGENT_INSTANCE: 'InstanceA' })
    ).toThrow(/MURMUR_AGENT_INSTANCE 가 유효하지 않다/);
  });

  it('특수문자 포함은 기동 실패', () => {
    expect(() =>
      loadConfig({ MURMUR_PAT: 'murp_test', MURMUR_AGENT_INSTANCE: 'instance@1' })
    ).toThrow(/MURMUR_AGENT_INSTANCE 가 유효하지 않다/);
  });

  it('33자 이상은 기동 실패', () => {
    expect(() =>
      loadConfig({ MURMUR_PAT: 'murp_test', MURMUR_AGENT_INSTANCE: 'a'.repeat(33) })
    ).toThrow(/MURMUR_AGENT_INSTANCE 가 유효하지 않다/);
  });

  // 유효한 인스턴스
  it('소문자·숫자·하이픈만 있으면 유효', () => {
    const config = loadConfig({
      MURMUR_PAT: 'murp_test',
      MURMUR_AGENT_INSTANCE: 'instance-a1',
    });
    expect(config.agentInstance).toBe('instance-a1');
  });

  it('1자도 유효', () => {
    const config = loadConfig({ MURMUR_PAT: 'murp_test', MURMUR_AGENT_INSTANCE: 'a' });
    expect(config.agentInstance).toBe('a');
  });

  it('32자도 유효', () => {
    const config = loadConfig({
      MURMUR_PAT: 'murp_test',
      MURMUR_AGENT_INSTANCE: 'a'.repeat(32),
    });
    expect(config.agentInstance).toBe('a'.repeat(32));
  });
});
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentStateBaseDir, RESERVED_STATE_DIR_NAMES } from '@harkroom/shared/agentStateRoot';
import { NAME_LINK_DIR, resolveAgentStateDir } from '../src/stateDir.js';
import { loadConfig } from '../src/config.js';

const DEF = '/Users/alice/.harkroom-agent';
const ROOT = '/Users/alice/.harkroom-agent/c/abcd1234';

describe('작업 폴더 뿌리(격리 C P4)', () => {
  it('스위치가 꺼져 있으면 지금 자리 그대로', () => {
    expect(agentStateBaseDir(DEF, {})).toBe(DEF);
    expect(agentStateBaseDir(DEF, { HARKROOM_OPERATOR_PER_COMMUNITY: '0', HARKROOM_OPERATOR_ROOT: ROOT })).toBe(DEF);
  });

  it('켜져 있으면 새 커뮤니티는 <커뮤니티 뿌리>/agents', () => {
    expect(agentStateBaseDir(DEF, { HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: ROOT })).toBe(join(ROOT, 'agents'));
    expect(agentStateBaseDir(DEF, { HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: `${ROOT}/` })).toBe(join(ROOT, 'agents'));
  });

  it('옛 자리 커뮤니티(D5)는 켜져 있어도 옛 경로를 그대로 쓴다 — 옮기지 않는다', () => {
    expect(agentStateBaseDir(DEF, { HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: ROOT, HARKROOM_OPERATOR_LEGACY: '1' })).toBe(DEF);
  });

  it('켜져 있는데 뿌리를 모르면 기계 자리로 물러서지 않고 던진다', () => {
    expect(() => agentStateBaseDir(DEF, { HARKROOM_OPERATOR_PER_COMMUNITY: '1' })).toThrow(/HARKROOM_OPERATOR_ROOT/);
    expect(() => agentStateBaseDir(DEF, { HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: 'rel/path' })).toThrow();
  });

  it('러너 설정의 stateDir 이 이 규칙을 따르고, AGENT_STATE_DIR 를 직접 주면 그것이 이긴다', () => {
    const base = {
      HARKROOM_OPERATOR_SOCKET: '/tmp/op.sock', HARKROOM_RUNNER_ID: 'r-1', HARKROOM_RUNNER_SECRET: 's',
      HARKROOM_OPERATOR_BIN: '/opt/harkroom/harkroom-operator', HARKROOM_MCP_CONFIG: '/tmp/mcp/a-1.json',
    };
    const on = { ...base, HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: ROOT };
    expect(loadConfig(on as NodeJS.ProcessEnv).stateDir).toBe(join(ROOT, 'agents'));
    expect(loadConfig({ ...on, AGENT_STATE_DIR: '/tmp/x' } as NodeJS.ProcessEnv).stateDir).toBe('/tmp/x');
  });
});

describe('상태 뿌리의 예약 이름(security #1641 n1)', () => {
  it('커뮤니티 뿌리 c/ 와 이름 링크 by-name/ 이 예약돼 있다', () => {
    expect(RESERVED_STATE_DIR_NAMES).toEqual(expect.arrayContaining(['c', NAME_LINK_DIR]));
    expect(agentStateBaseDir(DEF, { HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: ROOT }).startsWith(join(DEF, 'c'))).toBe(true);
  });

  it('에이전트 디렉터리를 고를 때 예약 이름은 건너뛴다', () => {
    // `by-name` 은 `-name` 으로 끝난다 — 예약 이름을 건너뛰지 않으면 id 가 `name` 인 에이전트가 링크 디렉터리를 집는다.
    const p = resolveAgentStateDir(DEF, 'alice', 'name', undefined, ['c', 'by-name']);
    expect(p.agentStateDir).toBe(join(DEF, 'name'));
    const q = resolveAgentStateDir(DEF, 'alice', 'agent-1', undefined, ['c', 'by-name', 'agent-1']);
    expect(q.agentStateDir).toBe(join(DEF, 'agent-1'));
  });
});

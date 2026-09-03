import { describe, expect, it } from 'vitest';
import { resolveAgentStateDir } from '../src/stateDir.js';

describe('resolveAgentStateDir (#167)', () => {
  // 이 이슈의 핵심 회귀선. handle 만으로 나누면 서로 다른 서버의 같은 handle 이 같은
  // 디렉터리를 써서 sessions.json 이 섞이고, 섞인 뒤에는 풀 수 없다.
  it('같은 handle 이라도 계정 id 가 다르면 디렉터리가 다르다', () => {
    const a = resolveAgentStateDir('/state', 'forge', 'acct-1');
    const b = resolveAgentStateDir('/state', 'forge', 'acct-2');
    expect(a.agentStateDir).not.toBe(b.agentStateDir);
  });

  // **URL 무관함은 시그니처가 보장한다** — 이 함수는 URL 을 받지 않는다. 그래서 같은
  // 서버를 localhost 로 붙든 LAN IP 로 붙든 계정 id 가 같아 디렉터리가 같다.
  // 테스트로 표현할 수 있는 것은 "같은 (handle, id) 면 같은 경로"뿐이다 — 앞선 초안은
  // 이것을 "URL 이 달라도 같다"로 이름 붙였는데, URL 이 인자에 없으니 그 테스트는
  // f(a,b,c) === f(a,b,c) 라는 동어반복이었다.
  it('같은 handle·id 면 항상 같은 경로다', () => {
    const a = resolveAgentStateDir('/state', 'forge', 'acct-1');
    const b = resolveAgentStateDir('/state', 'forge', 'acct-1');
    expect(a.agentStateDir).toBe(b.agentStateDir);
  });

  it('baseDir 가 다르면 경로가 다르다', () => {
    const a = resolveAgentStateDir('/state-a', 'forge', 'acct-1');
    const b = resolveAgentStateDir('/state-b', 'forge', 'acct-1');
    expect(a.agentStateDir).not.toBe(b.agentStateDir);
  });

  // handle 은 격리에 필요하지 않다 — 사람이 디렉터리를 보고 알아볼 수 있게 하려고 넣는다.
  it('handle 이 경로에 사람이 읽을 수 있는 형태로 들어간다', () => {
    const { agentStateDir } = resolveAgentStateDir('/state', 'my-handle', 'acct-1');
    expect(agentStateDir).toContain('my-handle');
    expect(agentStateDir).toContain('acct-1');
  });

  // legacyPath 는 서버별로 갈리기 **전** 경로다. 호출자가 존재를 확인해 운영자에게
  // 안내한다 — 자동으로 옮기지 않는다.
  it('legacyPath 는 handle 만으로 만든 예전 경로다', () => {
    const { legacyPath, agentStateDir } = resolveAgentStateDir('/state', 'forge', 'acct-1');
    expect(legacyPath).toBe('/state/forge');
    expect(legacyPath).not.toBe(agentStateDir);
  });
});

describe('resolveAgentStateDir (#174 instance)', () => {
  /**
   * 요구 1 — **하위 호환.** 지금 돌고 있는 러너가 재시작에 상태를 잃으면 안 되므로
   * 인스턴스가 없을 때의 경로는 `#167` 이 만든 것과 **문자 그대로** 같아야 한다.
   * 그래서 리터럴로 적는다: `resolveAgentStateDir` 를 다시 불러 비교하면 규칙이 바뀌어도
   * 양쪽이 함께 바뀌어 통과한다.
   */
  it('instance 가 없으면 경로 넷 전부가 #167 의 경로와 문자 그대로 같다', () => {
    const paths = resolveAgentStateDir('/state', 'forge', 'acct-1');
    expect(paths.agentStateDir).toBe('/state/forge-acct-1');
    expect(paths.sessionsPath).toBe('/state/forge-acct-1/sessions.json');
    expect(paths.mcpDir).toBe('/state/forge-acct-1/mcp');
    expect(paths.workspaceBaseDir).toBe('/state/forge-acct-1/workspaces');
  });

  it('undefined 를 명시적으로 넘긴 것과 생략한 것이 같다', () => {
    const without = resolveAgentStateDir('/state', 'forge', 'acct-1');
    const explicit = resolveAgentStateDir('/state', 'forge', 'acct-1', undefined);
    expect(explicit).toEqual(without);
  });

  /** 요구 2 — 인스턴스는 **마지막 세그먼트**다. 리터럴로 적는다(같은 이유). */
  it('instance 가 있으면 경로 마지막에 붙는다', () => {
    const { agentStateDir } = resolveAgentStateDir('/state', 'forge', 'acct-1', 'instance-a');
    expect(agentStateDir).toBe('/state/forge-acct-1/instance-a');
  });

  /**
   * 요구 4 — **세션 파일·MCP 설정·avcs 워크스페이스 셋 다** 인스턴스 아래여야 한다.
   *
   * 하나만 옛 경로에 남으면 그 파일을 두 인스턴스가 밟고, 격리는 없는 것과 같아진다.
   * 그래서 셋을 **각각** 단언한다 — 뿌리 하나만 보는 단언은 뿌리가 맞아도 그 아래를
   * 안 쓰는 구현을 통과시킨다(개수·존재만 보는 회귀선의 전형).
   */
  it('세션 파일·MCP 설정·avcs 워크스페이스 셋 다 인스턴스 경로 아래다', () => {
    const p = resolveAgentStateDir('/state', 'forge', 'acct-1', 'a');
    expect(p.agentStateDir).toBe('/state/forge-acct-1/a');
    expect(p.sessionsPath).toBe('/state/forge-acct-1/a/sessions.json');
    expect(p.mcpDir).toBe('/state/forge-acct-1/a/mcp');
    expect(p.workspaceBaseDir).toBe('/state/forge-acct-1/a/workspaces');
  });

  /**
   * 요구 2·4 — 두 인스턴스가 **어느 것도** 공유하지 않는다.
   *
   * 뿌리만 비교하면 부족하다: 뿌리는 갈렸는데 세션 파일만 옛 뿌리에 두는 구현이 통과한다.
   * 그래서 네 경로를 짝지어 전부 다름을 단언한다.
   */
  it('두 인스턴스는 뿌리·세션·MCP·워크스페이스 어느 것도 공유하지 않는다', () => {
    const a = resolveAgentStateDir('/state', 'forge', 'acct-1', 'a');
    const b = resolveAgentStateDir('/state', 'forge', 'acct-1', 'b');
    for (const key of ['agentStateDir', 'sessionsPath', 'mcpDir', 'workspaceBaseDir'] as const) {
      expect(a[key], key).not.toBe(b[key]);
    }
  });

  /** 인스턴스를 준 러너와 안 준 러너도 서로를 밟지 않는다(같은 계정으로 섞어 띄우는 경우). */
  it('인스턴스를 준 러너와 안 준 러너의 경로도 전부 다르다', () => {
    const base = resolveAgentStateDir('/state', 'forge', 'acct-1');
    const inst = resolveAgentStateDir('/state', 'forge', 'acct-1', 'a');
    for (const key of ['agentStateDir', 'sessionsPath', 'mcpDir', 'workspaceBaseDir'] as const) {
      expect(base[key], key).not.toBe(inst[key]);
    }
  });

  /** `legacyPath` 는 인스턴스와 무관하다 — 그 경로가 있던 시절에는 인스턴스가 없었다. */
  it('legacyPath 는 인스턴스에 영향받지 않는다', () => {
    expect(resolveAgentStateDir('/state', 'forge', 'acct-1', 'a').legacyPath).toBe('/state/forge');
  });
});

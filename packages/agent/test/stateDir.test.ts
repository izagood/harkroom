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

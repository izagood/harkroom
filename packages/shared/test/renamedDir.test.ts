/**
 * 이름이 바뀐 **디렉터리**를 고르는 규칙의 회귀선(`~/.murmur-agent` → `~/.harkroom-agent`).
 *
 * 이 디렉터리에는 claude 계정 자격증명과 에이전트 메모리가 산다. **코드가 옮기지 않는다** —
 * 옮기다 만 상태를 사람이 나중에 발견하게 되기 때문이다. 코드는 **있는 것을 쓴다.**
 *
 * **되돌려 RED**: `pickRenamedDir` 의 두 번째 줄을 `return next` 로 바꾸면 "새 경로가 없고
 * 옛 경로가 있으면 옛 경로"가 빨개진다 — 그 순간 아직 안 옮긴 사람의 러너가 **빈 상태로
 * 처음 켠 것처럼** 뜬다.
 */
import { describe, it, expect } from 'vitest';
import { pickRenamedDir } from '../src/index.js';

const only = (...present: string[]) => (p: string) => present.includes(p);

describe('pickRenamedDir', () => {
  it('새 경로가 있으면 새 경로 — 사람이 이미 옮겼다', () => {
    expect(pickRenamedDir('/h/.harkroom-agent', '/h/.murmur-agent', only('/h/.harkroom-agent')))
      .toBe('/h/.harkroom-agent');
  });

  it('새 경로가 없고 옛 경로가 있으면 옛 경로 — 아직 안 옮겼어도 돌아야 한다', () => {
    expect(pickRenamedDir('/h/.harkroom-agent', '/h/.murmur-agent', only('/h/.murmur-agent')))
      .toBe('/h/.murmur-agent');
  });

  it('둘 다 있으면 새 경로가 이긴다', () => {
    expect(pickRenamedDir('/h/.harkroom-agent', '/h/.murmur-agent',
      only('/h/.harkroom-agent', '/h/.murmur-agent'))).toBe('/h/.harkroom-agent');
  });

  // 첫 기동이다. 옛 이름으로 새로 만들면 개명이 영영 안 끝난다.
  it('둘 다 없으면 새 경로 — 첫 기동은 새 이름으로 만든다', () => {
    expect(pickRenamedDir('/h/.harkroom-agent', '/h/.murmur-agent', only()))
      .toBe('/h/.harkroom-agent');
  });
});

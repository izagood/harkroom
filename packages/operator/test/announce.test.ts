// hello 의 announce — 서버가 "이 오퍼레이터에 어떤 러너가 살아 있나"를 아는 유일한 표.
// 회수 중인(SIGTERM 을 받고 턴을 끝내는) 옛 세대 러너도 실린다(#838) — 그래야 서버가 그
// 러너의 프레임을 버리지 않고, 진행 중이던 턴이 새 오퍼레이터를 통해 끝난다.
import { describe, it, expect } from 'vitest';
import type { IncarnationId } from '@harkroom/shared/daemonProtocol';
import { announceOf } from '../src/communities.js';

describe('announceOf', () => {
  it('살아 있는 러너와 회수 중인 러너를 함께 싣고, 죽은 것은 뺀다', () => {
    const inc = (s: string) => s as IncarnationId;
    const out = announceOf({
      listRunners: () => [
        { agentId: 'a1', pid: 10, incarnationId: inc('i1'), startedAtMs: 0, alive: true, termSentAtMs: null, adopted: false },
        { agentId: 'a2', pid: 11, incarnationId: inc('i2'), startedAtMs: 0, alive: false, termSentAtMs: null, adopted: false },
      ],
      retiringRunners: () => [{ agentId: 'a3', pid: 12, incarnationId: inc('i3') }],
    });
    expect(out).toEqual([
      { agentId: 'a1', runnerId: 'i1', pid: 10 },
      { agentId: 'a3', runnerId: 'i3', pid: 12 },
    ]);
  });
});

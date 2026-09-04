// #337 — "이 스레드에 지금 어떤 턴이 돌고 있는가"의 유일한 진실 원천.
//
// 인터랙티브 open(3분기: 멘션 턴에 합류 / 기존 인터랙티브 반환 / 새로 연다)과 멘션 유예
// (조종 중인 스레드의 멘션은 건너뛴다)가 전부 이 조회 하나에 걸린다 — 두 소비자가 각자
// 상태를 들면 "멘션 턴이 도는데 인터랙티브도 떴다"는 겹침이 생기고, 같은 세션에 PTY 가
// 둘 뜨는 것이 정확히 스펙 §1 이 금지한 모양이다.
import { describe, expect, it } from 'vitest';
import { TurnRegistry } from '../src/turnRegistry.js';

describe('#337 TurnRegistry', () => {
  it('등록한 턴을 threadKey 로 찾는다', () => {
    const reg = new TurnRegistry();
    reg.register('c1/m1', { kind: 'mention', sessionId: 'sess-1' });
    expect(reg.get('c1/m1')).toEqual({ kind: 'mention', sessionId: 'sess-1' });
    expect(reg.get('c1/other')).toBeUndefined();
  });

  it('해제하면 사라진다 — 턴의 finally 가 부르는 경로', () => {
    const reg = new TurnRegistry();
    reg.register('c1/m1', { kind: 'interactive', sessionId: 's', openedByHandle: 'jaebin' });
    reg.release('c1/m1');
    expect(reg.get('c1/m1')).toBeUndefined();
  });

  it('같은 스레드에 두 번 등록하면 크게 던진다 — 겹친 턴은 호출자 결함이다', () => {
    // 조용히 덮어쓰면 첫 턴의 finally 가 둘째 턴의 등록을 지워, 둘째 턴이 도는 동안
    // 레지스트리는 "아무 턴도 없다"고 말한다 — 유예가 풀려 같은 세션에 PTY 가 둘 뜬다.
    const reg = new TurnRegistry();
    reg.register('c1/m1', { kind: 'mention', sessionId: null });
    expect(() => reg.register('c1/m1', { kind: 'interactive', sessionId: 's' })).toThrow(/이미/);
  });

  it('릴레이 없는 멘션 턴은 sessionId null 로 등록된다', () => {
    // 관찰(릴레이)이 없어도 턴의 존재 자체는 등록돼야 한다 — 유예 판정은 세션이 아니라
    // 턴의 존재를 본다.
    const reg = new TurnRegistry();
    reg.register('c1/m1', { kind: 'mention', sessionId: null });
    expect(reg.get('c1/m1')?.sessionId).toBeNull();
  });

  it('인터랙티브 턴 전부를 순회할 수 있다 — 러너 SIGTERM 회수 경로', () => {
    const reg = new TurnRegistry();
    reg.register('c1/m1', { kind: 'mention', sessionId: 'a' });
    reg.register('c1/m2', { kind: 'interactive', sessionId: 'b', openedByHandle: 'jaebin' });
    reg.register('c2/m3', { kind: 'interactive', sessionId: 'c', openedByHandle: 'jaebin' });
    expect([...reg.keysOf('interactive')].sort()).toEqual(['c1/m2', 'c2/m3']);
  });
});

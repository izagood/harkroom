import { describe, expect, it } from 'vitest';
import { applySelfRename, type Me } from '../src/harkroom.js';

/**
 * #847 — 러너가 **자기 이름이 바뀐 것**을 알아챈다.
 *
 * 에이전트 이름은 바뀌는데(#843) `me` 는 기동 때 한 번 읽고 끝이었다. 판정은 전부
 * `me.id` 라 동작은 안 깨진다 — 틀리는 것은 **말**이다: 프롬프트의 *"너는 … 에이전트
 * @<이름>"*, PR 꼬리표, 로그. 사람은 이미 새 이름으로 부르는데 에이전트만 옛 이름으로
 * 말하고, 그 상태가 러너를 다시 띄울 때까지 이어진다.
 */
const meOf = (handle: string): Me => ({ id: 'acct-1', handle });

describe('applySelfRename (#847)', () => {
  it('바뀌었으면 고치고 옛 이름을 돌려준다', () => {
    const me = meOf('forge');
    expect(applySelfRename(me, [{ id: 'acct-1', handle: 'anvil' }])).toBe('forge');
    expect(me.handle).toBe('anvil');
  });

  /** 안 바뀐 배치마다 로그를 남기면 그 로그는 아무것도 말하지 않는 소음이 된다. */
  it('그대로면 null 이고 아무것도 고치지 않는다', () => {
    const me = meOf('forge');
    expect(applySelfRename(me, [{ id: 'acct-1', handle: 'forge' }])).toBeNull();
    expect(me.handle).toBe('forge');
  });

  /**
   * 목록에 내가 없는 것은 "이름이 지워졌다"가 아니라 대개 목록이 덜 왔다는 뜻이다.
   * 그때 이름을 비우면 프롬프트가 이름 없는 에이전트를 만든다.
   */
  it('목록에 내가 없으면 손대지 않는다', () => {
    const me = meOf('forge');
    expect(applySelfRename(me, [{ id: 'acct-2', handle: 'other' }])).toBeNull();
    expect(me.handle).toBe('forge');
  });

  /** 남의 이름이 내 이름과 같아도 나를 고르는 것은 **id** 다. */
  it('같은 이름의 남을 나로 착각하지 않는다', () => {
    const me = meOf('forge');
    expect(applySelfRename(me, [
      { id: 'acct-9', handle: 'anvil' },
      { id: 'acct-1', handle: 'forge' },
    ])).toBeNull();
    expect(me.handle).toBe('forge');
  });

  /**
   * **객체를 갈아끼우지 않는다.** `me` 를 값으로 받아 둔 자리가 둘이라(기동 때 조립되는
   * 인터랙티브 매니저, 턴마다 읽는 `buildTurnDeps`) 새 객체를 만들면 앞쪽이 영영 옛
   * 이름을 쥔다. 같은 참조를 들고 있는 쪽이 새 이름을 보는지가 이 줄이 지키는 것이다.
   */
  it('같은 객체를 쥔 쪽이 새 이름을 본다', () => {
    const me = meOf('forge');
    const heldElsewhere = me;
    applySelfRename(me, [{ id: 'acct-1', handle: 'anvil' }]);
    expect(heldElsewhere.handle).toBe('anvil');
  });
});

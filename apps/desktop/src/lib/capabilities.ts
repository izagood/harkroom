import type { AccountView, Capability, MeView } from '@harkroom/shared';

/**
 * **내가 이 능력을 갖는가** — 화면이 문을 그릴지 정하는 술어(스펙 2026-09-20 §5).
 *
 * `/auth/me` 는 `capabilities` 를 싣지만(`MeView`), 스토어의 `me` 는 아직 `AccountView` 로
 * 타입이 잡혀 있고 옛 서버는 그 필드를 안 보낸다. 그래서 필드가 있으면 그것을 믿고, 없으면
 * `isAdmin` 으로 물러선다 — 서버가 최종 판정자라는 것은 그대로다(눌렀을 때 되는지는 서버가
 * 답한다). 이 술어가 정하는 것은 화면에 손잡이를 그릴지뿐이다.
 */
export function hasCapability(me: AccountView | MeView | null | undefined, cap: Capability): boolean {
  if (!me) return false;
  const caps = (me as Partial<MeView>).capabilities;
  if (Array.isArray(caps)) return caps.includes(cap);
  return me.isAdmin;
}

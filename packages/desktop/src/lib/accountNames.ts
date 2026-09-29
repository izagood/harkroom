import type { AccountView } from '@harkroom/shared';

/**
 * 계정의 **이름 쪽** 사실만 뽑은 것 — 멘션 칩·이름 되돌리기·"에이전트인가" 판정·설정으로
 * 갈지(`accountOpen`)가 읽는 필드 전부다.
 *
 * 왜 따로 두는가(대화 불러오기 성능, 2026-09-29 재측정): 메시지 행이 `s.accounts` 를
 * 통째로 구독하면 **누구 하나의 상태·아바타가 바뀔 때마다** 그 객체가 새로 만들어지고
 * (`applyStatus` 는 `{ ...accounts, [id]: patched }` 다) 행 수백 개가 전부 다시 그려졌다 —
 * WebKit 합성 500행에서 이벤트 하나에 55~75ms. 행이 계정 표에서 실제로 읽는 것은 이름·
 * 종류뿐이고, 그것은 상태·아바타 이벤트에 바뀌지 않는다.
 */
export type AccountName = Pick<AccountView, 'id' | 'handle' | 'displayName' | 'kind' | 'ownerAccountId'>;
export type AccountNames = Readonly<Record<string, AccountName>>;

const cache = new WeakMap<object, AccountNames>();
/** 마지막으로 내준 지도. 이름 쪽이 그대로면 **이 참조를 다시 준다** — 이것이 요점이다. */
let last: AccountNames | null = null;

function sameNames(a: AccountNames, b: AccountNames): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const id of ak) {
    const x = a[id]!;
    const y = b[id];
    if (!y || x.handle !== y.handle || x.displayName !== y.displayName || x.kind !== y.kind
      || x.ownerAccountId !== y.ownerAccountId) return false;
  }
  return true;
}

/**
 * 스토어 셀렉터. `s.accounts` 가 새 객체여도 **이름 쪽이 같으면 같은 참조**를 돌려주므로,
 * 이것을 구독한 행은 상태·아바타 이벤트에 다시 그려지지 않는다.
 *
 * handle 이 바뀌면 참조가 바뀌고 이것을 읽는 행이 전부 다시 그려진다 — **그게 맞다.**
 * 본문의 맨 글자 `@이름` 은 계정 **전체**의 handle 목록과 맞춰 칩이 되므로(`MessageBody`
 * 의 `handles`), 새 이름은 그 계정을 부른 적 없는 행의 글자도 칩으로 바꿀 수 있다.
 * 이름 바꾸기는 드물고, 상태 이벤트는 에이전트가 일할 때마다 온다.
 *
 * 커뮤니티가 여럿이면 스토어마다 `accounts` 가 다르다. 캐시는 그 객체를 키로 잡으므로
 * 섞이지 않고, `last` 는 재사용 후보일 뿐이라 다른 커뮤니티 것이면 `sameNames` 가 거른다.
 */
export function selectAccountNames(s: { accounts: Record<string, AccountView> }): AccountNames {
  const hit = cache.get(s.accounts);
  if (hit) return hit;
  const next: Record<string, AccountName> = {};
  for (const [id, a] of Object.entries(s.accounts)) {
    next[id] = { id: a.id, handle: a.handle, displayName: a.displayName, kind: a.kind, ownerAccountId: a.ownerAccountId };
  }
  const out = last && sameNames(last, next) ? last : next;
  cache.set(s.accounts, out);
  last = out;
  return out;
}

import { useEffect, useState } from 'react';
import { createBadger, type Badge, type Badger } from './badge';
import { useCommunityRegistry, type CommunityEntry } from '../state/communities';
import { blockingUnreadCount, hasUnreadMessages } from '../state/unread';

/**
 * 독(Dock) 아이콘에 안 읽은 것을 표시한다 — Slack 이 하는 그 표시다.
 *
 * ## 왜 화면의 배지만으로는 부족한가
 *
 * 레일 홈 칸과 사이드바에 이미 배지가 있지만, 그것은 **앱을 열어 봐야 보인다.** 앱이
 * 뒤에 있으면(OS 알림을 놓쳤거나, 알림을 껐거나, 잠깐 자리를 비웠다면) 새 멘션이 왔다는
 * 사실이 어디에도 남지 않는다. 독 배지는 앱이 뒤에 있을 때 유일하게 남는 표시다.
 *
 * ## 무엇을 세는가 — 화면과 **같은 것**
 *
 * 규칙은 `state/unread.ts` 하나에 있고 레일·사이드바가 같은 함수를 쓴다. 독이 자기 식으로
 * 세면 "독에는 3, 화면에는 2" 가 되고 그때 사람이 믿는 숫자는 없다.
 *
 * ## 커뮤니티 전부를 **합친다**
 *
 * 독 아이콘은 앱에 하나뿐이므로 활성 커뮤니티만 세면 나머지 커뮤니티의 멘션이 사라진다.
 * 그래서 레지스트리의 모든 엔트리를 더한다 — 레일 홈 배지가 활성 커뮤니티만 세는 것과
 * 다른 것은 **표시하는 자리가 다르기 때문**이다(레일에는 커뮤니티 마크가 따로 있다).
 *
 * ## 마운트 자리
 *
 * `App` 최상단이다. `useNotificationOpen` 과 같은 이유다 — 부팅·접속·설정 화면에서도
 * 미읽음은 늘고 줄어든다. `ready` 안쪽에 두면 설정 화면을 열어 둔 동안 배지가 굳는다.
 */
export function useDockBadge(badger: Badger = defaultBadger()): void {
  const entries = useCommunityRegistry((r) => r.entries);
  const [badge, setBadge] = useState<Badge>({ count: 0, dot: false });

  useEffect(() => {
    // 같은 값이면 **같은 객체를 돌려준다** — 스토어 구독은 타이핑·프레즌스 같은 미읽음과
    // 무관한 변화에도 깨어나고, 그때마다 새 객체를 넣으면 이 훅을 쓰는 화면이 통째로
    // 다시 렌더된다(`App` 최상단이므로 앱 전체다).
    const recompute = (): void => setBadge((prev) => {
      const next = badgeOf(entries);
      return prev.count === next.count && prev.dot === next.dot ? prev : next;
    });
    recompute();
    // 커뮤니티마다 자기 스토어가 있다(`state/communities.ts`) — 전역 스토어가 없으므로
    // 구독도 엔트리 수만큼 걸어야 한다. `entries` 가 바뀌면(커뮤니티 추가·제거) 이
    // effect 가 다시 돌아 새 스토어까지 듣는다.
    const offs = entries.map((e) => e.store.subscribe(recompute));
    return () => { for (const off of offs) off(); };
  }, [entries]);

  useEffect(() => { void badger.set(badge); }, [badger, badge]);
}

/**
 * 지금 독에 그릴 것. 순수 함수라 테스트가 스토어 없이도 규칙을 잰다.
 *
 * 점은 **숫자가 없을 때만** 뜻이 있다: 숫자가 있으면 그것이 이미 "볼 것이 있다"를 말하고,
 * macOS 배지는 자리가 하나라 둘을 같이 그릴 수도 없다.
 */
export function badgeOf(entries: CommunityEntry[]): Badge {
  let count = 0;
  let dot = false;
  for (const e of entries) {
    const s = e.store.getState();
    count += blockingUnreadCount(s.unread);
    dot = dot || hasUnreadMessages(s.reads);
  }
  return { count, dot: count === 0 && dot };
}

/**
 * 배지기는 **한 벌만** 만든다. `createBadger` 는 마지막으로 적용한 값을 기억해 같은 값을
 * 두 번 쓰지 않는데, 렌더마다 새로 만들면 그 기억이 매번 비워져 그 절약이 사라진다.
 *
 * 테스트는 인자로 목을 넘긴다 — 그때는 이것을 부르지도 않는다.
 */
let shared: Badger | null = null;
function defaultBadger(): Badger {
  shared ??= createBadger();
  return shared;
}

/** 훅의 기본 배지기 캐시를 비운다. 테스트가 서로의 상태를 물려받지 않게 한다. */
export function resetDockBadgeForTest(): void {
  shared = null;
}

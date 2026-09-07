import { useMemo, useState } from 'react';
import type { AccountView, ChannelRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { Identity } from './Identity';

/**
 * 사이드바 **맨 위**의 찾기(정본 문서 `docs/desktop-remaining-gaps.html` 「A · 찾기가 맨
 * 위로」).
 *
 * ## 왜 있는가
 *
 * 문서의 진단을 코드로 확인했다(2026-09-07, `Sidebar.tsx`): 사이드바에서 찾기라고 할 수
 * 있는 것은 `Channels` 라벨 옆의 `text-[10px]` 돋보기 버튼 하나였고, 그것이 여는 것은
 * `ChannelDirectory` — **채널만** 나오는 모달이다. 사람과 에이전트는 그 길로 못 찾는다.
 *
 * 문서: *"에이전트 설정에서 검색을 목록보다 위에 고정한 것과 같은 이유로, 사이드바에서도
 * 찾기가 먼저다 — 채널·사람·에이전트가 한 입력으로 걸린다."* 그 선례가
 * `settings/AgentGrid.tsx` 의 `sticky` 검색줄(#479)이고, 근거도 그쪽 주석에 있다:
 * *"목록이 길어져도 찾는 수단이 스크롤 밖으로 나가지 않는다."*
 *
 * ## 어느 칸에 사는가 — **어느 칸도 아니다**
 *
 * 레일이 들어온 뒤 사이드바는 칸(`home`·`dm`·`agents`)마다 다른 묶음을 그린다. 이 줄을
 * 그 분기 **안**에 두면 문서의 요구가 곧바로 깨진다: DM 칸에서 채널을 찾으려면 홈으로
 * 돌아가야 하고, 그러면 "한 입력으로" 가 아니라 "칸을 옮긴 다음 한 입력으로" 가 된다.
 *
 * 그래서 이 줄은 `Sidebar` 의 **공용 껍데기**에 산다 — 브랜드 바 아래, 칸 분기를 담은
 * `nav` **밖**이자 **위**다. 자리를 세 곳에 복제하지 않고 한 곳에 두는 것이기도 하다.
 *
 * **레일에 다섯째 칸을 만드는 길은 택하지 않았다.** 레일 문서(`docs/desktop-rail.html`)가
 * 그것을 명시적으로 막는다: *"레일에서 세로를 쓰는 것은 네 칸뿐이어야 한다"* — 마크를
 * 쌓지 않는 이유로 적힌 *"쌓으면 네 칸을 아래로 민다"* 가 칸을 더하는 데도 그대로 걸린다.
 * 게다가 찾기는 칸(=목록 하나를 고르는 것)이 아니다: 결과를 고르면 원래 보던 칸에 그대로
 * 머문다.
 *
 * ## `SearchPalette`(⌘K) 와의 관계 — **다른 물음이다**
 *
 * `SearchPalette` 를 옮겨 온 것이 아니고, 그것을 여는 두 번째 입구도 아니다. 두 줄이 답하는
 * 물음이 다르다:
 *
 * | | 무엇을 뒤지나 | 어디서 오나 | 결과 |
 * |---|---|---|---|
 * | `SearchPalette`(⌘K) | 메시지 **본문** | 서버(`api.search`, 전문검색) | 그 말이 있는 스레드 |
 * | 이 줄 | 채널·사람·에이전트의 **이름** | 스토어(이미 다 와 있다) | 그 대화 |
 *
 * 그래서 이 줄은 ⌘K 를 빼앗지 않고, 글자를 쳐도 모달을 띄우지 않는다 — 모달이 뜨면
 * 사이드바가 가려져 방금 좁힌 목록을 못 본다. 서버에 묻지도 않는다: 세 목록이 이미
 * 스토어에 있으므로(`Directory.tsx` 가 같은 판단을 적어 뒀다: *"목록이 이미 스토어에 다
 * 있으므로 서버 질의를 새로 만들 이유가 없다"*) 한 글자마다 왕복할 이유가 없고,
 * 그래서 `SearchPalette` 의 300ms 디바운스도 필요 없다.
 *
 * ## 돋보기가 사라진 자리
 *
 * 10px 돋보기는 없어지고, 그것이 열던 `ChannelDirectory` 로 가는 길은 **이 줄 안**으로
 * 들어왔다(`sidebar-find-all-channels`). 디렉터리를 없애지 않은 이유는 그것이 이 줄이 못
 * 하는 일을 하기 때문이다 — 생성순 정렬, 보관된 채널, 토픽, 그리고 **아직 안 들어간 채널**
 * (이 줄은 사이드바에 이미 있는 것만 훑는다).
 *
 * 그러면서도 찾기를 **시작하는 자리는 하나**다. 문서가 북마크에서 이미 판정한 것을 지키는
 * 것이다: *"자기 칸이 있는데 홈에도 한 줄을 세우면 같은 것으로 가는 길이 둘이 되고,
 * 그때부터 사람은 어느 쪽이 맞는지 매번 고른다."* 두 길이 아니라 **한 길 안의 다음 걸음**
 * 이라야 그 결함이 안 생긴다.
 *
 * 그래서 그 문은 **글자를 친 뒤에만** 선다. 평소에도 세워 두면 그것이 사이드바의 두 번째
 * 상시 찾기 컨트롤이 되어, 방금 없앤 10px 돋보기를 이름만 바꿔 되살린다 — 자리가 하나라는
 * 것은 "이 줄 안에 있다"가 아니라 "고를 것이 하나다"라는 뜻이다.
 */

/** 결과 한 줄이 무엇인가. 종류를 값으로 드는 이유는 아래 `KIND_LABEL` 주석에 있다. */
type Hit =
  | { kind: 'channel'; id: string; name: string }
  | { kind: 'human' | 'agent'; id: string; account: AccountView };

/**
 * 줄에 붙는 종류 글자.
 *
 * **붙이는 이유가 DM 목록과 반대다.** 레일 문서는 DM 목록에서 사람과 에이전트를 가르지
 * 말라고 했다(*"목록만 봐서는 누가 에이전트인지 알 수 없다"*) — 그것은 **같은 종류의 것들이
 * 최근순으로 섞인 목록**의 규칙이다. 여기는 다르다: 한 글자에 채널·사람·에이전트가 **동시에**
 * 걸리므로, 종류를 말하지 않으면 `deploy` 로 걸린 세 줄 중 어느 것이 채널인지 눌러 봐야
 * 안다. 채널을 열 셈으로 사람에게 DM 을 거는 것은 되돌리기 번거로운 실수다.
 *
 * 사람과 에이전트를 갈라 적는 것도 같은 이유다 — 이 목록에서는 "누구에게 말을 거는가" 가
 * 아니라 "무엇을 골랐는가" 가 물음이고, 셋을 섞어 놓고 둘만 같은 이름으로 부르면 종류
 * 글자가 답을 반만 한다.
 */
const KIND_LABEL: Record<Hit['kind'], string> = {
  channel: '채널',
  human: '사람',
  agent: '에이전트',
};

/** 결과 상한. 20 을 넘기면 목록이 아니라 벽이고, 그때 필요한 것은 스크롤이 아니라 더 친 글자다. */
const MAX_HITS = 20;

export function SidebarFind({ onOpenChannelDirectory }: {
  /** 이 줄이 못 하는 일(보관·생성순·안 들어간 채널)로 가는 다음 걸음. **옵셔널이 아니다** —
   *  기본값을 여기서 공급하면 배선을 잊은 화면에서도 버튼이 그려지고 눌러도 아무 일이
   *  없다(design.md §4). */
  onOpenChannelDirectory: () => void;
}) {
  const [query, setQuery] = useState('');
  const channels = useActiveStore((s) => s.channels);
  const accounts = useActiveStore((s) => s.accounts);
  const meId = useActiveStore((s) => s.me?.id ?? null);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    // 보관된 채널은 뺀다 — `ChannelDirectory` 가 그것을 접힌 그룹으로 따로 두는 이유와
    // 같다(그쪽 주석: *"본 목록에 섞으면 이미 끝난 채널이 살아 있는 채널과 같은 무게로
    // 보인다"*). DM(`kind !== 'standard'`)도 뺀다: 이 목록에서 사람은 **계정**으로 걸리고,
    // 그 사람의 DM 채널까지 걸리면 같은 사람이 두 줄로 선다.
    const channelHits: Hit[] = channels
      .filter((ch: ChannelRow) => ch.kind === 'standard' && !ch.archivedAt)
      .filter((ch) => (ch.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .map((ch) => ({ kind: 'channel' as const, id: ch.id, name: ch.name ?? '' }));

    // `handle` 과 `displayName` **둘 다** 본다 — `Directory.tsx` 가 적어 둔 이유가 그대로
    // 걸린다: *"사람은 둘 중 아는 쪽으로 친다."* `instructions` 는 여기서 안 본다:
    // 스토어의 `AccountView` 에 그 필드가 없다(`AgentGrid` 의 `AgentCardSubject` 주석이
    // 같은 사실을 적어 뒀다).
    const accountHits: Hit[] = Object.values(accounts)
      // 나 자신은 뺀다 — 나에게 DM 을 걸 일이 없고, 내 이름은 거의 모든 글자에 걸린다.
      // 비활성 계정도 뺀다: 눌러도 대화가 되지 않는 줄은 결과가 아니라 소음이다.
      .filter((a) => a.id !== meId && !a.disabled)
      .filter((a) => a.handle.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q))
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .map((a) => ({ kind: a.kind === 'agent' ? ('agent' as const) : ('human' as const), id: a.id, account: a }));

    // 채널이 먼저다. 사이드바에서 찾는 것의 대부분이 채널이고(개수가 가장 많다),
    // 사람·에이전트는 DM 칸과 에이전트 칸이 각자 제 목록을 이미 갖고 있다.
    return [...channelHits, ...accountHits].slice(0, MAX_HITS);
  }, [query, channels, accounts, meId]);

  /**
   * 고르면 검색어를 비운다. 남겨 두면 다음에 사이드바를 볼 때 지난 결과가 목록 위에 서서
   * **채널 목록을 가린 채** 방금 연 채널을 덮는다 — 결과 목록은 목록보다 위에 있으므로
   * 남는 것이 조용하지 않다.
   */
  const pick = (run: () => void) => {
    run();
    setQuery('');
  };

  return (
    <div data-testid="sidebar-find-row" className="shrink-0 border-b border-border px-2 py-2">
      <div className="relative">
        {/* 글리프는 `aria-hidden` 이다 — 이름은 `aria-label` 이 진다. 그대로 두면
            스크린리더가 돋보기를 이름의 일부로 읽는다(`Sidebar` 의 `addRow` 와 같은 규칙). */}
        <span aria-hidden="true" className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle">⌕</span>
        <input
          data-testid="sidebar-find"
          type="text"
          aria-label="찾기"
          /* 무엇이 걸리는지를 placeholder 가 말한다 — 문서의 "채널·사람·에이전트가 한
             입력으로" 를 사람이 화면에서 확인하는 유일한 자리다. 안 적으면 이 칸은
             채널만 걸리는 예전 돋보기로 읽힌다. */
          placeholder="채널 · 사람 · 에이전트"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Escape 로 걷는다. 결과를 치우는 유일한 길이 글자를 지우는 것이면, 키보드로만
            // 쓰는 사람은 목록을 되돌리려고 백스페이스를 세는 처지가 된다.
            if (e.key === 'Escape') {
              e.preventDefault();
              // 전파를 막는다 — 위에 오버레이가 있을 때 이 Escape 가 그것까지 닫으면
              // 검색어를 비우려던 한 번의 누름이 두 가지를 한다.
              e.stopPropagation();
              setQuery('');
            }
          }}
          /* 포커스 링은 전역 `:focus-visible` 이 준다(#548) — 여기서 다시 붙이지 않는다. */
          className="w-full rounded border border-border bg-field py-1 pl-7 pr-2 text-sm
                     text-fg placeholder-fg-subtle"
        />
      </div>

      {query.trim() && (
        <ul
          data-testid="sidebar-find-results"
          /* 결과는 이 줄 안에서 스크롤한다 — 밖으로 밀면 아래 목록을 끝까지 밀어내고,
             그러면 "찾기가 목록 위에 고정" 이 "찾기가 목록을 밀어낸다" 가 된다. */
          className="mt-1 max-h-64 overflow-y-auto"
        >
          {hits.length === 0 && (
            // 빈 목록과 "안 찾아봤다" 를 구별한다 — `Directory.tsx` 의 세 상태 구분과 같은
            // 이유다. 여기서는 물어보는 중이 없다(스토어에 이미 다 있다) 그래서 둘뿐이다.
            <li className="px-2 py-1.5 text-[11px] text-fg-subtle">찾는 것이 없다</li>
          )}
          {hits.map((hit) => (
            <li key={`${hit.kind}-${hit.id}`}>
              {hit.kind === 'channel' ? (
                <button
                  data-testid={`sidebar-find-channel-${hit.id}`}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-surface-raised"
                  onClick={() => pick(() => void getController().openChannel(hit.id))}
                >
                  <span aria-hidden="true" className="shrink-0 text-fg-subtle">#</span>
                  <span className="min-w-0 flex-1 truncate text-fg">{hit.name}</span>
                  <KindTag kind={hit.kind} />
                </button>
              ) : (
                <button
                  data-testid={`sidebar-find-account-${hit.id}`}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-surface-raised"
                  /* 사람이든 에이전트든 **DM 을 연다** — 레일 문서 2단계가 정한 것이고
                     (*"DM 은 사람과 에이전트를 안 가른다"*), 에이전트 칸의 카드도 이미
                     `startDm` 이다(`Sidebar` 의 `onPick` 주석). 여기서 다른 것을 열면
                     같은 에이전트를 어디서 눌렀는지에 따라 다른 화면이 나온다. */
                  onClick={() => pick(() => getController().startDm(hit.id))}
                >
                  {/* `aria-hidden` 이다 — 바로 오른쪽에 같은 핸들이 글자로 서 있어서,
                      두면 스크린리더가 핸들을 두 번 읽는다(`Sidebar` 의 `dmRow` 가 같은
                      중복을 이미 고쳤다). */}
                  <span aria-hidden="true" className="shrink-0">
                    <Identity account={hit.account} variant="avatar" className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg">{hit.account.handle}</span>
                  <KindTag kind={hit.kind} />
                </button>
              )}
            </li>
          ))}
          <li>
            {/*
              디렉터리로 가는 다음 걸음. **결과 목록의 맨 아래**다 — 맨 위에 두면 결과보다
              먼저 읽히는데, 이 줄이 필요한 것은 위의 결과에서 못 찾았을 때뿐이다.
              `+` 가 목록의 첫 칸인 것과 어긋나지 않는다: 그것은 **만드는** 문이고 개수와
              무관하게 자리가 고정돼야 하지만, 이것은 **더 넓게 뒤지는** 문이라 좁힌 결과를
              보고 나서 누르는 것이다.
            */}
            <button
              data-testid="sidebar-find-all-channels"
              className="w-full rounded px-2 py-1 text-left text-[11px] text-fg-muted hover:bg-surface-raised"
              onClick={() => pick(onOpenChannelDirectory)}
            >
              모든 채널에서 찾기
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * 종류 글자. 줄의 **오른쪽 끝**이다 — 왼쪽에 두면 이름들이 종류 글자의 길이만큼 들쭉날쭉
 * 시작해서, 훑을 때 눈이 이름을 찾아야 한다. 이름이 왼쪽 정렬로 서고 종류가 오른쪽에
 * 붙으면 훑는 축이 하나다.
 *
 * 강조색을 쓰지 않는다 — #488 B2 가 회수한 그 색이다. 종류는 "현재 상태" 이지 "나를 막는
 * 것" 이 아니다.
 */
function KindTag({ kind }: { kind: Hit['kind'] }) {
  return (
    // 11px 다 — 4단의 가장 작은 단(#555). 이 글자는 **읽는 것**이라 아바타 원 안의
    // 머리글자처럼 예외가 아니다: 세 종류를 가려 주는 값이므로 읽히지 않으면 쓸모가 없다.
    <span className="shrink-0 text-[11px] text-fg-subtle">{KIND_LABEL[kind]}</span>
  );
}

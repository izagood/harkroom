import { useMemo, useState } from 'react';
import type { AccountView, AgentTeamMemberRow, AgentTeamRow } from '@harkroom/shared';
import { Identity } from '../Identity';
import type { RunnerState } from '../../lib/runnerLauncher';
// 얼굴 판정은 **에이전트 격자와 같은 한 벌**이다(`lib/faceState.ts`). 팀 카드의 얼굴이
// 그 판정을 따르지 않으면 같은 러너가 에이전트 묶음에서는 회색이고 팀 묶음에서는 초록이
// 된다 — 그 파일 머리 주석이 `#476` 에서 겪은 사고로 적어 둔 결함이 그대로 재현된다.
import { faceState, isFaceGreyed } from '../../lib/faceState';
// 겹침 순서는 순수 판정이라 컴포넌트 밖이다. 왜 그것이 함수여야 하는지(그리고 왜 이름순이
// 아닌지)가 그 모듈 주석에 있다.
import { TEAM_FACE_SLOTS, sortTeamFaces } from '../../lib/teamFaces';
// 번역기를 `t` 로 안 받는다 — 아래 격자가 팀 하나를 `t` 로 순회한다(`shown.map((t) => …)`).
// 같은 이름을 쓰면 그 안에서 번역기가 가려지고, 가려진 채로 컴파일이 통과할 수 있다.
import { useT } from '../../i18n/useT';

/**
 * 팀 카드가 그리는 데 필요한 것. `AgentTeamRow` + **팀원 명단**이다.
 *
 * 명단이 행에 안 실려 있는 것이 이 타입이 존재하는 이유다 — `appStore.ts` 의 `teams` 주석이
 * 그 사실을 이미 적어 뒀다: *"팀 명단을 주는 라우트는 `GET /teams/:id` 하나뿐"* 이다.
 * 그래서 명단을 **얻는 일은 호출부의 몫**이고(그 왕복 판단은 `AgentsSettings` 의
 * `teamMembers` 주석에 있다), 이 컴포넌트는 받은 것을 그린다.
 *
 * `members` 가 `undefined` 인 것과 `[]` 인 것은 **다른 사실**이다:
 *
 * | 값 | 뜻 | 카드가 그리는 것 |
 * |---|---|---|
 * | `undefined` | 아직 안 받았다 (왕복이 도는 중이거나 실패했다) | 얼굴 자리를 비운다 |
 * | `[]` | 받았고 **팀원이 없다** | 빈 팀이라고 말한다 |
 *
 * 둘을 합치면 명단을 못 받은 팀이 "팀원 0명"으로 그려진다 — `design.md` §4 가 금지하는
 * 거짓 신호다(`memberCount` 는 행에 실려 오므로 화면은 **수는 알고 명단만 모르는** 상태가
 * 될 수 있고, 그때 0명이라고 적으면 자기가 아는 수와도 어긋난다).
 */
export type TeamCardSubject = AgentTeamRow & {
  /** `GET /teams/:id` 의 명단. `undefined` 는 **아직 모른다**다(위 표). */
  members?: AgentTeamMemberRow[];
};

/**
 * 팀 카드 격자.
 *
 * ## 왜 `AgentGrid` 를 재사용하지 않았나 — **`place` 축을 늘리지 않기 위해서다**
 *
 * `AgentGridPlace` 주석이 이 판단을 미리 못 박아 뒀다: *"값이 둘인 것은 호출자가 둘이기
 * 때문이고, 그 이상으로 늘릴 축이 아니다 — 늘어나기 시작하면 카드가 다시 두 벌이 된다."*
 * 팀을 그 격자에 태우는 길은 둘뿐이고 **둘 다 그 문장에 걸린다**:
 *
 * 1. `place: 'team'` 을 더한다 → 축이 셋이 되고, 그 주석이 금지한 그것이다
 * 2. `AgentCardSubject` 에 팀 필드를 옵셔널로 얹는다 → `AgentCardSubject` 주석이 이미
 *    거부한 방향이다(*"기능이 조용히 줄어드는 것을 타입이 드러낸다"* 는 규율은 **없을 수
 *    있는 값**에 쓰는 것이고, 팀의 얼굴 여럿은 없을 수 있는 값이 아니라 **다른 종류**다)
 *
 * 그리고 실제로 갈리는 것이 얼굴 하나가 아니다. 문서가 *"다른 것은 얼굴 자리에 얼굴이
 * 여럿이라는 것뿐이다"* 라고 적었지만, 그 한 가지가 **네 곳을 함께 바꾼다**:
 *
 * | 자리 | 에이전트 카드 | 팀 카드 |
 * |---|---|---|
 * | 얼굴 | 하나 · 상태를 겸한다 | 넷까지 겹침 + `+N` |
 * | 얼굴의 손잡이 | `▶`·`■`·`↻` 셋 | **없다**(아래 「손잡이가 아니다」) |
 * | 정보 줄 | 하네스·러너·활동 세 줄 | `팀 · N명` **한 줄** |
 * | 예외 줄 | 실패 사유·멈추는 중·물러나는 중 | 비활성 팀원 |
 *
 * 넷 다 `place` 조건부로 갈라야 하고, 그러면 `AgentGrid` 안이 두 카드의 분기로 채워진다 —
 * *"카드가 다시 두 벌이 된다"* 는 그 주석의 경고가 파일 하나 안에서 실현되는 모양이다.
 *
 * ## 그래서 **같은 틀을 쓰되 별개 컴포넌트**다
 *
 * 문서가 요구한 *"에이전트 카드와 같은 틀"* 은 컴포넌트를 공유하라는 말이 아니라 **숫자와
 * 어휘를 공유하라**는 말이다. 그것을 지키는 방법으로 아래 `FRAME` 이 `AgentGrid` 의
 * `PLACE.settings` 와 **같은 값을 같은 이름으로** 갖는다 — 트랙 164px · 얼굴 자리 88px ·
 * 상자 `rounded-lg border bg-surface-raised p-3` · 가라앉은 격자 바닥. 그 표의 주석에
 * 각 숫자가 실측으로 정해진 근거가 길게 적혀 있고, 여기서 그것을 다시 적지 않는다.
 *
 * **공유하지 않는 대가를 알고 있다**: 그 표의 숫자가 바뀌면 이 파일도 따라 고쳐야 한다.
 * 그 대가를 받아들이는 이유는 위 표의 네 줄이고, 회귀선이 두 값을 **함께** 재서 어긋남을
 * 잡는다(`teamGrid.test.tsx` 의 *"틀이 에이전트 카드와 같다"*).
 *
 * ## 팀 얼굴은 손잡이가 아니다 (문서 4단계)
 *
 * > *"44px 얼굴 다섯에 각각 손잡이를 달면 어느 것을 눌렀는지 알 수 없다. 팀 카드는 카드
 * > 전체가 상세로 가는 문이고, 팀원을 켜고 끄는 일은 에이전트 묶음에서 한다."*
 *
 * 그래서 이 격자에는 `onRelaunch`·`onStop` 이 **애초에 없다.** prop 을 두고 안 넘기는
 * 것과 다르다 — 없으면 다음 사람이 넘길 수 없다.
 *
 * ## 상태 글자가 없다
 *
 * 문서: *"각 얼굴이 자기 상태를 그대로 지니므로 팀 카드는 상태 글자 없이도 '이 팀에 하나가
 * 죽어 있다' 를 말한다."* `AgentGrid` 가 세운 규칙(*"상태는 사진이 말한다"*)이 얼굴이
 * 여럿이 돼도 그대로다. 글자를 받는 것은 **예외 하나**뿐이고 그것이 비활성 팀원이다.
 */
const FRAME = {
  /** `AgentGrid` 의 `PLACE.settings.grid` 와 **같은 값**이다(그 표에 근거가 있다). */
  grid: 'grid-cols-[repeat(auto-fill,164px)] gap-x-4 gap-y-4',
  card: 'w-[164px]',
  /** 같은 표의 `box`. 선 색은 호출부가 붙이지 않는다 — 팀 카드에는 실패 분기가 없다. */
  box: 'rounded-lg border border-border bg-surface-raised p-3',
  gridBg: 'rounded-lg bg-surface-sunken p-3',
  createBox: 'rounded-lg border border-dashed border-border p-3',
  bg: 'bg-surface-raised',
} as const;

/**
 * 겹친 얼굴 하나의 크기. **44px 이고 그 값이 문서에서 온다**(4단계: *"44px 얼굴 넷까지"*).
 *
 * 88px 얼굴 자리의 **절반**인 것이 요점이다 — 에이전트 카드의 얼굴 한 개가 88px 이고
 * (`PLACE.settings.face`), 팀 카드는 같은 자리에 절반 크기를 겹쳐 세운다. 그래서 두 카드가
 * 나란히 서도 얼굴 묶음의 높이가 어긋나지 않는다: 넷을 겹쳐도 세로는 44px 한 줄이고,
 * 그 차이(44px)는 아래 `mt-auto` 가 흡수한다(`AgentGrid` 의 그 주석과 같은 장치다).
 *
 * `text-[15px]` 은 **상자에 묶인 글리프**다 — 4단의 이름줄이 아니라 44px 원의 지름에서
 * 따라 나온 값이다. `Identity.tsx` 와 `AgentGrid` 의 `faceText` 가 같은 규칙을 갖고 있고
 * (`h-12`→16px, `h-10`→16px, `h-8`→14px, `h-5`→10px), 44px 은 그 사다리에서 `h-12`(48px)
 * 바로 아래라 16px 과 같은 칸에 든다.
 *
 * **그래서 토큰(`text-name`)으로 옮기지 않는다.** 4단이 `@theme` 토큰이 된 판에서 이 줄이
 * 갈렸다: 값이 15px 로 같다고 `text-name` 을 부르면 "이 글자는 이름줄이다"라고 말하는
 * 것이 되는데, 이 자리는 이름이 아니라 **원의 지름**이다. 44px 얼굴을 40px 로 줄이는 날
 * 이 글자도 따라 줄어야 하고, 그때 `text-name` 을 쓰고 있으면 4단의 이름줄이 통째로
 * 끌려간다. 토큰 이름을 역할로 지은 값이 여기서 나온다 — 크기가 같아도 **뜻이 다르면
 * 다른 이름**이다.
 *
 * 값이 같다는 사실 때문에 앞 판까지는 회귀선이 이 줄을 그냥 통과시켰다(그 주석이 여기
 * 있었다: *"임의값이라 `SCALE_NAME` 에 안 걸리고 15px 이 4단 중 하나다"*). 토큰이 정본이
 * 된 지금은 임의값 자체가 위반이라, 이 줄은 `test/typeScale.test.ts` 의 `ALLOWED` 에
 * 상자 글리프로 등록돼 있다.
 */
const FACE = 'h-11 w-11 text-[15px]';

/**
 * 팀 카드 하나의 얼굴 묶음. 넷까지 겹치고 나머지는 `+N` 이다.
 *
 * ## 겹침은 **이미 있는 선례를 쓴다** — 새로 만들지 않는다
 *
 * `ThreadParticipants.tsx` 와 `MessageItem.tsx` 가 같은 일을 하고 있고 모양이 이것이다:
 * `flex -space-x-1` + 래퍼의 `rounded-full ring-1` + `+N` 칸. `#471` 의 교훈이 그 래퍼에
 * 적혀 있다 — *"`rounded-full` 이 없으면 링이 사각형으로 그려지고 겹친 자리에서 그 세로 변이
 * 앞 아바타 위에 선처럼 얹힌다."* 링의 목적이 겹친 원을 떼어 놓는 것인데 사각 링은 반대로
 * 경계를 만든다.
 *
 * 링 색이 `ring-surface-raised` 인 것은 **이 카드의 바닥색**이다(`FRAME.box` 의
 * `bg-surface-raised`). `ThreadParticipants` 가 `ring-surface-raised` 를 쓰고
 * `MessageItem` 이 `ring-surface` 를 쓰는 것이 그 차이다 — 두 자리의 바닥이 달라서다.
 * `AgentGrid` 의 `PLACE.bg` 칸 주석이 같은 규율을 적어 뒀다: *"토큰을 쓰고 있어도 자리와
 * 맞지 않으면 틀린 색이다."*
 *
 * ## 왼쪽이 위로 겹친다 — `z-index` 를 **역순으로** 준다
 *
 * `sortTeamFaces` 가 고장난 것을 왼쪽에 세운다. 그런데 `-space-x-1` 로 겹친 원은 기본
 * 쌓임 순서에서 **뒤에 오는 것이 앞을 덮으므로**, 정렬만 해서는 실패한 얼굴의 붉은 테가
 * 그 오른쪽 얼굴에 덮여 잘린다 — 문서가 경고한 결함(*"붉은 테가 옆 얼굴에 잘려 사라진다"*)이
 * 정렬을 고친 뒤에도 그대로 남는다는 뜻이다. **순서와 쌓임은 다른 축이고 둘 다 필요하다.**
 *
 * 그래서 앞 원소가 큰 `z-index` 를 받는다. `relative` 가 함께 필요하다 — `z-index` 는
 * `static` 요소에서 아무 일도 하지 않는다.
 */
function TeamFaces({ team, accounts, runnerStates, online, connected }: {
  team: TeamCardSubject;
  accounts: Record<string, AccountView>;
  runnerStates: Record<string, RunnerState>;
  online: string[];
  connected: boolean;
}) {
  /**
   * **명단을 못 받았으면 얼굴 자리를 비운다**(`TeamCardSubject` 의 그 표). 점선 원 하나로
   * 자리를 잡는다 — 아무것도 안 그리면 그 카드만 키가 낮아져 한 줄의 정보 줄이 어긋난다
   * (`AgentGrid` 가 `h-full`+`mt-auto` 로 맞춰 놓은 그 정렬이다). 점선은 이 저장소가
   * "아직 값이 없다"로 쓰는 어휘다(`+` 카드).
   */
  if (team.members === undefined) {
    return (
      <span
        data-testid={`team-faces-${team.name}`}
        data-members="unknown"
        className={`flex ${FACE} items-center justify-center rounded-full border border-dashed
                    border-border text-fg-subtle`}
        aria-hidden="true"
      >
        {'…'}
      </span>
    );
  }

  const ordered = sortTeamFaces(
    team.members,
    (m) => faceState(m.accountId, runnerStates, online, connected),
  );
  const shown = ordered.slice(0, TEAM_FACE_SLOTS);
  const rest = ordered.length - shown.length;

  return (
    /*
      `aria-hidden` 이다 — `ThreadParticipants`·`MessageItem` 의 겹친 아바타가 같은 판단을
      하고 있고(*"장식 용도라 스크린리더가 읽지 않도록"*), 이 자리에서 특히 그렇다: 아래
      정보 줄이 `팀 · N명` 으로 수를 이미 말하고, 카드 `button` 의 접근 이름이 팀 이름을
      말한다. 얼굴 넷을 읽어 주면 스크린리더에서는 **명단이 되고**, 그것은 문서가 카드에서
      없앤 바로 그것이다(*"다섯을 적으면 카드가 목록이 된다"*).
    */
    <span
      data-testid={`team-faces-${team.name}`}
      data-members={String(team.members.length)}
      className={`flex ${team.members.length === 0 ? FACE : ''} -space-x-1 items-center`}
      aria-hidden="true"
    >
      {shown.map((m, i) => {
        const face = faceState(m.accountId, runnerStates, online, connected);
        return (
          <span
            key={m.accountId}
            data-testid={`team-face-${team.name}-${m.handle}`}
            data-face={face}
            /*
              `zIndex` 를 인라인 스타일로 주는 이유: 값이 **팀원 수에서 나온다**. Tailwind
              의 `z-*` 는 클래스라 동적 값을 문자열로 조립해야 하고, JIT 이 스캔하지 못한
              클래스는 빌드에서 사라진다 — 겹침 순서가 개발 중에는 맞고 배포본에서만
              뒤집히는, 화면에서 확인할 수 없는 종류의 결함이 된다.
            */
            style={{ zIndex: TEAM_FACE_SLOTS - i }}
            // #471: `rounded-full` 이 없으면 링이 사각으로 그려져 겹친 자리에 세로선이 생긴다.
            className="relative rounded-full ring-1 ring-surface-raised"
          >
            {/*
              **실패는 붉은 테를 받는다.** 에이전트 카드는 그 테를 상자로 올렸지만(그 파일의
              감싸개 주석: *"둘 다 칠하면 붉은 것이 카드 하나에 두 개가 된다"*) 팀 카드에서는
              **상자가 팀의 것이고 실패는 팀원 하나의 것**이라 그 길이 막혀 있다 — 상자를
              칠하면 다섯 중 하나가 죽은 것이 "이 팀이 죽었다"로 읽힌다.

              그래서 이 자리에서는 얼굴이 그 일을 계속한다. `AgentGrid` 가 사이드바에 대해
              같은 판단을 적어 뒀다(*"상자가 없는 자리에서는 얼굴이 그 일을 계속한다 …
              붉은 테는 없어진 것이 아니라 상자가 있는 자리에서만 상자로 올라갔다"*) —
              여기서는 상자가 **다른 것을 감싸므로** 그 예외가 그대로 적용된다.

              문서가 겹침 순서를 정한 이유가 정확히 이 테다(*"붉은 테가 옆 얼굴에 잘려
              사라진다"*). 위 `zIndex` 와 `sortTeamFaces` 두 장치가 그것을 함께 막는다.
            */}
            <span className={face === 'failed' ? 'block rounded-full ring-2 ring-state-stuck' : 'block'}>
              {/* 멈춘·모르는·물러나는 얼굴은 색이 빠진다 — 판정과 필터 모두 에이전트
                  카드와 **같은 것**이다(`isFaceGreyed`). 세기까지 같은 값을 쓴다: 두 묶음이
                  같은 러너를 다른 회색으로 그리면 사람이 그 차이를 뜻으로 읽는다. */}
              <span
                className={isFaceGreyed(face)
                  ? 'block grayscale brightness-[1.7] contrast-[0.55] opacity-90'
                  : 'block'}
              >
                <Identity account={accounts[m.accountId]} className={FACE} variant="avatar" />
              </span>
            </span>
          </span>
        );
      })}
      {rest > 0 && (
        /* `+N` 은 **옆 얼굴과 같은 상자**다(`MessageItem` 의 그 칸과 같은 규율: *"옆 아바타와
           같은 h-4 상자이므로 같은 글리프 크기"*). 겹침의 맨 오른쪽이라 `z-index` 가 가장
           작고, 기본 쌓임이 이미 그것을 준다 — 앞 얼굴들이 명시적으로 큰 값을 받았다. */
        <span
          data-testid={`team-overflow-${team.name}`}
          className={`relative flex ${FACE} items-center justify-center rounded-full
                      bg-surface-hover font-medium text-fg-muted ring-1 ring-surface-raised`}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}

export function TeamGrid({
  teams, accounts, runnerStates, online, connected, onPick, onCreate, canCreate,
}: {
  /**
   * 팀 목록. **`null` 은 "서버가 목록을 주지 않았다"** 이고 빈 배열(*"팀이 없다"*)과
   * 다른 사실이다 — `TeamCardSubject.members` 의 `undefined`/`[]` 가 갈리는 것과 같은
   * 규율이고(위 표), 여기서 그 둘을 합치면 아래 빈 상태가 **있는 팀을 없다고 단언한다.**
   *
   * 그 상태가 실제로 나왔다: 팀 라우트는 있는데 `GET /accounts` 에 `teams` 가 없는 서버에
   * 붙으면, 팀을 만들어도 격자는 비어 있고 같은 이름으로 다시 만들면 서버가
   * `name_taken` 으로 거절한다(`appStore.ts::teams` 의 그 표).
   */
  teams: TeamCardSubject[] | null;
  /** 얼굴을 그리려면 계정이 필요하다 — 팀원 행에는 handle 만 있고 사진·이름은 없다. */
  accounts: Record<string, AccountView>;
  runnerStates: Record<string, RunnerState>;
  online: string[];
  connected: boolean;
  onPick(team: AgentTeamRow): void;
  onCreate(): void;
  canCreate: boolean;
}) {
  const trans = useT();
  const [query, setQuery] = useState('');

  /**
   * 검색은 **이름만 훑는다** — 에이전트 격자가 설명까지 훑는 것(`AgentCardSubject` 의
   * `instructions`)과 갈리는 이유는 팀에 설명이 없어서다. 서버가 주는 것은 이름·만든
   * 사람·만든 시각·팀원 수뿐이다(`AgentTeamRow`). 없는 것을 훑는 코드를 미리 두지 않는다.
   *
   * 정렬은 **가나다 고정**이고 근거가 `AgentGrid` 의 그 주석과 같다(*"상태순으로 정렬하면
   * … 위치로 기억하는 것이 불가능해진다"*). 팀 카드에서 그 위험이 더 크다: 정렬 키가 될
   * 상태가 팀원 다섯의 얼굴에 흩어져 있어, 상태순이라는 것이 애초에 하나로 정해지지 않는다.
   */
  const shown = useMemo(() => {
    const all = teams ?? [];
    const q = query.trim().toLowerCase();
    const matched = q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all;
    return [...matched].sort((a, b) => a.name.localeCompare(b.name));
  }, [teams, query]);

  return (
    <div className="flex min-h-0 flex-col">
      {/* 검색줄의 모양·자리·바닥색이 에이전트 격자와 같다 — 두 묶음이 탭으로 갈리는
          형제이므로, 여기서 모양이 갈리면 탭을 옮길 때마다 화면이 다시 배치된다.

          **목록을 못 받았으면 아예 그리지 않는다.** 훑을 것이 없는 검색창은 눌러도 아무
          일이 안 일어나는 손잡이고, 오른쪽의 `N개` 는 모르는 수를 `0개` 로 단언한다. */}
      {teams !== null && (
      <div className={`sticky top-0 z-10 ${FRAME.bg} pb-4`}>
        <div className="relative">
          <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle">⌕</span>
          <input
            data-testid="team-search"
            aria-label={trans('agents.teams.gridSearch')}
            className="w-full rounded-lg border border-border bg-field py-2 pl-8 pr-14
                       text-fg placeholder-fg-subtle"
            placeholder={trans('agents.teams.gridSearchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-meta text-fg-subtle">
            {trans('agents.teams.gridSearchCount', { count: shown.length })}
          </span>
        </div>
      </div>
      )}

      <div data-testid="team-grid" className={`grid ${FRAME.grid} ${FRAME.gridBg} overflow-y-auto`}>
        {/* `+` 가 맨 앞인 것도 에이전트 격자와 같다 — 개수와 무관하게 자리가 고정된다. */}
        {canCreate && (
          <button
            data-testid="team-create"
            className={`group flex h-full ${FRAME.card} ${FRAME.createBox} flex-col items-center
                        justify-center gap-2 text-fg-subtle hover:border-fg-subtle hover:text-fg`}
            onClick={onCreate}
          >
            <span aria-hidden="true" className="text-[15px] leading-none">+</span>
            <span className="text-meta text-fg-muted">{trans('agents.teams.newTeam')}</span>
          </button>
        )}

        {shown.map((t) => {
          /**
           * **비활성 팀원**(문서 4단계: *"카드 맨 아래, 실패 사유와 같은 자리에 한 줄"*).
           *
           * > *"지우면 왜 안 불렸는지를 알 수 없으므로 얼굴은 남긴다"*
           *
           * 즉 이 사실은 얼굴을 **빼는** 것이 아니라 글자를 **더하는** 것이다. 비활성
           * 에이전트는 팀에 남고 채널에 넣을 때만 걸러지며(`AgentTeamMemberRow.disabled`
           * 의 주석 · `AddTeamToChannelResult.skipped`), `memberCount` 도 그것을 센다
           * (`AgentTeamRow.memberCount`: *"비활성 팀원도 센다"*). 그래서 `팀 · 5명` 과
           * 실제로 깨는 넷이 어긋날 수 있고, **그 어긋남을 말하는 것이 이 줄의 일 전부**다.
           *
           * 명단을 못 받은 팀은 이 줄이 없다 — 없는 것을 없다고 하려면 명단을 알아야 한다.
           */
          const off = (t.members ?? []).filter((m) => m.disabled);
          return (
            /* `h-full`+`mt-auto` 로 한 줄의 정보 줄을 같은 y 에 맞춘다. 근거는 `AgentGrid`
               의 그 주석이고, 여기서 특히 필요하다 — 명단을 못 받은 카드(얼굴 한 자리)와
               `+N` 까지 선 카드, 비활성 줄을 얻은 카드가 각각 다른 키를 갖는다. */
            <div
              key={t.id}
              data-testid={`team-box-${t.name}`}
              className={`group relative flex h-full ${FRAME.card} flex-col items-center gap-2 ${FRAME.box}`}
            >
              {/*
                **카드 전체가 상세로 가는 문이다**(문서: 팀 얼굴은 손잡이가 아니다). 그래서
                얼굴이 이 `button` **안**에 있다 — 에이전트 카드가 얼굴 위에 손잡이를 얹기
                위해 감싸개를 쓴 것과 달리, 여기서는 얼굴을 눌러도 카드를 누른 것과 같은 일이
                일어나야 한다.
              */}
              <button
                data-testid={`team-card-${t.name}`}
                className="group flex w-full flex-col items-center gap-2"
                onClick={() => onPick(t)}
              >
                <TeamFaces
                  team={t}
                  accounts={accounts}
                  runnerStates={runnerStates}
                  online={online}
                  connected={connected}
                />
                {/*
                  이름은 **`@` 를 달고 한 줄**이다. 에이전트 카드가 두 줄인 것(`displayName`
                  과 `@handle`)과 갈리는 이유는 팀에 두 이름이 없어서다 — `AgentTeamRow` 에는
                  `name` 하나뿐이고, 그것이 곧 부르는 이름이다.

                  **`@` 가 붙는 것이 이 화면에서 뜻을 갖는다**(문서 4단계 「이름의 뜻을
                  말한다」): 팀 이름은 계정과 같은 네임스페이스라 `@release` 로 부르면 팀
                  전체가 깬다. 격자 위 안내 한 줄이 그 사실을 말하고(`AgentsSettings` 의
                  팀 묶음 머리), 카드의 `@` 가 그 말을 카드마다 되짚는다 — 안내를 지나친
                  사람도 이름 모양에서 그것이 부를 수 있는 이름임을 본다.
                */}
                <span className="block w-full truncate text-center text-body font-semibold text-fg">
                  @{t.name}
                </span>
              </button>

              {/*
                ## 정보는 **한 줄**이다 (문서 4단계: *"이름 아래 한 줄 `팀 · N명`"*)

                에이전트 카드의 세 줄(하네스·러너·활동)에 대응하는 자리이고, 그것들과 같은
                구분선 위에 선다. 라벨·값 두 칸(`InfoRow`)이 아니라 한 덩어리인 이유:
                비교할 값이 하나면 라벨의 고정 폭이 하는 일이 없다 — 그 폭은 *"세 줄의 값이
                같은 x 에서 시작해야 세로로 훑는 비교가 된다"* 는 이유로 있었다(`InfoRow` 주석).

                **수는 `memberCount` 에서 온다 — 명단 길이가 아니다.** 행에 실려 오는 값이라
                명단을 못 받은 카드도 이 줄을 그릴 수 있고(`TeamCardSubject` 의 그 표: 수는
                알고 명단만 모르는 상태가 실제로 있다), 무엇보다 그 값이 **조용한 실패 판정의
                유일한 출처**다(`AgentTeamRow.memberCount` 의 주석). 두 출처를 섞으면 화면이
                자기가 아는 수와 다른 수를 적는다.

                `팀 ·` 접두를 붙이는 이유: 이 격자에는 팀만 있지만 **탭으로 갈린 형제 격자에
                에이전트가 있다.** 두 묶음을 오가는 화면에서 `5명` 만 적혀 있으면 그것이 팀의
                크기인지 다른 무엇인지 카드 하나만 봐서는 알 수 없다.
              */}
              <div className="mt-auto w-full border-t border-border pt-2">
                <p className="text-meta text-fg-muted">{trans('agents.teams.cardInfo', { count: t.memberCount })}</p>
                {/*
                  **비활성 팀원 한 줄.** `warning` 인 이유가 `AgentGrid` 의 `멈추는 중` 과
                  같다: 나를 막지 않으므로 강조가 아니고(규칙 04 · `accentBudget`), 고장도
                  아니므로 `danger` 가 아니다 — 비활성화는 운영자가 **의도한** 상태다.

                  이름을 적는다. 카드에서 팀원 이름을 나열하지 않는 규칙(*"다섯을 적으면
                  카드가 목록이 된다"*)의 예외이고, 예외인 근거는 이 줄이 답하는 질문이
                  *"누가 안 깨는가"* 라는 것이다 — 수만 적으면(`1명이 비활성`) 사람이 그것을
                  알기 위해 상세를 열어야 하고, `#368` 이 사이드바에서 겪은 것이 정확히
                  그것이다(사유가 툴팁에만 있으면 사람은 찾지 못한다).
                */}
                {off.length > 0 && (
                  <p
                    data-testid={`team-disabled-${t.name}`}
                    className="mt-1 whitespace-normal text-meta text-warning"
                  >
                    {trans('agents.teams.cardDisabled', { names: off.map((m) => m.handle).join(' · ') })}
                  </p>
                )}
              </div>
            </div>
          );
        })}

        {/*
          빈 상태가 **셋**이다. 못 찾은 것과 아무것도 없는 것이 다른 사실인 것은 에이전트
          격자와 같은 짝이고(그 파일), 거기에 *"목록을 못 받았다"* 가 더 붙는다 — 그것을
          `아직 팀이 없다` 로 그리면 화면이 모르는 것을 단언한다(`docs/design.md` §4).

          문구가 **다음 행동을 말한다**: 이 자리에서 사람이 실제로 겪는 것은 "만들었는데
          안 보인다"이고, 그 답은 새로고침이 아니라 서버를 올리는 것이다. `+` 카드는
          남긴다 — 만들기 자체는 그 서버에서도 되고(`POST /teams`), 여기서 손잡이까지
          없애면 만들 수 있는 것을 못 한다고 말하는 반대 방향의 거짓이 된다.
        */}
        {teams === null ? (
          <p
            data-testid="team-list-unavailable"
            className="col-span-full py-6 text-center text-warning"
          >
            {trans('agents.teams.gridUnavailable')}
          </p>
        ) : shown.length === 0 && (
          <p className="col-span-full py-6 text-center text-fg-muted">
            {query.trim()
              ? trans('agents.teams.gridNoMatch', { query: query.trim() })
              : trans('agents.teams.gridEmpty')}
          </p>
        )}
      </div>
    </div>
  );
}

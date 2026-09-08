import { useMemo, useState } from 'react';
import type { AccountView } from '@murmur/shared';
import { Identity } from '../Identity';
import type { RunnerState } from '../../lib/runnerLauncher';
// B1 의 세 얼굴 규칙은 `lib/faceState.ts` 하나가 낸다 — DM 목록도 같은 판정을 쓴다
// (`docs/desktop-rail.html` 2단계). 여기 사본을 두면 두 화면이 같은 러너를 다르게 그린다.
// `isStopping` 은 **격자만** 부른다 — 사이드바가 그 값을 받을 수 없는 이유가 그 함수 주석에 있다.
import { faceState, faceTakesRelaunch, isFaceGreyed, isStopping } from '../../lib/faceState';
// 뒤처짐 판정도 **이미 있는 것을 그대로 쓴다**(`lib/runnerVersions.ts`). 그 규칙
// (*"모르는 것을 뒤처졌다고 하지 않는다"*)을 칩에서 다시 적으면 일괄 재기동 띠와 카드가
// 서로 다른 대상을 고르고, 그 어긋남은 조용하다 — 그 모듈 주석이 정확히 그것을 경고한다.
import { staleRunners } from '../../lib/runnerVersions';
// 경과 계산도 한 벌이다. `AgentsSettings.lastTurnLabel` 이 같은 함수 위에 접두만 붙인다 —
// 이 파일이 그쪽에서 가져올 수 없는 이유(순환)가 `lib/lastTurn.ts` 주석에 있다.
import { lastTurnAgo } from '../../lib/lastTurn';
import { useT, useLocale } from '../../i18n/useT';

/**
 * 이 격자가 카드 하나를 그리는 데 **실제로 필요한 것**. `AgentView` 를 요구하지 않는 이유가
 * `docs/desktop-rail.html` 3단계에 있다 — 사이드바의 에이전트 칸이 같은 카드를 쓰는데, 그
 * 칸이 손에 든 것은 스토어의 `accounts`(`AccountView`)뿐이다. `AgentView` 를 요구하면
 * 사이드바가 그 칸을 그리려고 `listAgents()` 를 한 번 더 왕복해야 하고, 그때부터 같은
 * 에이전트 목록이 **두 곳에 유지된다** — 이 저장소가 반복 결함으로 지목한 그 모양이다.
 *
 * `instructions` 만 옵셔널이다: 검색이 역할 설명까지 훑는 것은 설정 화면의 값이고
 * (*"배포 담당이 누구였더라"*), 스토어의 계정 목록에는 그 필드가 없다. 없으면 이름만
 * 훑는다 — **기능이 조용히 줄어드는 것을 타입이 드러낸다**는 것이 옵셔널로 두는 이유다.
 * `AgentView` 는 `AccountView` 를 확장하고 `instructions` 를 필수로 가지므로 설정 화면의
 * 호출은 한 글자도 안 바뀐다.
 *
 * ## 정보 필드도 같은 규율로 옵셔널이다 (`docs/desktop-agent-cards.pdf` 2쪽)
 *
 * 그 문서가 카드에 올리라고 한 셋(하네스·모델 · 러너 버전 · 마지막 활동)과 다섯 번째
 * 얼굴이 쓰는 둘(`stopRequestedAt`·`stopAckedAt`)은 전부 `AgentConfig` 소속이다 —
 * 스토어의 `AccountView` 에는 **하나도 없다.** 위 문단이 `instructions` 로 세운 판단이
 * 그대로 적용된다: 필수로 올리면 사이드바가 `listAgents()` 를 왕복해야 하고 그때부터
 * 같은 목록이 두 곳에 유지된다.
 *
 * **없으면 그 줄을 안 그린다.** 그리고 애초에 그 줄은 `place === 'settings'` 에서만
 * 그린다(`AgentGridPlace` 주석) — 즉 이 옵셔널은 사이드바가 넘기지 않는다는 사실을
 * 타입에 적어 둔 것이고, 실제 분기는 자리가 낸다. 두 겹인 것이 의도다: 타입만 두면
 * 사이드바가 `AgentView` 를 얻는 날 정보 줄이 조용히 새고, 자리 분기만 두면 사이드바
 * 호출부가 없는 필드를 넘기려 해서 컴파일이 막힌다.
 */
export type AgentCardSubject = AccountView & {
  instructions?: string;
  /** 카드 첫 줄(`하네스`). 없으면 그 줄을 안 그린다. */
  harness?: string;
  /** 하네스 아래 줄. `null` 은 **'하네스 기본값'** 이다(`AgentConfig.model` 의 계약). */
  model?: string | null;
  /** 버전 칩의 값. `null`·`'unknown'` 둘 다 **모른다**다(`runnerVersions.ts` 의 판정). */
  runnerVersion?: string | null;
  /** 다섯 번째 얼굴(종료 요청 중)의 입력. 둘이 함께 와야 뜻이 생긴다 — `isStopping` 참고. */
  stopRequestedAt?: string | null;
  stopAckedAt?: string | null;
  /**
   * `활동` 줄의 값. **문서는 `lastActivityAt` 이라고 적었지만 그 필드는 없다** — 실측하니
   * 서버가 내려 주는 이름은 `lastTurnAt` 이고(`AgentConfig.lastTurnAt`) 이미 목록에 실려
   * 온다. 새 필드도 새 왕복도 필요 없었다.
   */
  lastTurnAt?: string | null;
};

/**
 * 이 격자가 서는 **자리**(`docs/desktop-rail.html` 3단계). 값이 둘인 것은 호출자가 둘이기
 * 때문이고, 그 이상으로 늘릴 축이 아니다 — 늘어나기 시작하면 카드가 다시 두 벌이 된다.
 *
 * **기본값이 `settings` 인 것이 계약이다** — 설정 › 에이전트는 이 prop 을 넘기지 않고,
 * 그래서 그 화면의 모양은 이 축이 생기기 전과 한 픽셀도 다르지 않다(회귀선:
 * `agentsPanelGrid.test.tsx` 의 *"자리를 안 주면 설정의 그 격자다"*).
 *
 * ## 자리마다 갈리는 것은 셋 — 크기 · **바닥색** · **상자**
 *
 * ### 크기 (실측 2026-09-07)
 *
 * 사이드바 패널의 폭은 `MIN_SIDEBAR_WIDTH`(180) ~ 기본 240px(`DEFAULT_PREFS.sidebarWidth`)
 * 이고 `nav` 의 `p-2` 가 좌우 8px 씩 먹으므로 **내용 폭은 164 ~ 224px** 이다.
 * `auto-fill` 이 채우는 열 수는 `트랙 × n + 간격 × (n-1) ≤ 내용 폭` 을 만족하는 최대 n 이다:
 *
 * | 내용 폭 | `settings`(86px 트랙 · 24px 간격) | `sidebar`(64px 트랙 · 12px 간격) |
 * |---|---|---|
 * | 164px (최소) | **1열** — 78px 이 남는다 | 2열 |
 * | 224px (기본) | 2열 | 3열 |
 * | 464px (최대 480 − 16) | 4열 | 6열 |
 *
 * 넘쳐서 깨지지는 않는다 — 카드가 고정 폭이고 이름은 `truncate` 다. 문제는 다른 것이다:
 * **최소 폭에서 한 열이면 그것은 그리드가 아니라 목록**이고, 문서가 목록을 그리드로 바꾸라고
 * 한 자리에서 목록이 되돌아온다.
 *
 * 트랙과 아바타를 **함께** 줄인다. 트랙만 줄이면 56px 아바타가 64px 칸에 갇혀 좌우 4px
 * 밖에 안 남고, 그 폭에서는 `ring-2` 선택 테가 옆 카드에 닿는다. 40px 아바타 + 64px
 * 트랙이면 좌우 12px 이 남는다.
 *
 * ### 바닥색
 *
 * 검색줄은 `sticky` 라 **자기 바닥을 직접 칠해야** 스크롤한 카드가 그 뒤로 지나간다.
 * 그런데 두 자리의 바닥이 다르다 — 설정 화면은 `surface-raised`(카드 면)이고 사이드바는
 * `surface-sunken`(`Sidebar` 의 `aside`)이다. 한쪽 값을 박아 두면 다른 쪽에서 **검색줄만
 * 다른 색인 띠**가 되고, 그것은 하드코딩 색과 같은 종류의 결함이다: 토큰을 쓰고 있어도
 * 자리와 맞지 않으면 틀린 색이다. 선택 테의 `ring-offset` 도 같은 이유로 함께 간다.
 *
 * ### 상자 (2026-09-08 추가)
 *
 * 이 축의 세 번째 칸이고, 위 두 칸과 **같은 이유로** 여기 든다: 자리에 따라 값이 갈리고
 * 한쪽 값을 박아 두면 다른 쪽이 틀린 모양이 된다.
 *
 * 설정의 카드는 흰 면 · 얇은 테두리 · 둥근 모서리 · 안쪽 여백을 받고, **사이드바는 아무것도
 * 받지 않는다.** 갈리는 근거는 *담는 것*이다 — 설정의 카드는 정보 세 줄과 (예외로) 사유
 * 한 줄까지 담는 **그릇**이라 경계가 없으면 그 줄들이 어느 얼굴의 것인지 눈으로 안 묶인다
 * (실측 2026-09-08, 720px 패널 8장: `하네스/러너/활동` 세 줄이 얼굴들 사이에서 흘러다녔고
 * 정보 묶음 위의 구분선만 남아 아무것도 가르지 않는 줄로 읽혔다). 사이드바의 카드가 담는
 * 것은 얼굴과 이름 한 줄뿐이고, 그 자리에서는 상자가 잡음이다 — 얼굴이 이미 서로 떨어진
 * 원이라 경계를 한 번 더 그릴 필요가 없고, 64px 트랙에서 안쪽 여백 12px 을 좌우로 먹으면
 * 40px 얼굴이 들어갈 자리조차 없어진다.
 *
 * ## 정보 블록은 **축을 늘리지 않고** 이 축의 조건부로 얹는다
 *
 * `docs/desktop-agent-cards.pdf` 2쪽이 설정의 카드에 세 줄(하네스·모델 · 러너 · 활동)과
 * 다섯 번째 얼굴을 얹었다. 그런데 위 문단이 못 박은 것 — *"그 이상으로 늘릴 축이 아니다 —
 * 늘어나기 시작하면 카드가 다시 두 벌이 된다"* — 이 이 변경에 그대로 걸린다. `showInfo`
 * 같은 prop 을 하나 더 두면 자리가 셋(`settings`·`sidebar`·`settings 인데 정보 없음`)이
 * 되고, 그 셋을 유지하는 것이 카드 두 벌을 유지하는 것과 같아진다.
 *
 * 그래서 **새 축을 만들지 않는다.** 정보 블록은 `place === 'settings'` 조건부 렌더로
 * 얹는다 — 자리 하나가 크기·바닥색에 이어 *"담는 것"* 까지 가른다는 뜻이고, 위 문단이
 * *"담는 것도 그 축에서 갈린다"* 라고 이미 그 방향을 적어 뒀다(문서 「먼저」절).
 *
 * **실측(2026-09-08): 지금까지 `place` 로 갈리는 조건부 렌더가 하나도 없었다** — 두 자리가
 * `PLACE` 표의 클래스 치환만으로 갈렸고 JSX 는 완전히 같았다. 그래서 기존 회귀선
 * (`agentsPanelGrid.test.tsx` 의 *"자리를 안 주면 설정의 그 격자다"*)은 `place` 를 안 준
 * 기본값만 재고, **새 블록이 사이드바로 새는 것을 잡지 못한다.** 조건부가 처음 생기는
 * 이 변경과 함께 `agentGrid.test.tsx` 에 사이드바 격리 회귀선을 따로 세웠다.
 */
export type AgentGridPlace = 'settings' | 'sidebar';

/**
 * 자리별 클래스. 한 곳에 모아 두는 이유: 네 자리(트랙·카드 폭·아바타·▶ 덮개)가 **맞물린
 * 숫자**를 쓴다 — 하나만 고치면 글리프가 얼굴을 벗어나거나 이름이 옆 칸을 침범한다.
 */
const PLACE: Record<AgentGridPlace, {
  /** 격자의 트랙과 간격 — 열 수를 정하는 숫자다. */
  grid: string;
  /** 카드 한 칸의 폭. 트랙과 **같아야** 한다: 다르면 이름이 옆 칸을 침범한다. */
  card: string;
  /** 아바타 상자(그리고 `+` 의 점선 원). */
  face: string;
  /** 아바타 안의 이니셜·글리프 크기. 상자만 줄이면 40px 원에 18px 글자가 갇힌다. */
  faceText: string;
  /** ▶ · ↻ 덮개. **아바타와 같은 크기**여야 얼굴을 정확히 덮는다. */
  glyph: string;
  /** `sticky` 검색줄의 바닥과 선택 테의 오프셋. 자리의 바닥색과 같아야 한다(위 주석). */
  bg: string;
  ringOffset: string;
  /**
   * **카드 상자** — 흰 면 · 얇은 테두리 · 둥근 모서리 · 안쪽 여백 (`docs/desktop-agent-cards.pdf`
   * 2쪽). 사이드바는 **빈 문자열**이다. 그 이유가 `AgentGridPlace` 주석의 세 번째 절에 있다.
   */
  box: string;
  /**
   * 격자 자체의 바닥. 설정은 한 단 가라앉아 흰 카드가 떠 보이고(목업), 사이드바는 이미
   * 가라앉은 면 위에 서므로 **덧칠하지 않는다**(빈 문자열).
   */
  gridBg: string;
  /** 상자가 없는 자리에서 `+` 칸이 쓰는 점선 원의 유무. 상자가 있으면 점선은 상자로 올라간다. */
  createBox: string;
}> = {
  /*
    ## 설정의 숫자가 바뀐 이유 — 얼굴 56 → **88px** · 트랙 86 → **140px**

    정본 `docs/desktop-agent-cards.pdf` 는 **원칙**이 정본이고 목업은 그 원칙의 한 가지
    답이다. 그래서 이 두 숫자는 목업에서 베낀 것이 아니라 **실측으로 정했다**(2026-09-08,
    720px 폭 설정 패널에 8장을 깔고 브라우저에서 잰 값). 근거를 아래에 남긴다.

    ### 얼굴 88px — 원칙이 요구하는 최솟값이다

    원칙 둘이 이 값을 밀어 올린다: *"사진을 올렸다는 것은 사진을 보겠다는 뜻"* 이고,
    *"버튼 줄이 사라지면서 남는 세로가 얼굴로 간다"*. 지금까지 설정의 얼굴은 `h-14`(56px)
    였다 — 문서가 인용한 *"40px 에서 키운다"* 는 **사이드바 값**이고(아래 `sidebar.face`
    가 `h-10`), 설정은 56 이었다. 실제 증분은 56 → 88 이다.

    88 을 고른 이유는 세 가지가 이 값에서 함께 맞기 때문이다:

    1. **얼굴이 정보 세 줄보다 무거워야 한다.** 화면으로 확인했다 — 88px 에서 얼굴이
       먼저 눈에 들어오고 세 줄이 그 아래 딸린 것으로 읽힌다. 그것이 *"상태는 얼굴이
       말한다"* 가 성립하는 조건이다
    2. **`▶`·`■`·`↻` 가 얼굴을 덮는 원**이라 지름이 곧 그 손잡이의 타격 면적이다. 56px
       에서도 눌리긴 하지만, 손잡이를 세 개로 늘린 지금은 그 면적이 커지는 것이 이득이다
    3. 96(`h-24`)까지 키우면 세 줄이 얼굴에 눌려 **정보가 각주처럼** 보였다

    `h-22` 는 Tailwind 기본 척도에 없어(`h-20`=80 다음이 `h-24`=96) 임의값이다.
    `text-*` 4단 회귀선(`test/typeScale.test.ts`)은 글자 크기만 재므로 대상이 아니다.

    ### 트랙 140px — **내용이 요구하는 폭에서 나왔다**

    처음에 168px 을 썼는데(목업의 비율을 눈으로 옮긴 값) 실측하니 **31px 이 남았다.**
    브라우저에서 정보 줄의 값 칸을 `max-content` 로 재 보니 가장 넓은 것이 뒤처진 버전 칩
    (`v0.1.1 · 뒤처짐 ↻`)의 **93px** 이고, 라벨 36 + 간격 8 을 더해 **137px** 이 카드가
    실제로 필요한 폭이었다. `하네스  claude-code` 는 67px 로 그보다 좁다.

    | 트랙 | 720px 패널에서 열 수 | 남는 폭 | 판단 |
    |---|---|---|---|
    | 168 | 3열 | 128px | 값이 요구하는 137 보다 31px 넓고 한 열을 잃는다 |
    | **140** | **4열** | **60px** | 137 을 만족하는 가장 좁은 4단위 값 |
    | 128 | 4열 | 108px | 137 미달 — 뒤처진 칩이 매번 잘린다 |

    그래서 140 이었다. 얼굴 88px 좌우로 26px 씩 남아 `ring-2` 선택 테가 옆 카드에 닿지
    않고(사이드바가 40/64 로 세운 것과 같은 여유 비율), **한 화면에 한 열이 더 들어온다** —
    *"여러 에이전트를 나란히 놓고 비교할 때만 뜻이 생기는 값"* 을 카드에 올린 것이므로
    한 번에 보이는 카드 수가 곧 이 정보의 값이다.

    ### 트랙 140 → **164px** — 상자의 안쪽 여백이 그만큼을 먹는다 (실측 2026-09-08)

    위 표의 137px 은 **내용이 요구하는 폭**이고, 상자가 생기면서 그 137 이 더 이상 트랙
    전체를 쓰지 못한다. 상자가 좌우로 `p-3`(12px)씩과 테두리 1px 씩을 먹고 `box-border`
    기본값 아래에서 둘 다 트랙 안쪽으로 들어가므로, 트랙에서 **26px 이 내용 밖으로 빠진다.**

    140 을 그대로 두면 내용 폭이 114px 이다. 브라우저에서 되돌려 재 봤다(2026-09-08,
    같은 720px 패널에서 트랙만 140 으로 바꿔):

    | 트랙 | 상자 안 내용 폭 | 러너 값 칸 | 잘린 것 | 720px 열 수 |
    |---|---|---|---|---|
    | 140 | 114px | **70px** | 이름 두 줄(`@…agenthere` 137>114) · 칩이 94 를 70 에 눌린다 | 4열 |
    | **164** | **138px** | **94px** | **없다** | **3열** |

    (앞 두 줄은 브라우저에서 실제로 잰 값이다. 164 를 더 키우지 않은 이유는 계산으로
    충분하다 — 176 이면 3열이 그대로인데 내용 폭만 12px 늘어난다.)

    뒤처진 칩(`v0.1.1 · 뒤처짐 ↻`)의 `max-content` 는 **94px** 이고, 164 트랙의 값 칸이
    정확히 그 94px 이다 — 라벨 36 + 간격 8 을 더한 138 이 위 표의 137 하한을 딱 만족한다.
    140 에서는 값 칸이 70px 밖에 안 되어 그 칩이 눌리고, **이름 두 줄도 함께 잘린다**
    (긴 핸들이 137px 을 요구한다). `truncate` 때문에 둘 다 **조용히** 잘리는, 위 표가
    128px 을 기각한 그 결함이 그대로 돌아온다.

    **한 열을 잃는 것을 받아들였다.** 위 문단이 *"한 번에 보이는 카드 수가 곧 이 정보의
    값"* 이라고 적었으니 열을 잃는 것은 비용이다 — 그런데 잘린 값은 **값이 아니다.**
    140 에서 4열이 서도 그 네 칸의 값이 잘려 있으면 비교할 것이 애초에 없다. 그리고
    1000px 폭에서는 5열이라(실측), 넓은 창에서는 잃는 것이 없다.

    137 하한은 그대로 살아 있다 — 회귀선(`agentGrid.test.tsx`)이 재는 대상이 트랙에서
    **상자 여백 26px 을 뺀 값**으로 바뀌었을 뿐이다. 그 시험이 26 을 어디서 얻는지 함께
    적어 뒀으니 상자 여백을 고치는 사람이 트랙도 같이 고치게 된다.

    ## 상자 — `bg-surface-raised` · `border` · `rounded-lg` · `p-3`

    `p-3`(12px)을 고른 근거는 **선택 링과의 거리**이고, 그것이 실측으로 확인된 값이다
    (2026-09-08, 720px 패널 8장). 선택 링은 `ring-2` + `ring-offset-2` 로 얼굴 바깥
    4px 을 쓰므로, 12px 여백은 링과 상자 테두리 사이에 **8px 을 남긴다** — 화면에서 보니
    두 선이 서로 닿지 않고 각각 다른 것을 말하는 것으로 읽힌다. 이것이 요점이다: 링과
    테두리를 겹치지 않게 한 것이 **자리**(얼굴 원 대 감싸개 사각)이고, 이 여백이 그 두
    자리 사이의 실제 거리다.

    여백을 늘리는 쪽은 트랙과 맞물려 있어 공짜가 아니다 — `p-4`(16px)로 키우면 위 표의
    26px 이 34px 이 되어 트랙을 172px 로 밀어야 137 하한을 지킨다. 즉 이 값은 혼자
    고를 수 없다. 회귀선이 26 을 명시적으로 계산하는 이유가 그것이다.

    `rounded-lg`(8px)는 이 저장소가 이미 쓰는 카드 모서리다(검색 입력이 같은 값) — 새
    반지름을 하나 더 만들지 않는다.

    ## `faceText`·`glyph` 가 타이포 4단이 아닌 이유

    이 둘은 **상자에 묶인 글리프**다 — 원의 지름에서 크기가 따라 나온다. 얼굴이 56 →
    88px 로 커졌으니 안의 머리글자도 함께 커져야 하고, 안 키우면 88px 원에 18px 글자가
    떠 있는 모양이 된다. `test/typeScale.test.ts` 의 `ALLOWED` 가 `Identity.tsx` 에 대해
    같은 판단을 이미 적어 뒀다(*"4단이 아니라 `h-*` 상자에 묶인 글리프다"*). 그래서 이 표의
    다른 칸들과 같은 어휘(척도 이름)를 유지한다 — 여기만 임의값으로 바꾸면 표 안에서
    두 어휘가 섞이고, 다음에 이 표를 고치는 사람이 어느 쪽을 따라야 하는지 알 수 없다.
  */
  settings: {
    grid: 'grid-cols-[repeat(auto-fill,164px)] gap-x-4 gap-y-4',
    card: 'w-[164px]',
    face: 'h-[88px] w-[88px]',
    faceText: 'text-2xl',
    glyph: 'h-[88px] w-[88px] text-2xl',
    bg: 'bg-surface-raised',
    ringOffset: 'ring-offset-surface-raised',
    /* **선 색은 여기 없다** — 실패한 카드가 그 칸만 갈아 끼우므로 호출부가 붙인다
       (감싸개 `div` 의 주석). 색을 여기 박으면 실패 분기가 문자열 치환이 된다. */
    box: 'rounded-lg border bg-surface-raised p-3',
    /* 카드가 흰 면이므로 바닥이 한 단 내려가야 카드가 뜬다 — 설정 패널 자체가
       `surface-raised` 다(`AgentsSettings.tsx`). `p-3` 은 가라앉은 면이 카드에 딱
       붙지 않게 하는 여백이고, `-mx-1` 없이 패널의 `p-5` 안에서 자연히 선다. */
    gridBg: 'rounded-lg bg-surface-sunken p-3',
    createBox: 'rounded-lg border border-dashed border-border p-3',
  },
  sidebar: {
    grid: 'grid-cols-[repeat(auto-fill,64px)] gap-x-3 gap-y-4',
    card: 'w-[64px]',
    face: 'h-10 w-10',
    faceText: 'text-sm',
    glyph: 'h-10 w-10 text-base',
    bg: 'bg-surface-sunken',
    ringOffset: 'ring-offset-surface-sunken',
    /* **상자가 없다** — 담는 것이 얼굴과 이름 한 줄뿐이면 상자는 잡음이다
       (`AgentGridPlace` 주석). 64px 트랙에서 좌우 12px 을 먹으면 40px 얼굴 자리도 없다. */
    box: '',
    gridBg: '',
    createBox: '',
  },
};

/**
 * ▶ · ↻ 의 포커스 표시. **`Menu.tsx` 의 `MENU_ITEM_FOCUS`·`Rail.tsx` 의 `RAIL_FOCUS` 와
 * 같은 조합이다** — 그 파일들이 Tailwind v4 의 함정을 적어 뒀다: `outline-none` 은
 * `--tw-outline-style: none` 을 남기고 `outline-2` 는 굵기만 정하면서 스타일을 그 변수에서
 * 읽으므로, 둘만 쓰면 `focus-visible` 에서도 링이 그려지지 않는다.
 *
 * 이 글리프가 특히 포커스 링을 필요로 하는 이유: **평소 `opacity-50` 으로 숨어 있다.**
 * `focus-visible:opacity-100` 만으로는 "지금 이것이 눌린다"가 아니라 그냥 조금 진해진
 * 글리프이고, 키보드로 격자를 훑는 사람은 카드와 이 버튼 중 어디에 서 있는지 알 수 없다.
 * 링은 안쪽에 그린다 — 얼굴을 정확히 덮는 원이라 바깥으로 밀면 옆 카드와 겹친다.
 */
const GLYPH_FOCUS = 'outline-none focus-visible:opacity-100 focus-visible:outline-solid'
  + ' focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2';

/**
 * 카드 정보 한 줄.
 *
 * ## 왜 이 모양인가 — **이 저장소에 이미 있는 행 컴포넌트를 따른다**
 *
 * `Profile.tsx` 의 `Row` 가 같은 일을 하고 있고 모양이 이것이다: `flex` + **고정 폭
 * 라벨**(`w-24 shrink-0 text-fg-subtle`) + `min-w-0` 값 칸. 새 어휘를 만들지 않고 그
 * 형태를 그대로 가져왔다 — 상세(`Profile`)와 카드가 같은 세 값을 다른 모양으로 적으면,
 * 카드에서 상세로 넘어간 사람이 같은 사실을 두 번 읽는 법을 배워야 한다.
 *
 * 갈리는 것은 숫자 둘뿐이고 둘 다 폭에서 나온다: 라벨이 `w-24`(96px) 대신 `w-9`(36px)
 * 이고 글자가 13px 대신 11px 이다. 카드가 140px 이라 96px 라벨은 값 칸에 44px 만 남긴다.
 *
 * **라벨이 고정 폭인 것이 요점이다.** 세 줄의 값이 같은 x 에서 시작해야 여러 카드를
 * 나란히 놓고 **세로로 훑는 비교**가 되고, 그것이 이 정보를 카드에 올린 이유다. 고정
 * 폭이 아니면 `하네스`(3자)와 `러너`(2자) 때문에 값이 카드 안에서도 지그재그로 선다.
 */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-9 shrink-0 text-meta text-fg-subtle">{label}</span>
      <span className="min-w-0 flex-1 text-meta text-fg-muted">{children}</span>
    </div>
  );
}

/**
 * 러너 버전 칩 3종 (`docs/desktop-agent-cards.pdf` 3쪽).
 *
 * | 상태 | 모양 | 손잡이 |
 * |---|---|---|
 * | **최신** — 앱과 같다 | 회색 칩 `v0.1.3` | 없음 |
 * | **뒤처짐** — 앱보다 낮다 | 주의색 칩 `v0.1.1 · 뒤처짐 ↻` | **칩 자체가 눌린다** |
 * | **모름** — 접속 안 했거나 버전 안 보냄 | 점선 칩 `버전 모름` | 없음 |
 *
 * ## 판정을 새로 쓰지 않는다
 *
 * 셋을 가르는 규칙은 `lib/runnerVersions.ts` 의 `staleRunners()` 가 이미 갖고 있고, 그
 * 규칙의 핵심이 *"모르는 것을 뒤처졌다고 하지 않는다"* 다 — `null`(한 번도 보고 없음)과
 * `'unknown'`(보고는 왔지만 러너가 `AGENT_VERSION` 을 못 받음)은 원인이 다르지만 이
 * 판정에는 같고, 앱 버전을 모르면(`appVersion === null`) **아무것도 뒤처졌다고 하지
 * 않는다.** 그 모듈 주석이 두 번째 이유를 미리 적어 뒀다: *"읽는 곳이 둘이다(프로필 한
 * 에이전트, 설정의 전체 재기동) — 한 곳에 두지 않으면 두 화면이 서로 다른 대상을 고르고,
 * 그 어긋남은 조용하다."* 이제 읽는 곳이 셋이라 그 경고가 더 무겁다.
 *
 * `staleRunners` 는 목록 판정이라 카드 하나를 물으려면 한 원소 배열로 부른다. 그 대신
 * 여기서 `!==` 비교를 손으로 적으면 **네 번째 규칙 사본**이 생긴다 — 배열 하나 만드는
 * 값이 그것보다 싸다.
 *
 * `live` 에 이 에이전트를 **항상 넣는다**: `staleRunners` 의 `live` 는 *"재기동이 할 일인
 * 대상인가"* 를 가르는 축인데(그 함수 주석: 러너가 없으면 재기동은 할 일이 아니다),
 * 카드의 칩이 답하는 질문은 그것이 아니라 *"서버가 마지막으로 들은 버전이 무엇인가"* 다.
 * 러너가 지금 안 도는 카드도 `runnerVersion` 이 남아 있으면 그 값을 말해야 한다 —
 * 아래 `stale` 여부와 무관하게 칩은 늘 선다.
 *
 * ## 재기동이 왜 **얼굴이 아니라 이 칩**에 붙나 (문서)
 *
 * *"얼굴에 붙이면 `↻` 가 **실패**와 **뒤처짐** 두 가지를 뜻하게 되고, 도는 것을 멈출
 * 방법이 사라진다."* 뒤처진 러너는 **잘 돌고 있다** — 얼굴은 `ok`(그냥 사진)이고, 거기에
 * `↻` 를 얹으면 `■`(멈추기)가 설 자리가 없어진다. 다시 띄우는 이유가 버전이므로 손잡이도
 * 버전 옆에 선다.
 *
 * ## 강조색이 아니라 **주의색**이다 (규칙 04)
 *
 * `test/accentBudget.test.tsx` 가 예산을 잰다: 강조는 *"나를 막는 것"* 에만 쓴다. 뒤처진
 * 러너는 나를 막지 않는다 — 잘 돌고 있고, 갈아 끼우는 것은 내가 고를 일이다. 그래서
 * `warning` 이고, 실패는 이미 `danger` 라 둘이 섞이지 않는다.
 */
function VersionChip({ handle, runnerVersion, appVersion, onRelaunch }: {
  handle: string;
  runnerVersion: string | null;
  appVersion: string | null;
  /** 없으면 뒤처진 칩도 안 눌린다 — *"권한 없는 사람에게는 문이 없다"*(`AgentGrid` 주석). */
  onRelaunch?: () => void;
}) {
  // **훅을 이 컴포넌트가 직접 부른다** — 격자에서 `t` 를 prop 으로 내려보내면 카드마다
  // 인자가 하나 늘고, 그 인자는 이 칩이 그리는 세 문구에만 쓰인다. 화면이므로 훅이 맞다
  // (화면 밖 순수 함수만 `Translate` 를 인자로 받는다 — `i18n/index.ts` 머리말).
  const t = useT();
  const { stale, unknown } = staleRunners({
    agents: [{ id: handle, runnerVersion }],
    live: new Set([handle]),
    appVersion,
  });

  // 점선 칩. `버전 모름` 이라고 **적는 것**이 요점이다 — 칩을 아예 안 그리면 "러너가 없다"와
  // 구분되지 않고, 문서가 이 칩을 만든 이유가 정확히 그것이다(*"없으면 매번 상세를 열어야
  // 한다"*). 점선은 `+` 카드가 이미 쓰는 어휘라 "아직 값이 없다"로 읽힌다.
  if (unknown.length > 0) {
    return (
      <span
        data-testid={`agent-version-${handle}`}
        data-version="unknown"
        className="inline-block rounded border border-dashed border-border px-1.5 py-px text-meta text-fg-subtle"
      >
        {t('grid.version.unknown')}
      </span>
    );
  }

  /*
    **여기부터 `runnerVersion` 은 값이 있다.** 위 `unknown` 갈래가 `null` 과 `'unknown'`
    을 다 걸러 냈기 때문인데(`runnerVersions.ts` 의 판정), 그 사실은 `staleRunners` 의
    반환값 안에 있어 타입으로는 흘러나오지 않는다.

    사전을 지나면서 이것이 **드러났다**: 전에는 `{runnerVersion}` 을 그대로 그려 `null`
    이 조용히 빈 칸이 됐고, 지금은 자리표시자 인자라 타입이 막는다. 좁히는 자리를 여기
    한 번 두어 아래 세 갈래가 같은 값을 쓴다 — 갈래마다 `?? ''` 를 적으면 그 셋 중
    하나가 빈 칩을 그리는 날이 온다.
  */
  const version = runnerVersion ?? '';

  // 최신. **회색 칩으로 조용히 적는다** — 정상에는 표시를 붙이지 않는다는 규칙에서 버전은
  // 예외다(문서: *"'맞다'를 확인하러 오는 값"*). 손잡이는 없다: 갈아 끼울 것이 없다.
  if (stale.length === 0) {
    return (
      <span
        data-testid={`agent-version-${handle}`}
        data-version="current"
        className="inline-block rounded bg-surface-sunken px-1.5 py-px text-meta text-fg-muted"
      >
        {t('grid.version.current', { version })}
      </span>
    );
  }

  // 뒤처짐. **칩 자체가 손잡이다**(위 「재기동이 왜 이 칩에」). 누를 수 없는 사람에게는
  // 같은 말을 손잡이 없이 준다 — 사실은 남고 문만 없어진다(design.md §4: 눌러도 아무 일이
  // 없는 버튼을 그리지 않는다).
  /*
    `whitespace-nowrap` 이 **실측으로 필요해진 것**이다 (2026-09-08, 상자가 생긴 뒤).

    이 칩의 `max-content` 는 94px 이고 164px 트랙의 값 칸이 정확히 94px 이다 — 딱 맞는
    것이 곧 위험이다. 브라우저에서 보니 **`v0.1.1 · 뒤 / 처짐 ↻` 로 두 줄이 됐다**:
    소수점 아래 반올림 하나가 감싸임을 만들고, 그러면 그 카드만 키가 커져 한 줄의 카드
    높이가 어긋난다(`h-full`+`mt-auto` 가 맞춰 놓은 그 정렬이다).

    `truncate` 회귀선이 이것을 못 잡는다 — 감싸임은 잘림이 아니라 `scrollWidth` 가
    `clientWidth` 를 넘지 않는다. 그래서 값 자체가 **한 줄임을 선언한다.** 이 칩은
    쪼개지면 뜻이 흐려지는 원자값이다(버전 · 구분점 · 판정 · 손잡이가 한 덩어리다).
  */
  const shape = 'inline-block whitespace-nowrap rounded border border-warning-border'
    + ' bg-warning-surface px-1.5 py-px text-meta text-warning';
  if (!onRelaunch) {
    return (
      <span data-testid={`agent-version-${handle}`} data-version="stale" className={shape}>
        {t('grid.version.stale', { version })}
      </span>
    );
  }
  return (
    <button
      data-testid={`agent-version-${handle}`}
      data-version="stale"
      // 색은 스크린리더에 아무 말도 하지 않는다(`#443`). 칩 글자가 `↻` 로 끝나므로 그것이
      // 무엇을 하는 것인지 접근 이름이 말해야 한다.
      aria-label={t('grid.version.staleAction', { handle, version })}
      // 포커스 링을 따로 안 붙인다 — 전역 `:focus-visible`(`index.css`)이 준다. `GLYPH_FOCUS`
      // 는 **얼굴 글리프 전용**이다: 그것들은 `opacity-50` 으로 숨어 있어 `opacity-100` 을
      // 함께 켜야 하는데(그 상수 주석), 이 칩은 평소에도 또렷하므로 그 조합이 필요 없다.
      className={`${shape} hover:bg-warning-surface-strong`}
      onClick={(e) => { e.stopPropagation(); onRelaunch(); }}
    >
      {t('grid.version.stale', { version })} <span aria-hidden="true">{'↻'}</span>
    </button>
  );
}

/**
 * 에이전트 그리드 + 검색(identity 문서 · Task 15-2).
 *
 * ## 카드는 조용하다 — **사이드바에서** (`docs/desktop-agent-cards.pdf` 「먼저」절)
 *
 * 앞 문서가 세운 규칙이 이것이었다: *"이 화면에서는 정보를 더하는 쪽이 항상 지는 쪽이다."*
 * 그래서 카드에는 아바타와 이름만 남고 하네스·소유자·마지막 활동이 전부 상세로 내려갔다.
 *
 * **카드 문서가 그 규칙의 겨누는 자리를 다시 읽었다.** 그 문장이 서 있던 자리는 **사이드바
 * 패널**이다 — 폭이 164~224px 이고, 훑는 것이 목적이고, 40개가 깔린다. 설정은 다르다:
 * *"설정은 바꾸러 오는 곳이고, 바꾸기 전에 확인하러 오는 곳이다."* 그래서 **앞 규칙을
 * 뒤집는 것이 아니라** 같은 컴포넌트가 두 자리에서 다르게 서는 것이고, 그 축은 이미
 * 타입에 적혀 있다(`AgentGridPlace`).
 *
 * 설정의 카드가 올리는 것은 **셋뿐이다**:
 *
 * ```
 * 하네스   claude-code       ← AgentConfig.harness · model (null 이면 `하네스 기본값`)
 *          sonnet-4.6
 * 러너     v0.1.3            ← 버전 칩 3종 (VersionChip)
 * 활동     11분 전            ← lastTurnAt (문서는 `lastActivityAt` 이라 적었다 — 없는 필드다)
 * ```
 *
 * 셋의 공통점이 문서에 있다 — *"여러 에이전트를 나란히 놓고 비교할 때만 뜻이 생기는
 * 값"* 이다. 하나만 볼 때 필요한 것(작업 디렉터리·소유자·멘션 권한·지시문)은 상세에
 * 남는다. **소유자는 여전히 안 올린다**: 한 사람이 다 만든 워크스페이스에서는 모든 카드가
 * 같은 값이라 구별에 아무 기여도 하지 않는다.
 *
 * ## 상태는 사진이 말한다 — **상태 글자는 여전히 없다**
 *
 * 상태 점도 상태 글자도 없다. 정보 세 줄이 늘었어도 그 규칙은 그대로다: 셋 중 어느 것도
 * *"도는 중"* 이 아니다. 얼굴이 다섯 가지로 갈리고(아래), 글자를 받는 것은 **예외 둘**뿐이다 —
 * 실패 사유(`PAT 가 폐기되었다`)와 종료 요청 중(`멈추는 중 · 러너가 아직 못 봤다`).
 *
 * **카드 아래 버튼 줄은 없다.** 문서가 *"걷어내라"* 고 적었지만 **실측(2026-09-08)하니
 * 그 버튼이 애초에 없었다** — 이 격자에 있는 버튼은 검색 입력 · `+` 카드 · 카드 자체 ·
 * 얼굴을 덮는 글리프 넷이고, 카드 아래에 서는 `실행하기`·`멈추기` 줄은 한 번도 만든 적이
 * 없다. 문서가 겨눈 것은 앞 판본의 목업이었을 것이다. 즉 이 항목은 이미 지켜져 있다.
 *
 * ## 검색은 이름만 훑지 않는다
 *
 * `@handle` 과 **역할 설명**(`instructions`)을 함께 훑는다 — "배포 담당이 누구였더라"를
 * 이름을 모르는 채로 찾을 수 있어야 검색이 목록을 대신한다. 설명은 카드에 안 보이지만
 * 찾을 때는 쓰인다.
 *
 * ## 두 자리가 이 컴포넌트를 쓴다 (`docs/desktop-rail.html` 3단계)
 *
 * 설정 › 에이전트와 **레일의 에이전트 칸**이다. 문서가 그 순서를 못 박았다: *"설정 ›
 * 에이전트 재설계가 먼저 들어가야 카드 컴포넌트를 두 번 그리지 않는다."* 그래서 두 자리가
 * 갈리는 곳은 넷뿐이고, 전부 **prop 으로 명시된다** — 자리(`place`: 크기와 바닥색), 카드를
 * 누르면 무엇이 열리는가(`onPick`), 만들기 문을 여는가(`canCreate`), 누가 ▶ 를 받는가
 * (`canRelaunch`). 나머지(가나다 순서 · 검색 · 다섯 얼굴 · 사유 글자)는 두 화면에서 같아야
 * 하므로 여기 한 벌만 있다.
 *
 * ## 얼굴 하나가 상태와 손잡이를 겸한다 (`docs/desktop-agent-cards.pdf` 2쪽 하단)
 *
 * | 상태 | 얼굴 | 손잡이 |
 * |---|---|---|
 * | 도는 중 | 그냥 사진 | 없음(평소) |
 * | 도는 중 · 올렸을 때 | `■` | **`■` 로 멈춘다** |
 * | **멈추는 중** | 점선 테 · 반쯤 빠짐 | **없다** |
 * | 멈춤 | 색 빠짐 + `▶` | `▶` 로 켠다 |
 * | 실패 | 붉은 테 + `↻` | `↻` 로 다시 · 사유는 글자 |
 *
 * **`■` 만 hover/focus 에서 뜨는 이유**(문서): *"멈추기는 훑는 동작이 아니다. 지금 켤 수
 * 있는 것이 몇 개인지는 스캔 한 번에 와야 하지만(그래서 `▶` 는 늘 보인다), 멈출 것은 이미
 * 고른 다음에 찾는다."* 그 대가는 마우스가 없으면 안 보이는 것이라, 키보드는
 * `focus-visible` 에서 뜬다 — `GLYPH_FOCUS` 가 그 조합을 이미 갖고 있다.
 */
export function AgentGrid<T extends AgentCardSubject>({
  agents, selectedId, runnerStates, online, connected, onPick, onCreate, canCreate, onRelaunch,
  canRelaunch, onStop, appVersion = null, place = 'settings',
}: {
  agents: T[];
  selectedId: string | null;
  runnerStates: Record<string, RunnerState>;
  /** 지금 붙어 있는 에이전트들. `connected` 가 false 면 이 목록은 '모른다'다. */
  online: string[];
  connected: boolean;
  onPick(agent: T): void;
  onCreate(): void;
  canCreate: boolean;
  /** ▶ · ↻ 가 부르는 것. 없으면 그 자리를 그리지 않는다(권한 없는 사람에게는 문이 없다). */
  onRelaunch?(agent: T): void;
  /**
   * **`■` 가 부르는 것** — 도는 러너에게 종료를 요청한다. 없으면 `■` 를 안 그린다:
   * `onRelaunch` 와 같은 규율이고(*"권한 없는 사람에게는 문이 없다"*), 사이드바는 이것을
   * 넘기지 않으므로 그 칸에는 오늘처럼 `▶`·`↻` 만 있다.
   *
   * **`onRelaunch` 와 합치지 않는 이유**: 부르는 API 가 다르다(`requestStop` 대
   * `reissueRunnerPat`)고, 무엇보다 **되돌리기 어려움이 다르다** — 멈추기는 진행 중인 턴을
   * 기다렸다가 러너를 내리고, 다시 띄우기는 없는 것을 세운다. 한 콜백에 얼굴 상태로 분기를
   * 심으면 그 판단이 호출자 쪽으로 새고, 호출자마다 다르게 적힌다.
   */
  onStop?(agent: T): void;
  /**
   * 버전 칩의 **기준값**. 이 앱 번들의 버전이고 스토어가 갖고 있다(`appStore.ts` 의
   * `appVersion`, `AgentsSettings` 의 `StaleRunnerBar` 가 이미 같은 값을 읽는다).
   *
   * 기본값 `null` 이 계약이다 — `staleRunners` 가 `null` 을 **"아무것도 뒤처졌다고 하지
   * 않는다"** 로 읽으므로(그 함수 주석), 이 prop 을 안 넘기는 호출자(사이드바)에게는
   * 뒤처짐 판정이 애초에 일어나지 않는다. 비교 기준이 없는데 단정하는 것이
   * `docs/design.md` §4 가 금지하는 거짓 신호다.
   */
  appVersion?: string | null;
  /**
   * **이 카드가 ▶ 를 받는가.** 없으면 `onRelaunch` 가 있는 모든 카드가 받는다 — 그것이
   * 설정 화면의 오늘 동작이고 기본값으로 남는다.
   *
   * 왜 `onRelaunch` 의 유무만으로 안 되는가: 콜백은 격자 전체에 **하나뿐인 값**이라
   * 카드마다 다르게 줄 수 없다. 그런데 띄울 권한은 카드마다 갈린다(관리자이거나 내가
   * 소유한 에이전트). 이 술어가 없으면 하나라도 띄울 수 있는 사람에게는 **띄울 수 없는
   * 카드에도 ▶ 가 그려지고**, `AgentGrid` 가 세운 규칙(*"권한 없는 사람에게는 문이
   * 없다"*)이 "권한 없는 카드에는" 으로는 지켜지지 않는다.
   */
  canRelaunch?(agent: T): boolean;
  /** 이 격자가 선 자리. 기본값 `settings` 가 설정 화면의 오늘 모양이다(`AgentGridPlace` 주석). */
  place?: AgentGridPlace;
}) {
  const [query, setQuery] = useState('');
  // 이 격자의 말은 전부 `grid.*` 를 지난다. 활동 경과만 `lib/time.ts` 가 낸다 —
  // *"숫자는 `Intl` 이, 뜻은 사전이"*.
  const t = useT();
  const locale = useLocale();
  const s = PLACE[place];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? agents.filter((a) =>
        a.handle.toLowerCase().includes(q)
        || a.displayName.toLowerCase().includes(q)
        // 설명은 카드에 안 보이지만 찾을 때는 쓰인다(문서). 없는 자리(사이드바의 계정
        // 목록)에서는 이름만 훑는다 — `AgentCardSubject` 주석에 그 이유가 있다.
        || (a.instructions ?? '').toLowerCase().includes(q))
      : agents;
    // **가나다 고정**(문서가 정한 것). 상태순으로 정렬하면 켜지고 꺼질 때마다 카드가 자리를
    // 옮겨 위치로 기억하는 것이 불가능해진다 — 상태는 이미 사진이 말하고 있다.
    return [...matched].sort((a, b) => a.handle.localeCompare(b.handle));
  }, [agents, query]);

  return (
    <div className="flex min-h-0 flex-col">
      {/* 검색은 **화면 맨 위 고정**이다 — 목록이 길어져도 찾는 수단이 스크롤 밖으로 나가지 않는다. */}
      <div className={`sticky top-0 z-10 ${s.bg} pb-4`}>
        <div className="relative">
          <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle">⌕</span>
          <input
            data-testid="agent-search"
            aria-label={t('grid.search.label')}
            className="w-full rounded-lg border border-border bg-field py-2 pl-8 pr-14
                       text-fg placeholder-fg-subtle"
            placeholder={t('grid.search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* 개수는 **검색창 안**이다(목업) — 몇 개를 뒤지고 있는지가 찾기 전에 보여야 한다. */}
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-meta text-fg-subtle">
            {t('grid.search.count', { count: shown.length })}
          </span>
        </div>
      </div>

      {/*
        **격자 바닥이 한 단 가라앉는다**(목업 2쪽: 카드가 살짝 어두운 면 위에 떠 있다).
        설정 패널 자체가 `surface-raised`(흰 면)이므로 흰 카드가 그 위에 서면 **테두리
        하나로만** 갈리는데, 화면으로 확인하니(720px 8장) 그 선이 카드를 묶기엔 약했다 —
        면 차이가 먼저 오고 테두리가 경계를 마무리하는 것이 목업의 순서다.

        **검색줄은 이 바닥을 받지 않는다.** 그것은 이 격자의 형제이고 패널의 흰 면 위에
        서므로 `PLACE.bg` 가 그 자리에서 여전히 `surface-raised` 다(그 칸의 계약: 자리의
        바닥색과 같아야 한다). 가라앉는 것은 격자뿐이다.
      */}
      <div data-testid="agent-grid" className={`grid ${s.grid} ${s.gridBg} overflow-y-auto`}>
        {/*
          `+` 는 **맨 앞**이다. "그리드의 마지막 칸"으로 두면 40개일 때 그 칸이 스크롤 끝이라
          찾아가야 한다. 맨 앞이면 개수와 무관하게 자리가 고정되고, 검색으로 목록이 비어도
          `+` 는 그대로 있다.
        */}
        {canCreate && (
          /*
            ## 점선이 **원에서 상자로 올라간다** (목업 2쪽 첫 칸)

            여기 있던 주석은 *"목업처럼 점선도 원이다 — 사각 점선은 옆의 둥근 얼굴들과
            다른 종류로 읽힌다"* 였고, **상자가 없던 격자에서는 그것이 맞았다**: 옆 칸에
            사각형이 하나도 없으니 사각 점선만 종류가 달랐다.

            지금은 옆 칸이 전부 **실선 상자**다. 그러니 같은 형태(둥근 상자)를 점선으로 두는
            것이 "여기는 아직 카드가 아니다"를 말하는 가장 싼 방법이고, 목업이 정확히 그렇게
            했다. 원에 점선을 남기면서 상자에도 점선을 두면 점선이 카드 하나에 두 겹이 되어
            빈 자리가 채워진 자리보다 시끄러워진다 — 그래서 **원의 점선은 걷어냈다.**

            **면은 받지 않는다**(`createBox` 에 `bg-*` 가 없다): 흰 면을 주면 채워진 카드로
            읽히고, 가라앉은 격자 바닥이 그대로 비쳐야 빈 자리다. `h-full` 로 그 줄의 카드와
            키를 맞춘다 — 목업의 첫 칸도 옆 카드와 같은 높이로 선다.

            **사이드바에서는 원의 점선이 그대로 남는다.** 그 자리에는 상자가 없으므로
            (`createBox` 가 빈 문자열) 점선이 올라갈 곳이 없고, 위 문단의 근거 — *"옆 칸이
            전부 실선 상자다"* — 가 성립하지 않는다. 즉 지워진 옛 주석의 판단이 **그 자리에서는
            여전히 맞다**: 옆에 사각형이 없으니 점선은 원이어야 한다. 상자의 유무가 그 갈림을
            그대로 낸다.
          */
          <button
            data-testid="agent-create"
            className={`group flex h-full ${s.card} ${s.createBox} flex-col items-center
                        justify-center gap-2 text-fg-subtle hover:border-fg-subtle hover:text-fg`}
            onClick={onCreate}
          >
            {s.createBox ? (
              <span aria-hidden="true" className={`${s.faceText} leading-none`}>+</span>
            ) : (
              <span
                className={`flex ${s.face} items-center justify-center rounded-full border
                            border-dashed border-border group-hover:border-fg-subtle`}
              >
                <span aria-hidden="true" className={`${s.faceText} leading-none`}>+</span>
              </span>
            )}
            <span className="text-meta text-fg-muted">{t('grid.search.create')}</span>
          </button>
        )}

        {shown.map((a) => {
          const face = faceState(a.id, runnerStates, online, connected);
          /*
            **다섯 번째 얼굴은 별개의 축이다** (`lib/faceState.ts` 의 `isStopping` 주석).

            `FaceState` 유니온에 값을 더하지 않은 이유가 그 주석에 있다 — 두 필드는
            `AgentConfig` 소속이라 사이드바가 손에 든 `AccountView` 에는 없고, 사이드바가
            받을 수 없는 값을 유니온에 앉히면 *"이 넷은 각각 그리는 방법이 다르다"* 는
            `FaceState` 의 계약이 거짓이 된다. 그래서 축이 둘이고 여기서 곱해진다.

            **`ok` 위에만 얹는다.** 문서: *"`stopRequestedAt` 은 있고 `stopAckedAt` 이
            없는 동안은 도는 것도 멈춘 것도 아니다."* 즉 이것은 **도는 중**의 변형이다 —
            이미 `stopped`·`failed`·`unknown` 인 얼굴을 덮으면 더 강한 사실(러너가 죽었다 ·
            생사를 모른다)을 약한 사실로 가린다. 특히 `unknown` 을 덮으면 서버와 끊긴 동안
            "멈추는 중"이라고 단정하는 셈인데, 그것은 아무도 확인하지 않은 말이다.

            사이드바에서는 `a.stopRequestedAt` 이 `undefined` 라 `isStopping` 이 false 를
            낸다 — **필드가 없으면 이 축 자체가 서지 않는다.** 그리고 그 위에 자리 분기가
            한 겹 더 있다(`AgentGridPlace` 주석의 두 겹 이유).
          */
          const stopping = place === 'settings' && face === 'ok' && isStopping({
            stopRequestedAt: a.stopRequestedAt ?? null,
            stopAckedAt: a.stopAckedAt ?? null,
          });
          /*
            **`■` 를 누를 수 있는가.** 도는 중이고, 종료 요청이 아직 안 걸려 있고, 문이
            있어야 한다. `stopping` 을 뺀 것이 요점이다 — 문서가 그 줄에 *"손잡이가 없다"*
            고 적었다(*"지금 할 수 있는 일이 기다리는 것뿐이다"*). 이미 요청한 것을 한 번 더
            요청하는 버튼은 아무 일도 하지 않으면서 사람에게 "안 먹었나" 를 묻게 만든다.
          */
          const canStop = place === 'settings' && onStop !== undefined && face === 'ok' && !stopping;
          return (
            /*
              **`h-full` + `mt-auto` 가 한 줄의 구분선을 맞춘다** (실측 2026-09-08, 720px
              폭에서 8장을 깔아 확인).

              처음에는 이것이 없었고, 화면을 보니 **같은 줄의 구분선이 서로 다른 높이에
              떠 있었다** — 이름이 한 줄인 카드와 두 줄인 카드, 그리고 `멈추는 중` 글자를
              얻은 카드가 각각 다른 높이를 가지니 그 아래 정보 묶음도 따라 밀렸다. 세 줄을
              **나란히 놓고 비교하는 것**이 이 정보를 카드에 올린 이유인데, 값이 서로 다른
              y 에 있으면 그 비교가 눈으로 안 된다.

              그리드 칸은 기본으로 `stretch` 되므로 카드가 `h-full` 을 받고 정보 묶음이
              `mt-auto` 로 바닥에 붙으면, 한 줄에서 가장 키가 큰 카드가 높이를 정하고 나머지
              카드의 정보 묶음이 **그 높이에 맞춰 같은 y 로 내려온다.**
            */
            /* `gap-2` 가 최소 간격이고 `mt-auto` 가 남는 만큼을 더 밀어낸다 — 여백이 0 인
               카드(그 줄에서 가장 키가 큰 것)에서도 구분선이 이름줄에 붙지 않는다. */
            /*
              ## 상자는 **여기**에 선다 — `button` 이 아니라 감싸개다

              정보 묶음이 카드 `button` **밖**이다(버전 칩이 `button` 이라 중첩이 안 된다 —
              아래 그 블록의 주석). 상자를 `button` 에 두면 정보 세 줄과 사유 한 줄이 상자
              **밖**에 남아, 상자를 그리기 전과 똑같이 흘러다닌다. 그래서 둘을 함께 감싸는
              이 `div` 가 상자를 받는다.

              **그 덕에 선택 링과 상자 테두리가 애초에 같은 선에 서지 않는다**(실측
              2026-09-08): 링은 얼굴 원에 남고(반지름이 다르다) 테두리는 이 사각 상자에
              선다. 둘 사이 거리는 상자 안쪽 여백 12px 에서 링 굵기 2px 과 오프셋 2px 을
              뺀 8px 이고, 화면에서 확인하니 두 선이 닿지 않는다. 선택을 상자 테두리로
              옮기면 그 카드는 "선택됐다"가 아니라 "테두리가 두꺼워졌다"로 읽힌다.

              **실패는 이 테두리가 색을 받는다**(목업 2쪽 `forge`). 그리고 얼굴에 있던
              `ring-2 ring-state-stuck` 은 **걷어냈다** — 화면으로 확인한 판단이다: 둘 다
              칠하면 붉은 것이 카드 하나에 두 개가 되고, 그 카드가 격자에서 고장 그 자체보다
              시끄러워진다(문서: *"정보를 더하는 쪽이 항상 지는 쪽"*). 상자를 남긴 이유는
              그것이 **사유 글자까지 감싼다**는 것이다 — 실패는 이 격자에서 유일하게 글자가
              늘어나는 상태이므로, 테두리가 얼굴과 그 글자를 한 묶음으로 잡아 주는 일이
              얼굴만 두르는 것보다 많다. `↻` 손잡이는 얼굴에 남아 색을 갖는다.

              `danger-border` 이고 `state-stuck` 이 아닌 이유: 이 자리는 **상자의 선**이고
              그 역할의 토큰이 이미 있다(`--app-danger-border`, "오류 상자의 선"). 얼굴 링이
              쓰던 `state-stuck` 은 면 색과 같은 무게라 1px 선에 쓰면 과했다 — 같은 축의
              값이므로 뜻은 그대로다(`index.css`: `state-stuck` 은 `danger` 와 같은 축).

              사이드바에서는 `s.box` 가 빈 문자열이라 이 `div` 는 오늘 그대로 아무 상자도
              받지 않는다.
            */
            <div
              key={a.id}
              data-testid={`agent-box-${a.handle}`}
              /* 폭이 **감싸개로 올라온다**: 상자가 트랙과 정확히 같은 폭이어야 하고
                 (`PLACE.card` 의 계약: 다르면 이름이 옆 칸을 침범한다), `box-border` 기본값
                 아래에서 `p-3` 과 테두리가 그 안쪽으로 들어간다. 상자가 없는 자리에서는
                 이 폭이 오늘 카드 `button` 이 갖던 것과 같은 값이라 모양이 안 바뀐다. */
              className={`group relative flex h-full ${s.card} flex-col items-center gap-2 ${s.box} ${
                /* 상자가 없는 자리(사이드바)에서는 색칠할 선도 없다 — `s.box` 가 빈
                   문자열이면 이 칸도 비운다. 그러지 않으면 테두리 없는 카드에
                   `border-danger-border` 만 붙는, 아무것도 그리지 않는 클래스가 남는다. */
                s.box ? (face === 'failed' ? 'border-danger-border' : 'border-border') : ''
              }`}
            >
              <button
                data-testid={`agent-card-${a.handle}`}
                data-selected={selectedId === a.id}
                data-face={face}
                /*
                  **판정을 시험이 읽는 자리가 얼굴과 갈려 있다.** `data-face` 에 `stopping`
                  을 섞지 않는 이유는 위 `stopping` 주석과 같다 — 그것은 `faceState` 의 답이
                  아니고, 섞으면 사이드바의 `dm-face-*` 와 값 집합이 달라져 두 화면을 같은
                  이름으로 검사하던 규율(`Sidebar.tsx` 의 `data-face` 주석)이 깨진다.
                */
                data-stopping={stopping ? 'true' : undefined}
                /*
                  ## 여기 있던 "상자를 그리지 않는다" 는 **판단이 바뀌었다** (2026-09-08)

                  지워진 주석은 이렇게 적혀 있었다: *"**얼굴이 주인공이다**(문서: '얼굴만
                  남긴다'). 카드 상자를 그리지 않는다 — 목업에는 테두리도 면도 없고 **원과
                  이름**만 있다. 상자를 두면 26개가 깔릴 때 격자 선이 얼굴보다 먼저 눈에
                  들어온다."*

                  **그 판단이 틀린 것이 아니라, 그것이 인용한 목업이 앞 문서의 것이다.**
                  `desktop-agent-identity` 의 얼굴 그리드에는 정말로 테두리도 면도 없었고,
                  카드가 담는 것이 **얼굴과 이름 둘**뿐이었다. 그 조건에서 상자는 잡음이
                  맞다 — 얼굴이 이미 서로 떨어진 원이라 경계를 한 번 더 그릴 필요가 없다.

                  `docs/desktop-agent-cards.pdf` 2쪽이 그 조건을 바꿨다. 카드가 **네 종류를
                  담는 그릇**이 됐다: 얼굴 · 이름 두 줄 · 정보 세 줄 · (예외로) 사유 한 줄.
                  담는 것이 넷이 된 뒤에는 상자가 **필수**다. 화면으로 확인했다(720px 패널
                  8장, 2026-09-08): 상자가 없으면 `하네스/러너/활동` 세 줄이 어느 얼굴의
                  것인지 눈으로 안 묶이고, 정보 묶음 위의 구분선만 남아 카드를 가르는 선이
                  아니라 아무것도 가르지 않는 줄로 읽힌다. 그 목업도 흰 면 · 얇은 테두리 ·
                  둥근 모서리 · 안쪽 여백으로 카드를 갈라 놨다.

                  즉 규칙이 뒤집힌 것이 아니라 **규칙이 겨누던 조건이 바뀌었다.** 그리고 그
                  옛 판단은 지금도 살아 있다 — 담는 것이 여전히 얼굴과 이름뿐인
                  **사이드바**에서다(`PLACE.sidebar.box` 가 빈 문자열인 이유).

                  상자가 이 `button` 이 아니라 **감싸개 `div`** 에 서는 이유는 그쪽 주석에
                  있다(정보 묶음이 이 `button` 밖이다). 그래서 여기서 갈리는 것은 폭뿐이다:
                  상자가 안쪽 여백을 가졌으므로 이 `button` 은 고정 폭이 아니라 `w-full` 로
                  상자를 채운다 — `s.card` 를 그대로 두면 164px 이 138px 상자 안을 넘친다.
                */
                className={`group flex ${s.box ? 'w-full' : s.card} flex-col items-center gap-2`}
                onClick={() => onPick(a)}
              >
                {/*
                  **실패의 붉은 테는 여기 없다 — 상자 테두리로 옮겼다**(감싸개 `div` 의
                  주석에 화면으로 확인한 근거가 있다). 여기 있던 `ring-2 ring-state-stuck`
                  을 상자와 함께 두면 붉은 것이 카드 하나에 둘이 된다.

                  **상자가 없는 자리에서는 얼굴이 그 일을 계속한다**: 사이드바는 `s.box` 가
                  빈 문자열이라 색칠할 테두리가 없으므로, 실패를 말할 곳이 얼굴뿐이다.
                  즉 붉은 테는 없어진 것이 아니라 **상자가 있는 자리에서만 상자로 올라갔다** —
                  `+` 칸의 점선이 원에서 상자로 올라간 것과 같은 규율이다.
                */}
                <span
                  className={`relative block rounded-full ${
                    !s.box && face === 'failed' ? 'ring-2 ring-state-stuck' : ''
                  } ${
                    /*
                      **멈추는 중은 점선 테다**(목업 2쪽 하단 세 번째 칸). 실선 테는 실패
                      (`ring-state-stuck`)와 선택(`ring-accent`)이 이미 쓰는 어휘이고, 점선은
                      `+` 카드가 "아직 값이 없다"로 쓰는 어휘다 — 확정되지 않은 상태에 맞다.
                      `ring-*` 에는 점선이 없어 `border-dashed` 를 쓰고, 테가 사진을 잘라
                      먹지 않도록 `p-0.5` 로 한 겹 띄운다.
                    */
                    stopping ? 'border border-dashed border-fg-subtle p-0.5' : ''
                  } ${selectedId === a.id ? `ring-2 ring-accent ring-offset-2 ${s.ringOffset}` : ''}`}
                >
                  {/*
                    멈춘 사진은 **색이 빠진다** — 장식을 더하는 것이 아니라 덜어 낸다.
                    `grayscale` 만으로는 부족하다: 어두운 색(예: blue-500)은 회색조로 바꿔도
                    **거의 검정**이 되어 목업의 중간 회색과 달라지고, 흰 글리프가 그 위에서
                    과하게 도드라진다. 그래서 밝기를 함께 올려 **중간 회색**으로 모은다.
                  */}
                  {/* `#443`: `unknown` 도 색이 빠진다 — 초록으로 두는 것이 이 이슈다.
                      `stopped` 와 **같은 회색**인 것은 의도다: 다른 회색을 하나 더 만들면
                      사람이 두 회색을 구분해 외워야 하고, 그 부담은 이 정보의 무게보다 크다.
                      두 상태를 가르는 것은 색이 아니라 **▶ 의 유무와 글자**다(아래). */}
                  {/* 멈추는 중은 **반쯤** 빠진다(목업). 완전히 빼면 `stopped` 와 같은 회색이
                      되어 "이미 멈췄다"로 읽히는데, 그 러너는 아직 턴을 돌리고 있을 수 있다.
                      같은 필터를 절반 세기로 쓴다 — 새 회색을 하나 더 만들지 않는다. */}
                  <span
                    className={isFaceGreyed(face)
                      ? 'block grayscale brightness-[1.7] contrast-[0.55] opacity-90'
                      : stopping
                        ? 'block grayscale-[0.5] brightness-[1.35] contrast-[0.78] opacity-95'
                        : 'block'}
                  >
                    <Identity account={a} className={`${s.face} ${s.faceText}`} variant="avatar" />
                  </span>
                </span>
                {/*
                  **이름과 `@handle` 이 갈린다**(목업 2쪽: 굵은 `alpha` 아래 옅은 `@alpha`).
                  설정에서만이다 — 사이드바는 내용 폭이 164px 부터라 두 줄을 세울 자리가 없고,
                  오늘처럼 `@handle` 한 줄이다.

                  왜 설정에서는 둘인가: 이 화면은 **바꾸러 오는 곳**이라 사람이 부르는 이름
                  (`displayName`)과 채널에서 부르는 이름(`handle`)이 다를 수 있고, 그 둘이
                  다르다는 사실 자체가 확인하러 온 값이다. 사이드바는 말을 거는 곳이라
                  부르는 이름 하나면 된다.
                */}
                {place === 'settings' ? (
                  <span className="w-full">
                    <span
                      className={`block w-full truncate text-center text-body font-semibold ${
                        face === 'ok' ? 'text-fg' : 'text-fg-subtle'
                      }`}
                    >
                      {a.displayName}
                    </span>
                    <span className="block w-full truncate text-center text-meta text-fg-subtle">
                      @{a.handle}
                    </span>
                  </span>
                ) : (
                  <span
                    className={`w-full truncate text-center text-meta ${
                      face === 'ok' ? 'text-fg' : 'text-fg-subtle'
                    }`}
                  >
                    {a.handle}
                  </span>
                )}
              </button>

              {/*
                ## 정보 세 줄 — **설정에서만** (`AgentGridPlace` 주석)

                이 블록이 이 컴포넌트의 **첫 `place` 조건부 렌더**다. 축을 늘리는 대신 자리
                하나에 조건을 매다는 이유가 그 주석에 있고, 사이드바로 새지 않는 것을
                `agentGrid.test.tsx` 의 사이드바 격리 회귀선이 잡는다.

                카드 `button` **밖**이다: 안에 넣으면 버전 칩(뒤처짐일 때 `button`)이
                `button` 안의 `button` 이 되어 HTML 이 깨진다. 그리고 구분선이 얼굴·이름
                묶음과 정보 묶음을 가르는 것이 목업의 구조다.
              */}
              {place === 'settings' && (
                /* `mt-auto` 가 한 줄의 구분선을 같은 y 로 맞춘다 — 이유는 위 `h-full` 주석. */
                /* 폭은 상자가 정한다 — `s.card` 를 여기 두면 164px 이 138px 상자 안을
                   넘친다(카드 `button` 의 그 문단과 같은 이유). `w-full` 하나면 된다. */
                <div className="mt-auto w-full border-t border-border pt-2">
                  {/* `harness` 가 없으면 그 줄을 안 그린다 — 없는 것을 있다고 하지 않는다
                      (design.md §4). 설정 화면은 `AgentView` 를 넘기므로 늘 있다. */}
                  {a.harness !== undefined && (
                    <InfoRow label={t('grid.card.harness')}>
                      <span className="block truncate">{a.harness}</span>
                      {/* **모델이 `null` 이면 `하네스 기본값`**(`AgentConfig.model` 의 계약).
                          빈 칸으로 두면 "모델을 모른다"로 읽히는데, `null` 은 모르는 것이
                          아니라 **하네스가 고른다는 결정**이다. */}
                      <span className="block truncate text-fg-subtle">
                        {a.model ?? t('grid.card.harnessDefault')}
                      </span>
                    </InfoRow>
                  )}
                  {a.runnerVersion !== undefined && (
                    <InfoRow label={t('grid.card.runner')}>
                      <VersionChip
                        handle={a.handle}
                        runnerVersion={a.runnerVersion}
                        appVersion={appVersion}
                        /* 뒤처진 칩이 부르는 것은 `▶`·`↻` 와 **같은 콜백**이다 — 하는 일이
                           같다(러너를 새 번들로 다시 띄운다). 권한 술어도 같은 것을 본다:
                           문이 없어야 할 사람에게 버전 칩만 문이 되면 `canRelaunch` 가
                           세운 규칙이 한 자리에서 새는 것이다. */
                        onRelaunch={onRelaunch && (canRelaunch?.(a) ?? true)
                          ? () => onRelaunch(a)
                          : undefined}
                      />
                    </InfoRow>
                  )}
                  {a.lastTurnAt !== undefined && (
                    <InfoRow label={t('grid.card.lastTurn')}>
                      {/* 계산은 `lib/lastTurn.ts` 한 벌이다 — 상세의 `lastTurnLabel` 이 같은
                          함수 위에 접두만 붙인다. 여기서 접두를 빼는 이유는 왼쪽 `활동`
                          라벨이 이미 그 말을 하기 때문이다(그 모듈 주석). */}
                      <span className="block truncate">{lastTurnAgo(a.lastTurnAt, Date.now(), locale, t)}</span>
                    </InfoRow>
                  )}
                  {/*
                    **종료 요청 중만 글자를 하나 더 받는다**(문서: *"글자는 그때만 한 줄
                    선다"*). 얼굴의 점선 테는 "확정되지 않았다"까지만 말하고, **무엇을
                    기다리는 중인지**는 말하지 못한다. 그 사실이 `stopAckedAt` 이 아직
                    `null` 이라는 것이라, 문구가 그것을 그대로 적는다 — 러너가 못 본 것이지
                    요청이 실패한 것이 아니다.

                    `warning` 인 이유: 나를 막지 않는다(강조색 예산, 규칙 04). 그리고 고장도
                    아니다 — `danger` 로 두면 실패와 같은 무게로 읽힌다.
                  */}
                  {stopping && (
                    <p
                      data-testid={`agent-stopping-${a.handle}`}
                      className="mt-1 whitespace-normal text-meta text-warning"
                    >
                      {t('grid.card.stopping')}
                    </p>
                  )}
                  {/*
                    **물러나는 중은 글자로 말한다**(2026-09-08 실측). 회색만으로는
                    `stopped`(꺼졌다)와 구분되지 않고, 사람은 회색을 보면 켜려 한다 —
                    `#443` 이 `unknown` 에 대해 세운 그 규율이다. 그날 이 자리에 읽을
                    글자가 하나도 없었던 것이 오해의 절반이었다.

                    `warning` 이 아니라 `accent` 인 이유: 실패가 아니라 **진행 중**이다.
                    `RunnerStatus` 의 `TONE` 이 같은 판단으로 `restarting` 을 `accent` 에
                    두고 있고, 같은 사실을 두 색으로 말하지 않는다.
                  */}
                  {face === 'retiring' && (
                    <p
                      data-testid={`agent-retiring-${a.handle}`}
                      className="mt-1 whitespace-normal text-meta text-accent"
                    >
                      {t('grid.card.retiring')}
                    </p>
                  )}
                </div>
              )}

              {/*
                **▶ · ↻ · ■ 는 카드와 다른 동작이다.** 카드를 누르면 설정이 열리고 이것을
                누르면 러너가 뜨거나 물러난다 — 겹쳐 두면 우연히 눌린다. 그래서 카드 위에
                따로 얹는다. 정상(`running`·`adopted`)에는 **평소** 아무것도 없다: 정상이
                기본값이므로 표시를 붙이지 않는다(40개 중 38개가 그 모습이면 화면이 조용하다).
                아래 `■` 가 그 규칙을 지키면서 손잡이를 더하는 방법이다 — 평소 `opacity-0`.

                **멈추는 중에는 아무 손잡이도 없다**(목업 2쪽 하단 세 번째 칸). 두 곳이 각자
                그것을 아는 것이 아니라 위쪽 `stopping`·`canStop` 두 값이 한 번씩 정했다:
                `face` 가 `ok` 라 아래 `▶`·`↻` 조건에 안 들고, `canStop` 이 `stopping` 을
                빼므로 `■` 도 안 선다.
              */}
              {/* `#443`: `unknown` 에는 ▶ 를 **달지 않는다.** ▶ 는 "눌러서 켜라"인데,
                  지금 도는지 모르는 것을 켜라고 권하면 이미 도는 러너를 하나 더 띄우게
                  된다 — `#430` 의 중복이 바로 그 모양이었다. 모를 때 화면이 할 일은
                  행동을 권하는 것이 아니라 **모른다고 말하는 것**이다. */}
              {/* `canRelaunch` 를 안 준 호출자에게는 오늘 동작 그대로다(그 prop 주석). */}
              {onRelaunch && (canRelaunch?.(a) ?? true) && faceTakesRelaunch(face) && (
                /*
                  **글리프는 사진 안에 있다**(문서: "실행하기 버튼도 사라진다 — 사진 안으로
                  들어간다"). 그래서 뱃지가 아니라 얼굴을 덮는 원이고, 평소에는 **옅게** 얹혀
                  사진을 가리지 않는다. 마우스를 올리면 또렷해진다 — 누를 수 있다는 것이
                  그때 분명해지면 충분하고, 26개가 깔린 화면에서 26개의 진한 글리프는 소음이다.

                  카드와 **다른 동작**이라는 것은 그대로다: 카드를 누르면 설정이 열리고
                  이것을 누르면 러너가 뜬다.
                */
                <button
                  data-testid={`agent-relaunch-${a.handle}`}
                  aria-label={face === 'failed'
                    ? t('grid.card.relaunchFailed', { handle: a.handle })
                    : t('grid.card.relaunch', { handle: a.handle })}
                  className={`absolute left-1/2 top-0 flex ${s.glyph} -translate-x-1/2 items-center
                              justify-center rounded-full leading-none opacity-50 transition
                              group-hover:opacity-100 ${GLYPH_FOCUS} ${
                                face === 'failed' ? 'text-state-stuck' : 'text-fg'
                              }`}
                  onClick={(e) => { e.stopPropagation(); onRelaunch(a); }}
                >
                  <span aria-hidden="true">{face === 'failed' ? '\u21bb' : '\u25b6'}</span>
                </button>
              )}

              {/*
                ## `■` — 평소에는 **없는 것과 같다** (목업 2쪽 하단 두 번째 칸)

                문서가 이 비대칭에 값을 매겼다: *"멈추기는 훑는 동작이 아니다. 지금 켤 수
                있는 것이 몇 개인지는 스캔 한 번에 와야 하지만(그래서 `▶` 는 늘 보인다),
                멈출 것은 이미 고른 다음에 찾는다."* 그래서 `▶`·`↻` 가 쓰는 `opacity-50`
                (평소 옅게 보임)이 아니라 **`opacity-0`**(평소 안 보임)이다.

                **대가는 마우스가 없으면 안 보이는 것**이고, 그 대가를 키보드에서 치르지
                않는다 — `GLYPH_FOCUS` 가 `focus-visible:opacity-100` 을 이미 갖고 있다.
                그 상수가 만들어진 이유가 정확히 이것이었다(그 주석: *"평소 `opacity-50` 으로
                숨어 있다 … 키보드로 격자를 훑는 사람은 카드와 이 버튼 중 어디에 서 있는지
                알 수 없다"*). 여기서는 숨는 정도가 더 깊으니 그 필요도 더 크다.

                `▶`·`↻` 와 배타적이다: 조건이 `face === 'ok'`(`canStop`)이고 그쪽은
                `face !== 'ok'` 라 한 카드에 둘이 함께 서는 경우가 없다.
              */}
              {canStop && onStop && (
                <button
                  data-testid={`agent-stop-${a.handle}`}
                  aria-label={t('grid.card.stop', { handle: a.handle })}
                  className={`absolute left-1/2 top-0 flex ${s.glyph} -translate-x-1/2 items-center
                              justify-center rounded-full leading-none text-fg opacity-0 transition
                              group-hover:opacity-100 ${GLYPH_FOCUS}`}
                  onClick={(e) => { e.stopPropagation(); onStop(a); }}
                >
                  <span aria-hidden="true">{'\u25a0'}</span>
                </button>
              )}
            </div>
          );
        })}

        {/* 검색 결과가 비었을 때. 목록이 비어 있는 것과 **못 찾은 것**은 다른 사실이다.
            크기를 안 적어 본문단 13px 을 물려받는다 — 그리드가 비면 이 한 줄이 그 자리의
            내용 전부다. 카드 안의 꼬리표들이 아랫단이라고 이 줄까지 내리면, 아무것도
            못 찾았을 때 화면에서 가장 작은 글자가 유일한 설명이 된다. */}
        {shown.length === 0 && (
          <p className="col-span-full py-6 text-center text-fg-muted">
            {query.trim()
              ? t('grid.search.noMatch', { query: query.trim() })
              : t('grid.search.empty')}
          </p>
        )}
      </div>

      {/*
        **실패만 글자를 받는다.** 문서: "유일하게 글자가 늘어나는 상태다. #368 이 사이드바에서
        겪었듯 사유가 title 툴팁에만 있으면 사람은 그것을 찾지 못한다. 예외에만 글자를 쓴다."
      */}
      {shown.filter((a) => runnerStates[a.id]?.status === 'failed').map((a) => (
        <p
          key={a.id}
          data-testid={`agent-runner-failed-${a.id}`}
          className="mt-2 whitespace-normal text-meta text-danger"
        >
          {/* 사유(`message`)는 **`lib/runnerLauncher.ts` 가 낸다** — 이 파일 밖이라 감싸는
              틀만 사전을 지난다(`en.ts` 의 grid 머리말 '안 넣은 것'). 사유가 있고 없고로
              문구를 가르는 것은 `sidebar.runner.launchFailed` 와 같은 모양이다. */}
          @{a.handle} {runnerStates[a.id]?.message
            ? t('grid.runner.launchFailedReason', { reason: runnerStates[a.id]!.message! })
            : t('grid.runner.launchFailed')}
        </p>
      ))}

      {/*
        `#476`: **하네스가 없어 물러난 러너도 글자를 받는다.**

        `#473` 이 사유 문구를 만들었지만 그것이 닿는 자리는 사이드바 하나였고, 이 격자는
        `needs_harness` 를 `failed` 로도 안 쳐서 얼굴조차 멀쩡했다. **새 사용자의 기본
        상태가 이것이다**(`claude`·`codex` 는 사용자가 직접 설치한다, 2026-09-06 결정) —
        가장 흔한 상태가 화면에서 가장 조용했다.

        `실패`(danger)와 색을 가르는 이유: 이것은 고장이 아니라 **설치가 아직 안 된 것**이고,
        사람이 할 일이 분명하다. `RunnerStatus.tsx` 의 `TONE` 이 같은 판단을 이미 적어 뒀다.
      */}
      {shown.filter((a) => runnerStates[a.id]?.status === 'needs_harness').map((a) => (
        <p
          key={a.id}
          data-testid={`agent-runner-harness-${a.id}`}
          className="mt-2 whitespace-normal text-meta text-warning"
        >
          {/* 러너가 사유를 주면 **그것이 이긴다** — 사전의 문구는 그 값이 없을 때만 선다. */}
          @{a.handle} {runnerStates[a.id]?.message ?? t('grid.runner.harnessMissing')}
        </p>
      ))}

      {/*
        `#443`: **모른다는 것도 글자로 말한다.**

        얼굴에서 색을 빼는 것만으로는 `stopped`(꺼졌다)와 구분되지 않고, 사람은 회색을
        보면 켜려 한다. 무엇을 모르는지, 그리고 **왜 모르는지**를 한 줄로 준다 —
        사유를 알면 사람은 러너를 뒤지는 대신 연결을 본다.

        한 줄로 묶는 이유: 끊기면 남의 러너가 **전부** 이 상태가 된다. 40줄이 깔리면
        그것이 곧 소음이고, 소음은 읽히지 않는다.
      */}
      {(() => {
        const unknown = shown.filter((a) => faceState(a.id, runnerStates, online, connected) === 'unknown');
        if (unknown.length === 0) return null;
        return (
          <p data-testid="agent-presence-unknown" className="mt-2 whitespace-normal text-meta text-fg-muted">
            {t('grid.runner.presenceUnknown', { count: unknown.length })}
          </p>
        );
      })()}
    </div>
  );
}

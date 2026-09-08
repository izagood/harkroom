import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * **타이포를 4단으로 고정한다** — 정본 문서 `docs/desktop-design-directions.html` 의 공통
 * 위생 항목("타이포 4단 · 회색 3단 · 강조 1색").
 *
 * ```
 * text-meta   11px  로우·상태·시간
 * text-body   13px  본문
 * text-name   15px  이름줄
 * text-title  17px  화면 제목
 * ```
 *
 * 지키는 것은 보기 좋음이 아니라 **단이 단으로 남는 것**이다. 10px 이 하나 남으면 그 자리는
 * "11px 보다 작아도 되는 자리"가 되고, 다음 화면이 그것을 보고 10px 을 또 쓴다. 실제로 이
 * 저장소는 그렇게 10px 을 59 곳까지 늘렸다 — 아무도 10px 을 단으로 정한 적이 없는데.
 *
 * 그래서 "치환했다"가 아니라 **"지금 4단 밖이 없다"**를 단언한다. `colorTokens.test.ts` 가
 * 색에 대해 같은 태도를 갖고 있고(그 파일이 이 파일의 본이다), 그 회귀선이 새로 들어오는
 * PR 의 `zinc-` 를 실제로 잡아 왔다.
 *
 * **이제 4단은 `@theme` 토큰이다**(2026-09-08, `src/index.css`). 그래서 이 파일이 재는
 * 것이 뒤집혔다: **임의값 `text-[11px]` 이 위반**이고, 토큰 이름이 정본이다.
 *
 * ## 왜 이 순서였는가 — 앞 판들이 이 자리를 두 번 미뤘다
 *
 * 이 파일의 두 앞 판이 각각 "아직 아니다"라고 적어 뒀고, 그 조건이 이번에 갖춰졌다.
 *
 * **첫 판**(임의값만 잠갔다)은 아래 `SCALE_NAME` 자리에 이렇게 적었다: *"임의값 4단이
 * 189곳, 척도 이름이 220곳이고 `index.css` 는 척도를 재정의하지 않는다 — 그 220곳은 v4
 * 기본값 12 / 14 / 16px 이라 4단 중 아무것도 아니다. 다음 단계는 척도 이름 220곳을 4단으로
 * 옮기는 것이고, 그것이 끝나야 `@theme` 이 한 벌을 가리킬 수 있다."*
 *
 * **둘째 판**(#588)이 그 220곳을 옮겼고, 그러고도 토큰을 미뤘다: *"어휘가 한 벌이 된 것은
 * 사실이지만, 그 한 벌은 지금 임의값이고 토큰을 넣으면 이름이 하나 더 생긴다. 토큰은 이
 * 회귀선이 한동안 초록으로 버틴 뒤에 하는 일이다."*
 *
 * **이 판이 그 마지막 걸음이다.** 미룬 이유가 사라진 것이 아니라 **조건이 참이 됐다**:
 * 실측(2026-09-08, `origin/main`) 4단 임의값이 379곳(11px 329 · 13px 31 · 15px 17 ·
 * 17px 2)으로 **한 벌**이었고, 코드의 척도 이름 17곳은 전부 상자 글리프 예외였다. 한 벌을
 * 통째로 옮기면 셋째 어휘가 생기지 않는다 — 색 토큰(#112)이 통한 이유와 같다. `zinc-` 를
 * **한 곳도 남기지 않았기** 때문에 "토큰이 정본"이라는 말이 참이 됐고, 절반만 옮겼다면
 * 그 말은 거짓이었을 것이다.
 *
 * 옮긴 결과: 379곳 중 **376곳이 토큰**이 되고 3곳은 `ALLOWED` 로 남았다(`TeamGrid` 의
 * 44px 얼굴 둘과 `TeamMemberPicker` 의 짝 — 15px 이지만 이름줄이 아니라 원의 지름이다).
 *
 * ## 이름을 숫자가 아니라 역할로 지었다
 *
 * `text-17` 은 값을 다시 적는 것이라 표기만 바뀌고 **뜻은 안 생긴다** — 자리를 고르는
 * 사람이 여전히 "몇 px 이 어울리나"를 고민한다. 역할로 부르면 크기가 아니라 뜻을 고른다.
 * `TeamGrid` 의 44px 얼굴이 그 차이가 드러난 자리다: 값이 15px 로 같은데도 `text-name` 을
 * 쓰지 않는다. 이름줄이 아니라 원의 지름이고, 얼굴을 줄이는 날 4단이 끌려가면 안 된다.
 * 값이 같아도 **뜻이 다르면 다른 이름**이다. 이 저장소의 색 토큰이 이미 그쪽이다.
 *
 * ## 무엇을 재고 무엇을 안 재는가
 *
 * 이 파일은 이제 넷을 잰다: ① 임의값이 4단 값을 적지 않는다(토큰을 써라) ② 4단 밖 임의값도
 * 여전히 위반이다(예외만 통과) ③ 척도 이름은 여전히 위반이다 ④ **토큰이 넷뿐이고 그 값이
 * 17 / 15 / 13 / 11 이다** — 마지막 것은 `index.css` 를 직접 읽어서 잰다. 다섯째 토큰이
 * 생기면 4단이 다섯 단이 되고, 그때 이 파일이 빨개지지 않으면 아무도 안 막는다.
 *
 * **예외는 줄 단위로 적는다.** 파일 전체를 면제하면 그 파일에 새로 들어오는 크기까지
 * 조용히 통과한다.
 */
// `import.meta.url` 은 jsdom 환경에서 패키지 밖을 가리킨다 — vitest 의 cwd(패키지 루트)를 쓴다.
const SRC = `${resolve(process.cwd(), 'src')}/`;

/**
 * 4단 — **토큰 이름과 그 값**. 이 표가 `src/index.css` 의 `@theme` 과 일치하는지는 아래
 * 별도 단언이 소스를 읽어 잰다. 여기 적어 두는 것만으로는 두 곳이 갈라질 수 있다.
 */
const SCALE = { title: 17, name: 15, body: 13, meta: 11 } as const;

/** 값만 필요한 자리. */
const SCALE_PX: number[] = Object.values(SCALE);

/**
 * `text-[13px]` 같은 임의 크기 유틸리티.
 *
 * **이제 4단 값이어도 위반이다** — 이 판에서 뒤집힌 규칙이다. 앞 판까지는 임의값이 정본
 * 어휘라 숫자가 4단 안이기만 하면 통과했지만, 토큰이 생긴 지금 `text-[13px]` 은 토큰과
 * 같은 값을 **다른 이름으로** 부르는 것이라 어휘가 둘이 된다. 4단 밖 숫자(10·12·8px)는
 * 전과 같이 위반이고, 그 자리는 `ALLOWED` 에 근거와 함께 적혀 있다.
 *
 * 즉 임의 크기는 이제 **전부** 걸리고, 통과하는 길은 `ALLOWED` 하나뿐이다.
 */
const ARBITRARY = /(?<![\w-])(?:[a-z-]+:)*text-\[(\d+(?:\.\d+)?)px\]/g;

/**
 * **Tailwind 척도 이름도 4단 밖이다** — 이 규칙이 이번에 새로 생겼다.
 *
 * 앞 판(임의값만 잠갔던 것)은 여기에 이렇게 적어 뒀다: *"실측 — 임의값 4단이 189곳,
 * 척도 이름이 220곳이고 `index.css` 는 척도를 재정의하지 않는다. 즉 그 220곳은 v4
 * 기본값 그대로 12 / 14 / 16px 이라 4단 중 아무것도 아니다. 화면은 지금 두 벌로 돌아간다.
 * 다음 단계는 척도 이름 220곳을 4단으로 옮기는 것이고, 그것이 끝나야 `@theme` 이 한 벌을
 * 가리킬 수 있다."*
 *
 * **그 다음 단계가 끝났다**(실측 2026-09-08, #588): 척도 이름 227곳 중 216곳을
 * 4단으로 옮기고 11곳(상자에 묶인 글리프)만 `ALLOWED` 에 남겼다. 그래서 이 정규식을
 * 켠다 — 켜지 않으면 다음 PR 이 `text-sm` 을 다시 들고 오고, 방금 없앤 두 번째 어휘가
 * 조용히 되살아난다. 색 회귀선(`colorTokens.test.ts`)이 `zinc-` 에 대해 하는 일과 같다.
 *
 * `text-xl` 처럼 **지금 이 저장소에 없는 이름까지** 넣는다. 없는 것을 잡는 규칙은 비용이
 * 0 이고, 있는 것만 잡으면 다음 사람이 `text-xl` 을 처음 들고 올 때 아무도 안 막는다.
 * 잡지 않는 것은 크기가 아닌 `text-*`(`text-fg`·`text-center`·`text-left`)뿐이다.
 *
 * **v4 기본 척도를 덮어쓰지 않는다.** `--text-sm: 13px` 로 재정의하면 이 정규식을 끄고
 * `text-sm` 을 그냥 쓸 수도 있지만, 그러면 그 이름이 Tailwind 문서의 14px 과 다른 값을
 * 갖게 되어 **어휘가 둘인 채로 남는다**(이름은 하나인데 뜻이 둘이다). 새 이름을 만드는
 * 쪽이 그 함정을 피한다 — `text-title`·`text-name`·`text-body`·`text-meta` 는 이
 * 저장소에서만 뜻을 갖고, 무엇을 가리키는지 `index.css` 한 곳에 적혀 있다.
 */
const SCALE_NAME = /(?<![\w-])(?:[a-z-]+:)*text-(xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g;

/**
 * 남긴 예외. **줄 내용까지 적는다** — 그 줄이 바뀌면 예외가 죽고 테스트가 그것을 알려 준다.
 *
 * 세 종류뿐이다:
 *
 * 1. **아바타 원 안의 머리글자** — 4단이 아니라 `h-*` 상자에 묶인 글리프다. 크기가 원의
 *    지름에서 따라 나오므로(`h-12`→16px, `h-8`→14px, `h-5`→10px, `h-4`→8px) 단으로
 *    끌어올리면 지름은 그대로인데 글자만 커진다. 근거는 `Identity.tsx` 의 주석에 길게
 *    적어 뒀고, `AgentGrid.tsx` 의 `faceText`·`glyph` 표가 같은 규칙을 표로 갖고 있다.
 * 2. **등폭 글꼴의 12px** — 본문단 13px 을 *광학적으로* 맞추는 보정이다. 등폭은 같은 pt
 *    에서 산세리프보다 크게 보여, 13px 로 두면 옆의 13px 본문보다 한 단 커 보인다.
 *    단을 어긴 것이 아니라 단을 지키기 위해 한 단 내린 것이다.
 * 3. ~~레일의 이모지 아이콘~~ — **없어졌다.** 그 자리는 이제 선 아이콘(`RailIcons.tsx`)이고
 *    지름을 `width`/`height` 가 정하므로 글자 크기의 예외가 아니다.
 *
 * **1 은 척도 이름 쪽에도 그대로 적용된다**. `AgentGrid.tsx` 의 주석이 그 근거를 이미
 * 적어 뒀다: *"여기만 임의값으로 바꾸면 표 안에서 두 어휘가 섞이고, 다음에 이 표를 고치는
 * 사람이 어느 쪽을 따라야 하는지 알 수 없다."* 그래서 상자 글리프는 임의값으로 옮기지도
 * 않고 척도 이름을 그대로 두고 예외로 적는다 — `h-*` 와 짝을 이루는 자리라 Tailwind 의
 * 상대 척도가 오히려 그 짝을 읽기 쉽게 한다.
 *
 * **네 번째 종류가 이 판에서 생겼다: 값이 4단과 같은 상자 글리프**(`TeamGrid` 의 44px
 * 얼굴 셋). 앞 판까지 이 셋은 예외일 필요가 없었다 — 임의값이고 15px 이 4단 안이라 규칙에
 * 안 걸렸다(그 사정이 `TeamGrid.tsx` 주석에 적혀 있었다). 임의값 자체가 위반이 된 지금
 * 걸리기 시작했고, **토큰으로 옮기는 대신 예외로 남긴다**: 15px 이라는 값이 같을 뿐 이
 * 자리의 뜻은 이름줄이 아니라 44px 원의 지름이다. `text-name` 을 부르면 얼굴 크기를
 * 바꾸는 날 4단의 이름줄이 함께 끌려간다. **값이 같아도 뜻이 다르면 다른 이름**이고,
 * 그 판단이 토큰 이름을 역할로 지은 이유와 같다.
 */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  {
    file: 'components/Identity.tsx',
    contains: 'rounded-full bg-fg-subtle text-[10px] font-semibold',
    why: '아바타 원(h-5) 안의 `?` 글리프 — 상자에 묶인 크기다',
  },
  {
    file: 'components/Identity.tsx',
    contains: "overflow-hidden rounded-full text-[10px] font-semibold text-fg-on-strong ${avatarUrl ? 'bg-surface-hover' : handleColor(account.handle)}",
    why: '아바타 원(h-5) 안의 머리글자 — 사람·에이전트 두 분기가 같은 줄을 쓴다',
  },
  {
    file: 'components/Inbox.tsx',
    contains: '<Identity account={accounts[e.authorId]} className="mt-0.5 h-5 w-5 text-[10px]"',
    why: '아바타 상자(h-5)와 글리프를 한 쌍으로 넘기는 호출부',
  },
  {
    file: 'components/ThreadParticipants.tsx',
    contains: '<Identity account={a} className="h-5 w-5 text-[10px]"',
    why: '같은 쌍 — h-5 상자에는 10px 글리프',
  },
  {
    file: 'components/MessageItem.tsx',
    contains: '<Identity account={accounts[id]} className="h-4 w-4 text-[8px]"',
    why: '겹친 참여자 아바타(h-4)의 글리프 — 더 작은 상자에는 더 작은 글리프',
  },
  {
    file: 'components/MessageItem.tsx',
    contains: 'flex h-4 w-4 items-center justify-center rounded-full bg-surface-hover text-[8px]',
    why: '그 줄 끝의 `+N` — 옆 아바타와 같은 h-4 상자이므로 같은 글리프 크기',
  },
  {
    file: 'components/ReportCard.tsx',
    contains: "mono ? 'font-mono text-[12px]' : ''",
    why: '등폭 보정 — 본문 13px 과 광학적으로 같게 만드는 한 단 아래',
  },
  {
    file: 'components/Profile.tsx',
    contains: "mono ? 'font-mono text-[12px]' : ''",
    why: '같은 등폭 보정(본문 13 / mono 12)',
  },
  {
    file: 'components/settings/SkillsSettings.tsx',
    contains: 'border border-border bg-surface p-3 font-mono text-[12px] text-fg',
    why: '같은 등폭 보정 — 스킬 본문은 읽는 글자이고 등폭이라 한 단 내렸다',
  },
  // ↓ 척도 이름 쪽의 상자 글리프. 위 임의값 예외와 **같은 판단**이고, 이 회귀선이 척도
  //   이름을 잡기 시작한 이번 판에서 새로 등록된 것이다.
  {
    file: 'components/MessageItem.tsx',
    contains: '<Identity account={author} className="h-8 w-8 text-sm" variant="avatar" />',
    why: '거터 아바타(h-8)의 머리글자 — 32px 원에 묶인 글리프다',
  },
  {
    file: 'components/settings/TeamDetail.tsx',
    contains: '<Identity account={accounts[m.accountId]} className="h-8 w-8 text-sm" variant="avatar" />',
    why: '같은 h-8 짝 — 팀 상세의 팀원 줄 얼굴(`docs/desktop-agent-cards.html` 4단계)',
  },
  {
    file: 'components/Profile.tsx',
    contains: '<Identity account={account} className="h-12 w-12 text-base" variant="avatar" />',
    why: '프로필 겹창의 큰 아바타(h-12) — 48px 원에 묶인 글리프다',
  },
  {
    file: 'components/settings/AgentsSettings.tsx',
    contains: '<Identity account={selected} className="h-12 w-12 text-base" variant="avatar" />',
    why: '같은 h-12 짝 — 에이전트 상세의 얼굴',
  },
  {
    file: 'components/settings/ProfileSettings.tsx',
    contains: '<Identity account={me ?? undefined} className="h-10 w-10 text-base" variant="avatar" />',
    why: '내 프로필의 아바타(h-10) — 40px 원에 묶인 글리프다',
  },
  {
    file: 'components/settings/AgentGrid.tsx',
    contains: "faceText: 'text-2xl',",
    why: '설정 그리드의 88px 얼굴 안 머리글자 — 얼굴이 커지면 함께 커져야 한다',
  },
  {
    file: 'components/settings/AgentGrid.tsx',
    contains: "glyph: 'h-[88px] w-[88px] text-2xl',",
    why: '같은 88px 상자의 `+` 글리프 — 상자와 한 문자열로 묶여 있다',
  },
  {
    file: 'components/settings/AgentGrid.tsx',
    contains: "faceText: 'text-sm',",
    why: '사이드바 그리드의 40px 얼굴 안 머리글자 — 같은 표의 한 단 아래 칸',
  },
  {
    file: 'components/settings/AgentGrid.tsx',
    contains: "glyph: 'h-10 w-10 text-base',",
    why: '같은 40px 상자의 `+` 글리프',
  },
  // **레일 칸의 이모지 예외는 사라졌다**(2026-09-08). 네 칸의 그림이 선 아이콘이 되면서
  //   (`RailIcons.tsx`) 크기를 `width`/`height` 속성이 정한다 — 글자 크기가 아니므로 척도의
  //   예외로 등록할 것이 남지 않는다. 예외 목록은 짧을수록 좋고, 사라진 예외는 지운다.
  {
    file: 'components/Rail.tsx',
    contains: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-raised text-sm font-bold',
    why: '레일의 커뮤니티 표식(h-9) 안 머리글자 — 36px 원에 묶인 글리프다',
  },
  {
    file: 'components/CommunityRail.tsx',
    contains: 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold',
    why: '전환기 타일(h-10) 안 머리글자 — 40px 원에 묶인 글리프다',
  },
  // ↓ **값이 4단과 같은 상자 글리프**(위 넷째 종류). 임의값이 위반이 된 이 판에서 새로
  //   등록됐고, 토큰으로 옮기지 않는 이유는 15px 이 이름줄이 아니라 44px 원의 지름이기
  //   때문이다 — 근거는 `TeamGrid.tsx` 의 `FACE` 주석에 길게 적혀 있다.
  {
    file: 'components/settings/TeamGrid.tsx',
    contains: "const FACE = 'h-11 w-11 text-[15px]';",
    why: '팀 카드의 겹친 얼굴(h-11) 안 머리글자 — 44px 원의 지름에서 따라 나온 값이다',
  },
  {
    file: 'components/settings/TeamGrid.tsx',
    contains: '<span aria-hidden="true" className="text-[15px] leading-none">+</span>',
    why: '같은 44px 상자의 `+` 글리프 — 얼굴 넷을 넘을 때의 `+N` 자리',
  },
  {
    file: 'components/settings/TeamMemberPicker.tsx',
    contains: '<Identity account={a} className="h-11 w-11 text-[15px]" variant="avatar" />',
    why: '같은 h-11 짝 — 팀원 고르는 화면의 얼굴이 팀 카드와 같은 지름이다',
  },
];

/**
 * **아직 못 고친 부채.** `Sidebar.tsx` 는 다른 작업이 동시에 고치고 있어 이번에 건드리지
 * 않았다. 0 이 아닌 수를 적어 두는 이유: 예외로 적으면 영구 면제가 되고, 빼면 이 파일이
 * 지금 빨개진다. 숫자로 붙잡아 두면 **줄면 통과하고 늘면 빨개진다** — 그 사이에 누가
 * 10px 을 새로 들고 와도 잡힌다. 그 작업이 끝나면 이 항목을 지운다.
 */
// **비어 있다 — 부채를 다 갚았다**(2026-09-07). `Sidebar.tsx` 의 10px 28곳이 여기 있었다.
// 병렬 작업(찾기를 맨 위로)이 그 파일을 동시에 고치던 동안만 미뤄 둔 것이고, 그 작업이
// 머지된 뒤 27곳(그 사이 돋보기 한 줄이 사라졌다)을 전부 11px 로 올렸다.
//
// 자리마다 무엇인지 보고 판단했다 — 전부 **읽는 글자**였다(오류 문구·안내·멤버 이름·
// 저장소 이름·미읽음 개수). 아바타 원 안의 글리프처럼 상자에 묶인 크기는 없었다.
const PENDING: { file: string; count: number; why: string }[] = [];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** 예외 목록에 그 줄로 적혀 있는가. 파일만 맞고 내용이 다르면 예외가 아니다. */
function isAllowed(relative: string, line: string): boolean {
  return ALLOWED.some((a) => relative === a.file && line.includes(a.contains));
}

/**
 * 주석은 재지 않는다. 이 저장소는 **근거를 코드 옆에 적는 관례**라 주석이 크기를
 * 인용한다(`Identity.tsx` 가 `h-5`→`text-[10px]` 규칙을 설명한다). 그 인용까지 위반으로
 * 세면 근거를 적는 것이 벌이 되고, 그러면 사람이 근거를 안 적는다.
 *
 * **줄 접두만 보던 판정을 버렸다**(실측: 이 판에서 그 판정이 실제로 새어 나갔다).
 * `/^\s*(\/\/|\/\*|\*)/` 는 이런 줄을 주석으로 보지 못한다:
 *
 * ```
 *     {/* **화면 제목단 17px.** 18px(`text-lg`)이었고 4단 밖이었다. 이 자리는
 *         화면 하나가 무엇을 하는 중인지 말하는 유일한 줄이라 ... *}
 * ```
 *
 * 첫 줄은 `{` 로 시작하고 둘째 줄은 아무 접두도 없다 — JSX 주석은 `*` 정렬 관례가 없기
 * 때문이다. 그리고 이 작업이 남긴 근거는 대부분 그 형태다(옮긴 자리마다 *"무엇이었고
 * 왜 이 단인가"*를 적어야 했으니까). 그래서 위반 5건이 전부 **자기 근거 주석**이었다.
 *
 * 대신 파일을 한 번 훑어 주석 구간을 공백으로 지운 사본을 만든다. 줄 수는 그대로 두므로
 * (개행만 남긴다) 위반 위치의 줄 번호가 실제 파일과 어긋나지 않는다. 문자열 리터럴 안의
 * `//` 는 주석으로 오인할 수 있지만, 이 저장소에서 그런 문자열은 URL 이고 거기에 크기
 * 유틸리티가 들어 있는 자리는 없다 — 오인해도 **덜 잡는 쪽**이 아니라 뒤쪽 코드를 지워
 * 놓칠 위험이 있으므로, 아래 `RED 확인` 단언이 그 놓침을 잡는다.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      // 줄 주석 — 개행까지 지운다(개행 자체는 남겨 줄 번호를 지킨다).
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (two === '/*') {
      // 블록 주석 — 닫히는 자리까지 지우되 그 안의 개행은 남긴다.
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i += 1) out += source[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/**
 * 한 줄에서 **토큰이 아닌 크기**를 뽑는다.
 *
 * 이 판에서 규칙이 단순해졌다: 정본이 토큰 넷이므로 **임의값도 척도 이름도 무조건**
 * 걸린다. 앞 판은 임의값의 숫자를 보고 4단 안이면 통과시켰는데, 그것이 정본이 임의값일
 * 때의 규칙이었다. 지금 `text-[13px]` 은 `text-body` 와 같은 값을 다른 이름으로 부르는
 * 것이라 어휘가 둘이 되고, 그래서 숫자를 보지 않는다.
 *
 * 통과하는 길은 둘뿐이다: 토큰을 쓰거나, `ALLOWED` 에 근거와 함께 줄을 등록하거나.
 */
function offScale(line: string): string[] {
  return [
    ...[...line.matchAll(ARBITRARY)].map((m) => m[0]),
    ...[...line.matchAll(SCALE_NAME)].map((m) => m[0]),
  ];
}

/**
 * `@theme` 이 실제로 무엇을 정의하는지 **소스에서 읽는다**. 이 파일의 `SCALE` 표는 사람이
 * 적은 것이라 `index.css` 와 갈라질 수 있고, 갈라지면 이 회귀선이 지키는 4단과 화면이
 * 쓰는 4단이 다른 것이 된다. 소스를 읽는 방식은 `daemonFacts.test.tsx` 가 쓰는 것과 같다.
 *
 * `--text-<이름>--line-height` 같은 짝 변수는 이름에 `--` 가 더 들어가므로 이 정규식이
 * 뽑지 않는다 — 지금 그런 짝은 없지만(줄 간격을 강제하지 않기로 했다), 나중에 누가
 * 넣더라도 "토큰이 넷"이라는 단언이 그것 때문에 깨지지는 않아야 한다.
 */
function themeTypeTokens(): Record<string, string> {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf-8');
  const found: Record<string, string> = {};
  for (const m of css.matchAll(/^\s*--text-([a-z0-9-]+):\s*([^;]+);/gm)) {
    const [, name, value] = m;
    if (name && value) found[name] = value.trim();
  }
  return found;
}

describe('타이포 4단 (title 17 / name 15 / body 13 / meta 11)', () => {
  const files = sourceFiles(SRC);

  it('스캔 대상이 실제로 있다 — 목록이 비면 아래 단언이 아무것도 지키지 않는다', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('토큰이 아닌 크기가 남아 있지 않다 — 임의값도 척도 이름도', () => {
    const pendingFiles = new Set(PENDING.map((p) => p.file));
    const leaks: string[] = [];
    for (const file of files) {
      const relative = file.slice(SRC.length);
      if (pendingFiles.has(relative)) continue;
      const raw = readFileSync(file, 'utf-8').split('\n');
      // 예외 판정은 **원본 줄**로 한다 — `ALLOWED.contains` 는 사람이 코드에서 복사해 온
      // 문자열이고, 주석을 지운 사본에서 찾으면 그 줄에 주석이 붙어 있을 때 어긋난다.
      stripComments(readFileSync(file, 'utf-8')).split('\n').forEach((line, i) => {
        if (isAllowed(relative, raw[i] ?? '')) return;
        const found = offScale(line);
        if (found.length) leaks.push(`${relative}:${i + 1} ${found.join(' ')}`);
      });
    }
    expect(
      leaks,
      `4단 토큰(${Object.entries(SCALE).map(([k, v]) => `text-${k}=${v}px`).join(' / ')})을 써라.\n`
      + '단 밖이어야 하는 자리면 그 이유를 주석에 적고 이 파일의 ALLOWED 에 줄 단위로\n'
      + `등록해라:\n${leaks.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * 스캔이 실제로 무언가를 잡을 수 있는지 확인한다. 정규식을 `/$^/` 로 만들어도 위 단언은
   * 초록이다 — 그러면 이 회귀선은 아무것도 지키지 않는다.
   */
  it('스캔이 토큰 아닌 크기를 실제로 잡는다', () => {
    expect(offScale('<span className="text-[10px] text-fg">')).toEqual(['text-[10px]']);
    expect(offScale('flex text-[9px] gap-1 text-[12px]')).toEqual(['text-[9px]', 'text-[12px]']);
    expect(offScale('md:text-[10px]')).toEqual(['md:text-[10px]']);
    // **4단 값의 임의값도 잡는다** — 이 판에서 뒤집힌 규칙이고, 이 단언이 그 뒤집힘 자체다.
    // 앞 판은 여기서 `[]` 를 기대했다(임의값이 정본이었으니까). 지금 이것이 통과하면
    // `text-[13px]` 과 `text-body` 가 나란히 살아 어휘가 둘이 된다.
    expect(offScale('text-[11px] text-[13px] text-[15px] text-[17px]'))
      .toEqual(['text-[11px]', 'text-[13px]', 'text-[15px]', 'text-[17px]']);
    // 토큰은 잡지 않는다 — 잡으면 옮겨 놓은 376곳이 스스로 빨개진다.
    expect(offScale('text-title text-name text-body text-meta')).toEqual([]);
    expect(offScale('<span className="truncate text-meta text-fg-subtle">')).toEqual([]);
    // **척도 이름도 잡는다**(#588 에서 켠 규칙). 이 단언이 초록이면 다음 PR 의
    // `text-sm` 이 통과하고, 그때 없앤 두 번째 어휘가 조용히 되살아난다.
    expect(offScale('text-xs text-sm')).toEqual(['text-xs', 'text-sm']);
    expect(offScale('flex text-base p-2 text-lg')).toEqual(['text-base', 'text-lg']);
    // 지금 이 저장소에 없는 이름까지 막는다 — 없는 것을 잡는 비용은 0 이고, 있는 것만
    // 잡으면 `text-xl` 을 처음 들고 오는 PR 을 아무도 안 막는다.
    expect(offScale('text-xl text-2xl text-3xl')).toEqual(['text-xl', 'text-2xl', 'text-3xl']);
    expect(offScale('md:text-sm hover:text-base')).toEqual(['md:text-sm', 'hover:text-base']);
    // **크기가 아닌 `text-*` 는 크기가 아니다.** 색·정렬·굵기까지 잡으면 이 회귀선이
    // 색 회귀선(`colorTokens.test.ts`)의 일을 침범하고, 그쪽이 이미 지키는 자리를 두 번
    // 지킨다 — 그러면 색을 고치는 PR 이 이 파일 때문에 빨개진다.
    expect(offScale('text-fg text-fg-subtle text-center text-left text-danger')).toEqual([]);
    // 다른 속성의 임의값도 대상이 아니다 — 이 파일이 재는 것은 글자 크기 하나다.
    expect(offScale('w-[62px] h-[10px] leading-[10px]')).toEqual([]);
  });

  it('주석에 인용된 크기는 위반으로 세지 않는다 — 근거를 적는 것이 벌이 되면 안 된다', () => {
    const off = (src: string) => stripComments(src).split('\n').flatMap(offScale);

    // 세 가지 주석 형태 모두 — 특히 **JSX 주석의 둘째 줄**은 아무 접두도 없다. 앞 판의
    // 줄 접두 판정이 정확히 거기서 새어 나갔고, 이 작업의 근거 주석 대부분이 그 형태다.
    //
    // 여는 `/*` 부터 준다. 이 판정은 **줄이 아니라 구간**을 보므로 ` * ` 로 시작하는
    // 이어지는 줄만 떼어 주면 그것은 주석이 아니다 — 실제 파일에서 그런 줄은 늘 어떤
    // 블록 안에 있고, 그래서 여기서도 블록째로 준다.
    expect(off('/**\n * `h-5`→`text-[10px]`, `h-4`→`text-[8px]`\n */')).toEqual([]);
    expect(off('  // 10px 을 단으로 인정하지 않는다: text-[10px] text-sm')).toEqual([]);
    expect(off('  /* text-[10px] text-base */')).toEqual([]);
    expect(off('  {/* 17px 이다. 18px(`text-lg`)이었고\n      4단 밖이었다 */}')).toEqual([]);

    // **코드는 그대로 잡는다** — 주석을 지우는 것이 코드까지 지우면 이 회귀선이 조용히
    // 아무것도 안 지킨다. 주석 뒤에 이어지는 줄도 살아 있어야 한다.
    expect(off('  <span className="text-[10px]">')).toEqual(['text-[10px]']);
    expect(off('  /* 근거 */ <span className="text-sm">')).toEqual(['text-sm']);
    expect(off('  {/* 근거 */}\n  <span className="text-base">')).toEqual(['text-base']);
    // 줄 번호가 밀리지 않는다 — 블록 주석 안의 개행을 남기기 때문이다.
    expect(stripComments('a\n/* x\ny */\nb').split('\n')).toHaveLength(4);
  });

  it('예외로 적어 둔 줄은 실제로 그 파일에 있다 — 죽은 예외를 남기지 않는다', () => {
    for (const a of ALLOWED) {
      const text = readFileSync(join(SRC, a.file), 'utf-8');
      expect(text, `${a.file} 에 예외로 적은 줄이 없다(${a.why}): ${a.contains}`)
        .toContain(a.contains);
    }
  });

  /**
   * **토큰이 넷뿐이다.** 위 스캔은 "토큰이 아닌 것"만 잡으므로 다섯째 토큰(`--text-tiny`)이
   * 생겨도 초록이다 — 그러면 4단이 조용히 다섯 단이 되고, 이 회귀선의 이름이 거짓이 된다.
   * 10px 이 59곳까지 늘어난 것도 아무도 그것을 단으로 정한 적이 없었기 때문이다.
   */
  it('`@theme` 의 타이포 토큰이 넷뿐이고 값이 4단이다', () => {
    const tokens = themeTypeTokens();
    expect(
      Object.keys(tokens).sort(),
      '`src/index.css` 의 `--text-*` 가 넷이 아니다. 단을 늘리는 것은 문서\n'
      + '(`docs/desktop-design-directions.html` 의 위생 항목)를 함께 고치는 일이다.',
    ).toEqual(['body', 'meta', 'name', 'title']);

    // 값도 잰다 — 이름만 맞고 `--text-body: 14px` 이면 4단이 아니라 다른 넷이다.
    for (const [key, px] of Object.entries(SCALE)) {
      expect(tokens[key], `--text-${key} 가 ${px}px 이 아니다`).toBe(`${px}px`);
    }
  });

  /**
   * 스캔이 아니라 **읽기**가 실제로 되는지 본다. 정규식이 아무것도 못 뽑으면 위 단언은
   * 빈 객체끼리 비교하다가 이름 단언에서만 걸리는데, 그 실패 메시지는 "토큰을 다섯 개
   * 만들었다"로 읽혀 원인을 가리키지 못한다.
   */
  it('토큰을 소스에서 실제로 읽어 온다', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf-8');
    expect(css).toContain('--text-body: 13px');
    expect(Object.keys(themeTypeTokens()).length).toBe(4);
  });

  /**
   * 부채가 **늘지 않는지** 본다. 줄면 통과한다 — 그러면 숫자를 내리라고 알려 준다.
   * 이 자리를 `ALLOWED` 로 옮기지 않는 것이 요점이다: 예외는 영구 면제이고 부채는 갚는 것이다.
   */
  it('아직 못 고친 파일의 4단 밖 크기가 늘지 않았다', () => {
    for (const p of PENDING) {
      const lines = stripComments(readFileSync(join(SRC, p.file), 'utf-8')).split('\n');
      // **줄 수가 아니라 개수를 센다.** 줄로 세면 이미 위반인 줄에 크기를 하나 더 붙이는
      // 변경이 통과한다(28 줄에 29 개가 될 수 있다) — RED 확인에서 실제로 그렇게 새어 나갔다.
      const found = lines.reduce((n, l) => n + offScale(l).length, 0);
      expect(
        found,
        `${p.file} 의 4단 밖 크기가 ${p.count} 곳에서 ${found} 곳이 됐다(${p.why}).\n`
        + '줄었으면 PENDING 의 수를 내려라. 다 고쳤으면 항목을 지워라.',
      ).toBeLessThanOrEqual(p.count);
    }
  });
});

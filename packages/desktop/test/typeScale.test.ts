import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * **타이포를 4단으로 고정한다** — 정본 문서 `docs/desktop-design-directions.html` 의 공통
 * 위생 항목("타이포 4단 · 회색 3단 · 강조 1색").
 *
 * ```
 * 11px  로우·상태·시간
 * 13px  본문
 * 15px  이름줄
 * 17px  화면 제목
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
 * **어휘가 한 벌이 됐다**(2026-09-08). 이 파일의 앞 판은 임의값(`text-[13px]`)만 잠그고
 * Tailwind 척도 이름(`text-xs`·`text-sm`·`text-base`)은 통과시켰고, 그 이유를 아래
 * `SCALE_NAME` 자리에 적어 뒀다 — 척도 이름 228곳이 v4 기본값 12 / 14 / 16px 이라 4단 중
 * 아무것도 아니었고, 화면이 **두 벌**로 돌아갔다. 그 228곳을 옮기고 이제 척도 이름도 4단
 * 밖으로 잡는다. **크기의 어휘는 임의값 하나뿐이다.**
 *
 * 앱의 기본 글자 크기가 그 작업의 축이었다: 세 뿌리(`Workspace`·`SettingsScreen`·
 * `App` 의 `withDragStrip`)가 각각 14px·14px·**16px**(브라우저 기본값 — 아무도 안 적어서)
 * 이었고, 셋을 본문단 13px 로 맞추자 아래쪽에서 **같은 값을 다시 적던 자리 91곳이
 * 지워졌다.** 어휘를 줄이는 일의 절반은 옮기는 것이 아니라 **지우는 것**이었다.
 *
 * 실측 집계(주석을 지운 뒤 센 것): 척도 이름 **227 → 11**(남은 11 은 아래 `ALLOWED` 의
 * 상자 글리프), 옮긴 216곳 중 **125곳은 임의값으로 적고 91곳은 클래스를 지웠다**.
 * 단별로는 11px 213 → 319, 13px 24 → 27(+지운 91곳이 상속으로 이 단이 된다),
 * **15px 0 → 13, 17px 0 → 2.** 뒤의 두 단은 **쓰는 자리가 하나도 없었다** — 4단이라고
 * 적혀 있었지만 화면은 실제로 두 단(11·13)으로만 돌아갔다는 뜻이다. 그래서 이 작업의
 * 절반은 "옮기기"가 아니라 **15px 과 17px 에 자리를 정해 주는 일**이었다: 17px 은 화면
 * 제목 둘(설정 `SettingsPage`·로그인 `h1`)뿐이고, 15px 은 이름줄(작성자 이름·채널 이름·
 * 겹창 제목·두 칸 설정의 칸 제목)이다.
 *
 * **예외는 줄 단위로 적는다.** 파일 전체를 면제하면 그 파일에 새로 들어오는 크기까지
 * 조용히 통과한다.
 */
// `import.meta.url` 은 jsdom 환경에서 패키지 밖을 가리킨다 — vitest 의 cwd(패키지 루트)를 쓴다.
const SRC = `${resolve(process.cwd(), 'src')}/`;

/** 4단. 화면 코드의 임의 크기는 이 넷 중 하나여야 한다. */
const SCALE = [11, 13, 15, 17];

/**
 * `text-[13px]` 같은 임의 크기 유틸리티. 사람이 숫자를 직접 적은 자리이고, 그 숫자가
 * 단 밖으로 새는 것이 이 규칙의 대상이다.
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
 * **그 다음 단계가 끝났다**(실측 2026-09-08, 이 브랜치): 척도 이름 227곳 중 216곳을
 * 4단으로 옮기고 11곳(상자에 묶인 글리프)만 `ALLOWED` 에 남겼다. 그래서 이 정규식을
 * 켠다 — 켜지 않으면 다음 PR 이 `text-sm` 을 다시 들고 오고, 방금 없앤 두 번째 어휘가
 * 조용히 되살아난다. 색 회귀선(`colorTokens.test.ts`)이 `zinc-` 에 대해 하는 일과 같다.
 *
 * `text-xl` 처럼 **지금 이 저장소에 없는 이름까지** 넣는다. 없는 것을 잡는 규칙은 비용이
 * 0 이고, 있는 것만 잡으면 다음 사람이 `text-xl` 을 처음 들고 올 때 아무도 안 막는다.
 * 잡지 않는 것은 크기가 아닌 `text-*`(`text-fg`·`text-center`·`text-left`)뿐이다.
 *
 * **여전히 `@theme` 에 타이포 토큰을 두지 않는다.** 어휘가 한 벌이 된 것은 사실이지만,
 * 그 한 벌은 지금 **임의값**이고 토큰을 넣으면 이름이 하나 더 생긴다. 토큰은 이 회귀선이
 * 한동안 초록으로 버틴 뒤에 하는 일이다 — 옮긴 직후에 토큰까지 얹으면 이번 판정이
 * 맞았는지 화면에서 확인할 기회가 없어진다.
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
 * 3. **레일의 이모지 아이콘** — `aria-hidden` 이고 내용이 그림이라 크기가 정하는 것은
 *    읽힘이 아니라 아이콘의 지름이다. 아래 라벨이 11px 이므로 이것까지 4단으로 내리면
 *    그림과 글자가 한 덩어리로 보인다(`Rail.tsx` 에 근거를 적어 뒀다).
 *
 * **1 은 척도 이름 쪽에도 그대로 적용된다**(이번 판에서 늘어난 항목들). `AgentGrid.tsx`
 * 의 주석이 그 근거를 이미 적어 뒀다: *"여기만 임의값으로 바꾸면 표 안에서 두 어휘가
 * 섞이고, 다음에 이 표를 고치는 사람이 어느 쪽을 따라야 하는지 알 수 없다."* 그래서
 * 상자 글리프는 임의값으로 옮기지도 않고 척도 이름을 그대로 두고 예외로 적는다 —
 * `h-*` 와 짝을 이루는 자리라 Tailwind 의 상대 척도가 오히려 그 짝을 읽기 쉽게 한다.
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
  {
    file: 'components/Rail.tsx',
    contains: '<span aria-hidden="true" className="text-base leading-none">{cell.glyph}</span>',
    why: '레일 칸의 이모지 아이콘 — `aria-hidden` 인 그림이고 크기가 지름이다',
  },
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
 * 한 줄에서 4단 밖의 크기를 뽑는다 — **두 어휘를 함께 본다.**
 *
 * 임의값(`text-[12px]`)은 숫자가 4단 밖일 때 걸리고, 척도 이름(`text-sm`)은 **무조건**
 * 걸린다: v4 기본값이 12 / 14 / 16px 이라 4단과 겹치는 이름이 하나도 없다. 하나라도
 * 겹쳤다면 그 이름만 통과시켰을 텐데, 겹치지 않으므로 규칙이 단순해진다.
 */
function offScale(line: string): string[] {
  return [
    ...[...line.matchAll(ARBITRARY)]
      .filter((m) => !SCALE.includes(Number(m[1])))
      .map((m) => m[0]),
    ...[...line.matchAll(SCALE_NAME)].map((m) => m[0]),
  ];
}

describe('타이포 4단 (11 / 13 / 15 / 17)', () => {
  const files = sourceFiles(SRC);

  it('스캔 대상이 실제로 있다 — 목록이 비면 아래 단언이 아무것도 지키지 않는다', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('4단 밖의 크기가 남아 있지 않다 — 임의값도 척도 이름도', () => {
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
      `4단(${SCALE.map((n) => `${n}px`).join(' / ')}) 안으로 옮겨라. 단 밖이어야 하는 자리면\n`
      + `그 이유를 주석에 적고 이 파일의 ALLOWED 에 줄 단위로 등록해라:\n${leaks.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * 스캔이 실제로 무언가를 잡을 수 있는지 확인한다. 정규식을 `/$^/` 로 만들어도 위 단언은
   * 초록이다 — 그러면 이 회귀선은 아무것도 지키지 않는다.
   */
  it('스캔이 4단 밖 크기를 실제로 잡는다', () => {
    expect(offScale('<span className="text-[10px] text-fg">')).toEqual(['text-[10px]']);
    expect(offScale('flex text-[9px] gap-1 text-[12px]')).toEqual(['text-[9px]', 'text-[12px]']);
    expect(offScale('md:text-[10px]')).toEqual(['md:text-[10px]']);
    // 4단은 잡지 않는다 — 잡으면 옮겨 놓은 코드가 스스로 빨개진다.
    expect(offScale('text-[11px] text-[13px] text-[15px] text-[17px]')).toEqual([]);
    // **척도 이름도 잡는다**(이번 판에서 켠 규칙). 이 단언이 초록이면 다음 PR 의
    // `text-sm` 이 통과하고, 방금 없앤 두 번째 어휘가 조용히 되살아난다.
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

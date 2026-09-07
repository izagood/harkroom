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
 * **예외는 줄 단위로 적는다.** 파일 전체를 면제하면 그 파일에 새로 들어오는 크기까지
 * 조용히 통과한다.
 */
// `import.meta.url` 은 jsdom 환경에서 패키지 밖을 가리킨다 — vitest 의 cwd(패키지 루트)를 쓴다.
const SRC = `${resolve(process.cwd(), 'src')}/`;

/** 4단. 화면 코드의 임의 크기는 이 넷 중 하나여야 한다. */
const SCALE = [11, 13, 15, 17];

/**
 * `text-[13px]` 같은 임의 크기 유틸리티. **Tailwind 척도 이름(`text-xs`·`text-sm`)은 잡지
 * 않는다** — 여기서 잡는 것은 사람이 숫자를 직접 적은 자리이고, 그 숫자가 단 밖으로 새는
 * 것이 이 회귀선의 대상이다.
 *
 * 다만 척도 이름이 4단에 **맞다는 뜻은 아니다.** 실측(이 브랜치 시점): 임의값 4단이 189 곳,
 * 척도 이름(`text-xs`·`text-sm`·`text-base`)이 220 곳이고 `index.css` 는 척도를 재정의하지
 * 않는다 — 즉 그 220 곳은 v4 기본값 그대로 **12 / 14 / 16px** 이라 4단(11/13/15/17) 중
 * 아무것도 아니다. 화면은 지금 **두 벌**로 돌아간다.
 *
 * 그래서 이 PR 은 `@theme` 에 타이포 토큰을 두지 않았다. 토큰을 두면 임의값·척도 이름에
 * 이어 **세 번째** 어휘가 생기고, 220 곳을 함께 옮기지 않는 한 그 토큰이 "정본"이라는 말이
 * 거짓이 된다 — 색을 토큰으로 뺀 작업(#112)이 통한 이유는 `zinc-` 를 **한 곳도 남기지 않고**
 * 옮겼기 때문이다. 다음 단계는 척도 이름 220 곳을 4단으로 옮기는 것이고, 그것이 끝나야
 * `@theme` 이 한 벌을 가리킬 수 있다. 이 회귀선은 그때까지 임의값 쪽을 잠가 둔다.
 */
const ARBITRARY = /(?<![\w-])(?:[a-z-]+:)*text-\[(\d+(?:\.\d+)?)px\]/g;

/**
 * 남긴 예외. **줄 내용까지 적는다** — 그 줄이 바뀌면 예외가 죽고 테스트가 그것을 알려 준다.
 *
 * 두 종류뿐이다:
 *
 * 1. **아바타 원 안의 머리글자** — 4단이 아니라 `h-*` 상자에 묶인 글리프다. 크기가 원의
 *    지름에서 따라 나오므로(`h-8`→`text-sm`, `h-5`→10px, `h-4`→8px) 단으로 끌어올리면
 *    지름은 그대로인데 글자만 커진다. 근거는 `Identity.tsx` 의 주석에 길게 적어 뒀다.
 * 2. **등폭 글꼴의 12px** — 본문단 13px 을 *광학적으로* 맞추는 보정이다. 등폭은 같은 pt
 *    에서 산세리프보다 크게 보여, 13px 로 두면 옆의 13px 본문보다 한 단 커 보인다.
 *    단을 어긴 것이 아니라 단을 지키기 위해 한 단 내린 것이다.
 *
 * `Sidebar.tsx` 는 예외가 **아니다.** 지금 10px 28 곳이 남아 있고 그것은 다른 작업이 같은
 * 파일을 고치는 중이라 이번 PR 이 건드리지 않은 것이다 — 예외로 적으면 그 자리가 영구히
 * 면제된다. 아래 `PENDING` 이 그 부채를 숫자로 붙잡는다.
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
 * 주석 줄은 재지 않는다. 이 저장소는 **근거를 코드 옆에 적는 관례**라 주석이 크기를
 * 인용한다(`Identity.tsx` 가 `h-5`→`text-[10px]` 규칙을 설명한다). 그 인용까지 위반으로
 * 세면 근거를 적는 것이 벌이 되고, 그러면 사람이 근거를 안 적는다.
 *
 * 줄 단위 판정이라 블록 주석 안의 코드 예시는 잡지 않는다 — 화면에 실제로 나가는 클래스는
 * JSX 속성에 있고 그것은 주석 접두가 붙지 않는다.
 */
function isComment(line: string): boolean {
  return /^\s*(?:\/\/|\/\*|\*)/.test(line);
}

/** 한 줄에서 4단 밖의 임의 크기를 뽑는다. */
function offScale(line: string): string[] {
  return [...line.matchAll(ARBITRARY)]
    .filter((m) => !SCALE.includes(Number(m[1])))
    .map((m) => m[0]);
}

describe('타이포 4단 (11 / 13 / 15 / 17)', () => {
  const files = sourceFiles(SRC);

  it('스캔 대상이 실제로 있다 — 목록이 비면 아래 단언이 아무것도 지키지 않는다', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('4단 밖의 임의 크기가 남아 있지 않다', () => {
    const pendingFiles = new Set(PENDING.map((p) => p.file));
    const leaks: string[] = [];
    for (const file of files) {
      const relative = file.slice(SRC.length);
      if (pendingFiles.has(relative)) continue;
      readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        if (isComment(line) || isAllowed(relative, line)) return;
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
    // 척도 이름과 다른 속성의 임의값은 이 회귀선의 대상이 아니다.
    expect(offScale('text-xs text-sm w-[62px] h-[10px] leading-[10px]')).toEqual([]);
  });

  it('주석에 인용된 크기는 위반으로 세지 않는다 — 근거를 적는 것이 벌이 되면 안 된다', () => {
    expect(isComment(' * `h-5`→`text-[10px]`, `h-4`→`text-[8px]`')).toBe(true);
    expect(isComment('  // 10px 을 단으로 인정하지 않는다: text-[10px]')).toBe(true);
    expect(isComment('  /* text-[10px] */')).toBe(true);
    expect(isComment('  <span className="text-[10px]">')).toBe(false);
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
      const lines = readFileSync(join(SRC, p.file), 'utf-8').split('\n');
      // **줄 수가 아니라 개수를 센다.** 줄로 세면 이미 위반인 줄에 크기를 하나 더 붙이는
      // 변경이 통과한다(28 줄에 29 개가 될 수 있다) — RED 확인에서 실제로 그렇게 새어 나갔다.
      const found = lines
        .filter((l) => !isComment(l))
        .reduce((n, l) => n + offScale(l).length, 0);
      expect(
        found,
        `${p.file} 의 4단 밖 크기가 ${p.count} 곳에서 ${found} 곳이 됐다(${p.why}).\n`
        + '줄었으면 PENDING 의 수를 내려라. 다 고쳤으면 항목을 지워라.',
      ).toBeLessThanOrEqual(p.count);
    }
  });
});

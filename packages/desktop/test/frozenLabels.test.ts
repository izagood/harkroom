import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * **모듈 상수가 언어를 굳히지 못하게 한다**(`#659`).
 *
 * ```ts
 * const LABEL: Record<Kind, string> = { away: '자리 비움', … };   // 모듈 최상단
 * ```
 *
 * 이 모양은 **모듈이 처음 읽힐 때의 언어로 굳는다.** 그 뒤 사람이 언어를 바꿔도 그 자리만
 * 옛 언어로 남고, **화면이 `t()` 를 제대로 지나도 안 바뀐다** — 값이 이미 글자이기 때문이다.
 *
 * ## 왜 화면 회귀선으로는 부족한가
 *
 * **사전은 갈려 있고 화면만 안 따라온다.** 그래서 사전을 대조하는 축은 전부 초록이다.
 * 잡는 것은 화면을 렌더해 **언어를 바꿔 보는** 축뿐인데, 그것은 화면마다 사람이 따로 써야
 * 하고 — 실제로 i18n 작업 내내 이 결함이 **여섯 번** 났다:
 *
 * `Sidebar::NOTIFY_LEVEL_LABEL`(#630) · `SkillsSettings::GROUPS`(#654) ·
 * `runnerLauncher::STRANGER_ATTACHED`(#650) · `threadState::THREAD_STATE_LABEL`(#656) ·
 * `NotifiedGapRow::LABEL`(#656) · `RunnerStatus`·`presenceView`·`TerminalPanel`·
 * `ProjectionUrl` 넷(#658).
 *
 * **뒤 넷 중 둘은 아무도 지목하지 않았는데 작업하다 우연히 발견됐다.** 찾는 방법이 사람의
 * 눈뿐이라는 것이 문제였다. 그리고 고친 것을 되돌렸을 때 **아무 축도 안 빨개진 일이 여섯
 * 번** 있었다 — 매번 회귀선이 없다는 신호였다.
 *
 * 그래서 화면이 아니라 **소스를 직접 읽어** *"지금 그 모양이 없다"* 를 단언한다.
 * `typeScale.test.ts`(이 파일의 본)와 `daemonFacts.test.tsx` 의 *"판정 함수 어디에도
 * 임계값 상수가 없다"* 가 같은 태도다.
 *
 * ## 무엇이 걸리고 무엇이 안 걸리나
 *
 * 걸리는 것은 **모듈 최상단의 상수 안에 든 한글 리터럴**이다. 함수 안의 지역 변수는 매번
 * 다시 만들어지므로 굳지 않고, 값이 색·클래스·글리프면 언어가 아니다(`RunnerStatus::TONE`
 * 과 `AgentGrid::PLACE` 가 그것이라 자동으로 안 걸린다 — 값에 한글이 없다).
 *
 * 고치는 길은 둘이고, 어느 쪽인지는 **자리표시자와 갈래의 유무**가 정한다(#658 이 넷을
 * 그 기준으로 갈랐다):
 *
 * - **표를 남기고 값만 사전 키로** — 자리표시자가 없을 때. 키는 언어를 안 지니므로 상수여도
 *   안전하고, *"갈래를 추가하면 컴파일이 막힌다"* 는 표의 이점이 산다(`NOTIFY_LEVEL_KEY`)
 * - **함수로 내림** — 값이 자리표시자를 받거나 갈래로 갈릴 때. 표로는 표현이 안 된다
 *   (`threadStateLabel` · `runnerStatusLabel`)
 */

const SRC = resolve(process.cwd(), 'src');

/**
 * **정당한 예외.** 늘어나면 이 회귀선이 무의미해지므로 각 줄에 근거를 남긴다.
 *
 * `format.ts::PARTICLES` 는 조사 규칙표다 — 그 값이 **한국어 문법 그 자체**이고 번역
 * 대상이 아니다. 오히려 이것이 사전 밖에 있어야 하는 것이 `ko.ts` 머리말의 결정이다
 * (*"문법 규칙은 그것을 가진 언어의 파일에만 있어야 한다"*).
 */
const ALLOWED = new Set(['i18n/format.ts']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 주석은 뺀다 — 이 저장소는 주석에 문구를 많이 인용하고, 그것은 굳는 값이 아니다. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (two === '/*') {
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

const HANGUL = /[가-힣]/;

/**
 * 모듈 최상단(들여쓰기 없음)에서 시작하는 `const … = { … }` 를 찾아 그 블록을 돌려준다.
 * 함수 안의 선언은 들여쓰기가 있으므로 자연히 빠진다 — **지역 변수는 굳지 않는다.**
 */
function topLevelObjects(source: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  const re = /^const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    // 정규식에 캡처 그룹이 하나 있으므로 `m[1]` 은 반드시 있다 — 타입만 모른다.
    found.push({ name: m[1] ?? '?', body: source.slice(m.index + m[0].length, i) });
  }
  return found;
}

describe('모듈 상수가 언어를 굳히지 않는다', () => {
  it('최상단 상수 안에 한글 문구가 없다', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const relative = file.slice(SRC.length + 1);
      if (ALLOWED.has(relative)) continue;
      for (const { name, body } of topLevelObjects(stripComments(readFileSync(file, 'utf-8')))) {
        if (HANGUL.test(body)) {
          const sample = (body.match(/['"`][^'"`]*[가-힣][^'"`]*['"`]/) ?? ['?'])[0];
          offenders.push(`${relative}::${name} — ${sample}`);
        }
      }
    }
    expect(offenders, [
      '모듈 최상단 상수에 한글 문구가 있다 — 모듈이 처음 읽힐 때의 언어로 굳는다.',
      '고치는 길 둘(`#658` 이 넷을 이 기준으로 갈랐다):',
      '  · 자리표시자가 없으면 → 표를 남기고 값만 사전 키로 (`Record<…, MessageKey>`)',
      '  · 자리표시자를 받거나 갈래로 갈리면 → 함수로 내리고 번역기를 인자로',
    ].join('\n')).toEqual([]);
  });

  /**
   * **예외가 조용히 늘지 않게 한다.** 허용 목록은 회귀선의 구멍이고, 구멍이 늘면 이
   * 회귀선은 있으나 마나가 된다 — 그래서 그 크기 자체를 잰다.
   */
  it('허용 목록이 하나뿐이다 — 조사 규칙표', () => {
    expect([...ALLOWED]).toEqual(['i18n/format.ts']);
  });
});

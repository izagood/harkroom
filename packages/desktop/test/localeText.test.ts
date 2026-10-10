import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { dateText, dateTimeText, numberText } from '../src/lib/localeText';

/**
 * 날짜·시각·수가 **앱 언어**를 따른다 — OS 언어가 아니라.
 *
 * `toLocaleString()`·`toLocaleTimeString([], …)` 처럼 언어를 안 넘기면 OS 를 따라, 영어로 고른
 * 사람의 화면에 `오후 09:07` 이 섞였다(i18n 검토, 2026-10-10 — 19곳). 화면은 `lib/localeText.ts`
 * 나 `lib/day.ts` 를 지나고, 직접 부를 때는 언어를 넘긴다. 이 시험은 **인자 없는 호출이 소스에
 * 다시 생기지 않는지**를 잰다.
 */
const SRC = resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

/** 언어를 안 넘긴 호출: `()`·`([] …)`·`(undefined …)`. 주석 줄은 뺀다. */
const NO_LOCALE = /\.toLocale(?:Date|Time)?String\(\s*(?:\)|\[\]|undefined\b)/;

/**
 * 아직 남은 자리. **줄이기만 한다** — 고치면 여기서 지운다.
 * - `UpdatesSettings.tsx` 는 #1289(i18n P1)가 고친다. 둘 중 나중에 머지되는 쪽이 이 줄을 지운다.
 */
const PENDING = new Set(['components/settings/UpdatesSettings.tsx']);

describe('날짜·시각·수는 앱 언어를 따른다', () => {
  it('소스에 언어 없이 부른 toLocale*String 이 없다', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (PENDING.has(rel)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.trimStart();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('{/*')) return;
        if (NO_LOCALE.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('남은 자리 목록에 이미 고친 파일이 없다 — 목록이 낡지 않는다', () => {
    for (const rel of PENDING) {
      expect(NO_LOCALE.test(readFileSync(join(SRC, rel), 'utf8')), rel).toBe(true);
    }
  });

  it('같은 순간을 언어마다 다르게 적는다', () => {
    const at = new Date(2026, 9, 10, 21, 7);
    // 한국어의 오전·오후 표기는 런타임 ICU 판에 따라 `오후`·`PM` 으로 갈린다 — 날짜 모양으로 가른다.
    expect(dateTimeText(at, 'ko')).toMatch(/^2026\. 10\. 10\./);
    expect(dateTimeText(at, 'ko')).not.toBe(dateTimeText(at, 'en'));
    expect(dateTimeText(at, 'en')).toMatch(/PM/);
    expect(dateTimeText(at, 'en')).not.toMatch(/[오전후]/);
    expect(dateText(at.toISOString(), 'ko')).toMatch(/2026\. 10\. 10\./);
    expect(dateText(at.getTime(), 'en')).toBe('10/10/2026');
    expect(numberText(12345, 'en')).toBe('12,345');
  });
});

// 스펙 2026-09-20 §2 책임표: **프론트는 PAT 도 기동 결정도 갖지 않는다.** 러너를 띄우는 것은
// 오퍼레이터의 일이고, 앱은 배정(어느 오퍼레이터가 돌리나)을 고를 뿐이다. 이 파일은 그 경계가
// 다시 열리지 않는지 지킨다 — `runnerShellScope.test.ts` 가 "웹뷰에서 프로그램을 실행할 표면이
// 없다"를 지키는 것과 같은 종류의 회귀선이고, 한 층 위의 사실을 잰다.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const SRC = join(__dirname, '..', 'src');
const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));

describe('데스크탑은 러너를 띄우지 않는다', () => {
  it('HARKROOM_PAT 문자열이 소스에 없다 — 앱은 러너의 자격증명을 모른다', () => {
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes('HARKROOM_PAT'));
    expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
  it('spawnRunner 요청을 만드는 코드가 없다 — 기동 결정은 오퍼레이터의 것이다', () => {
    const hits = files.filter((f) => /type:\s*['"]spawnRunner['"]/.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
  it('러너 PAT 키체인 항목(harkroom.runner.pat)을 쓰지 않는다', () => {
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes('harkroom.runner.pat'));
    expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});

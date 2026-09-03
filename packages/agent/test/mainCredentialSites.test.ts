/**
 * `main.ts` 의 자격증명 판정 **호출 자리** 회귀선(#250).
 *
 * 왜 소스를 읽는 검사인가, 그리고 이것이 무엇을 보증하지 **못하는가**를 먼저 적는다:
 * `main.ts` 는 top-level await 로 서버 접속·설정 파일 쓰기를 곧바로 일으켜 테스트가 import
 * 할 수 없다(그 파일 머리의 주석이 같은 이유를 적어 뒀다). 그래서 판정 자체는
 * `exit.test.ts` 가 실물로 확인하고, 여기서는 그 판정이 **세 자리에 모두 걸려 있는지**만
 * 본다. 실행 경로를 타지 않으므로 이것은 약한 검사다 — 하지만 이 기능이 실제로 깨졌던
 * 방식이 정확히 "판정은 있는데 그 자리에 없다"였다.
 *
 * 무엇이 깨져 있었나: 폐기된 PAT 로 도는 러너는 거의 항상 **롱폴**에 park 돼 있고, 앞선
 * 판본은 자격증명 판정을 멘션 턴의 catch 에만 걸었다. 폴 루프의 catch 는 401 을
 * "poll 루프 오류, 재접속" 으로 삼켜 무한 재시도했고, 기동의 첫 호출(`murmur.me()`)은
 * 아예 감싸이지 않아 top-level rejection 으로 종료 코드 1 로 죽었다. 두 경우 모두 앱은
 * "PAT 를 재발급하면 된다"를 말할 수 없다 — 78 이 오지 않으니까.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const source = readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');

/** 그 자리 뒤로 몇 줄 안에 판정 호출이 있는가. */
const guardedNear = (anchor: string, within = 12): boolean => {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`앵커를 못 찾았다(코드가 바뀌었으면 이 테스트를 고쳐라): ${anchor}`);
  const window = source.slice(at, at + source.slice(at).split('\n').slice(0, within).join('\n').length);
  return window.includes('exitIfCredentialRejected(err)');
};

describe('자격증명 판정이 세 자리에 다 걸려 있다', () => {
  it('기동의 첫 호출(me/guide)', () => {
    expect(guardedNear('return [await murmur.me(), await murmur.guide()] as const;')).toBe(true);
  });

  it('멘션 턴의 catch', () => {
    expect(guardedNear('// 자격증명 실패는 재시도로 낫지 않는다.')).toBe(true);
  });

  it('폴 루프의 catch — 재접속으로 삼키기 **전에** 본다', () => {
    const pollCatch = source.indexOf("console.error('poll 루프 오류, 재접속:'");
    expect(pollCatch).toBeGreaterThan(0);
    const guard = source.lastIndexOf('exitIfCredentialRejected(err)', pollCatch);
    // 판정이 그 로그보다 **앞**에 있어야 한다. 뒤에 있으면 이미 재시도로 넘어간 뒤다.
    expect(guard).toBeGreaterThan(0);
    expect(pollCatch - guard).toBeLessThan(500);
  });

  it('판정은 `exit.ts` 의 것 하나뿐이다 — 자리마다 다시 짜지 않는다', () => {
    expect(source).toContain("from './exit.js'");
    expect(source.match(/process\.exit\(78\)/g)).toBeNull();
  });
});

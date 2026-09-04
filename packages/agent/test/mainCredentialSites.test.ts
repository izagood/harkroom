/**
 * `main.ts` 의 "재시도로 낫지 않는 실패" 판정 **호출 자리** 회귀선(#250, #340).
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
  return window.includes('exitIfUnrecoverable(err)');
};

describe('종료 판정이 세 자리에 다 걸려 있다', () => {
  it('기동의 첫 호출(me/guide)', () => {
    expect(guardedNear('return [await murmur.me(), await murmur.guide()] as const;')).toBe(true);
  });

  it('멘션 턴의 catch', () => {
    expect(guardedNear('// 재시도로 낫지 않는 실패는 여기서 걸러')).toBe(true);
  });

  it('폴 루프의 catch — 재접속으로 삼키기 **전에** 본다', () => {
    const pollCatch = source.indexOf("console.error('poll 루프 오류, 재접속:'");
    expect(pollCatch).toBeGreaterThan(0);
    const guard = source.lastIndexOf('exitIfUnrecoverable(err)', pollCatch);
    // 판정이 그 로그보다 **앞**에 있어야 한다. 뒤에 있으면 이미 재시도로 넘어간 뒤다.
    expect(guard).toBeGreaterThan(0);
    expect(pollCatch - guard).toBeLessThan(500);
  });

  it('판정은 `exit.ts` 의 것 하나뿐이다 — 자리마다 다시 짜지 않는다', () => {
    expect(source).toContain("from './exit.js'");
    expect(source.match(/process\.exit\(78\)/g)).toBeNull();
  });

  // #340 — 자리에 있는 것만으로는 부족하다. 멘션 턴의 catch 에서 판정이 **재시도 회계보다
  // 뒤에** 있으면, 러너는 죽기는 하되 그 전에 `attempts` 를 올리고 `failed` 를 세운 뒤다.
  // 그러면 "재시도 0회"라는 이 이슈의 요구가 조용히 깨진다(3회 재시도 뒤에 죽어도 "종료했다"는
  // 단언은 여전히 초록이다). 그래서 **순서**를 따로 고정한다.
  it('멘션 catch 에서 판정이 재시도 회계보다 앞이다 — 실패 계상 전에 죽는다', () => {
    // **멘션 catch 안**에서만 잰다. 파일 앞쪽에도 같은 이름이 있으므로(기동 자리, import 줄)
    // 첫 등장으로 재면 순서 비교가 언제나 참이 되어 아무것도 지키지 못한다.
    const at = source.indexOf('// 재시도로 낫지 않는 실패는 여기서 걸러');
    expect(at).toBeGreaterThan(0);
    const guard = source.indexOf('exitIfUnrecoverable(err);', at);
    const accounting = source.indexOf('failed = true;', at);
    const notice = source.indexOf('await murmur.post(mention.channelId, FAILURE_NOTICE', at);
    expect(guard).toBeGreaterThan(0);
    expect(accounting).toBeGreaterThan(guard);
    expect(notice).toBeGreaterThan(guard);
  });

  // 항목 시도 횟수는 turn 을 부르기 **전에** 올라간다(`attempts.set(entry.id, tried)`). 그래서
  // 첫 시도는 1 로 세어지고, 위 순서가 지켜지면 그 뒤로 **더 세어지지 않는다** — 이 이슈가
  // 말하는 "재시도 0회"의 실제 모양이다. 회계 자체가 사라지면(다른 실패까지 안 세면) 이 단언이
  // 빨개진다.
  it('항목 시도 회계는 그대로 있다 — 이번 변경이 재시도 전반을 죽이지 않았다', () => {
    expect(source).toContain('attempts.set(entry.id, tried)');
    expect(source).toContain('if (exhausted(tried))');
  });
});

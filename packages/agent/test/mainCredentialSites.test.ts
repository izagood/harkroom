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
/**
 * 2026-09-08 병렬화로 **멘션 턴의 실패 경로가 여기로 옮겨왔다**(main.ts 는 배치를 스케줄러에
 * 넘기기만 한다). 기동·폴 루프의 두 자리는 여전히 main.ts 에 있으므로 두 소스를 함께 본다 —
 * 세 자리가 한 파일에 있다는 것은 이 회귀선의 주장이 아니었다. 주장은 "세 자리 **전부**에
 * 걸려 있다" 이고, 그것은 파일이 갈려도 그대로 참이어야 한다.
 */
const schedulerSource = readFileSync(path.resolve(__dirname, '../src/mentionScheduler.ts'), 'utf8');

/** `guardedNear` 의 스케줄러판. 판정 호출 이름이 hooks 경유라 문자열이 다르다. */
const guardedNearInScheduler = (anchor: string, within = 14): boolean => {
  const at = schedulerSource.indexOf(anchor);
  if (at < 0) throw new Error(`앵커를 못 찾았다(코드가 바뀌었으면 이 테스트를 고쳐라): ${anchor}`);
  const window = schedulerSource.slice(at, at + schedulerSource.slice(at).split('\n').slice(0, within).join('\n').length);
  return window.includes('deps.hooks.exitIfUnrecoverable(err)');
};

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

  it('멘션 턴의 catch (mentionScheduler 로 이동)', () => {
    expect(guardedNearInScheduler('// 재시도로 낫지 않는 실패는 여기서 걸러')).toBe(true);
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
    // 스케줄러도 자기 판정을 짓지 않는다 — 주입받은 훅 하나만 부른다.
    // **호출만** 잰다(`process.exit(`) — 주석이 그 이름을 언급하는 것은 코드가 아니다.
    expect(schedulerSource.match(/process\.exit\(/g)).toBeNull();
    expect(schedulerSource).not.toContain("from './exit.js'");
  });

  // #340 — 자리에 있는 것만으로는 부족하다. 멘션 턴의 catch 에서 판정이 **재시도 회계보다
  // 뒤에** 있으면, 러너는 죽기는 하되 그 전에 `attempts` 를 올리고 `failed` 를 세운 뒤다.
  // 그러면 "재시도 0회"라는 이 이슈의 요구가 조용히 깨진다(3회 재시도 뒤에 죽어도 "종료했다"는
  // 단언은 여전히 초록이다). 그래서 **순서**를 따로 고정한다.
  it('멘션 catch 에서 판정이 재시도 회계보다 앞이다 — 실패 계상 전에 죽는다', () => {
    // **멘션 catch 안**에서만 잰다. 파일 앞쪽에도 같은 이름이 있으므로(기동 자리, import 줄)
    // 첫 등장으로 재면 순서 비교가 언제나 참이 되어 아무것도 지키지 못한다.
    const at = schedulerSource.indexOf('// 재시도로 낫지 않는 실패는 여기서 걸러');
    expect(at).toBeGreaterThan(0);
    const guard = schedulerSource.indexOf('deps.hooks.exitIfUnrecoverable(err);', at);
    // 회계의 자리표: 실패를 (n/MAX_ATTEMPTS) 로 세는 그 줄이다.
    const accounting = schedulerSource.indexOf('답변 실패 (', at);
    const notice = schedulerSource.indexOf('FAILURE_NOTICE', at);
    expect(guard).toBeGreaterThan(0);
    expect(accounting).toBeGreaterThan(guard);
    expect(notice).toBeGreaterThan(guard);
  });

  // 항목 시도 횟수는 turn 을 부르기 **전에** 올라간다(`attempts.set(entry.id, tried)`). 그래서
  // 첫 시도는 1 로 세어지고, 위 순서가 지켜지면 그 뒤로 **더 세어지지 않는다** — 이 이슈가
  // 말하는 "재시도 0회"의 실제 모양이다. 회계 자체가 사라지면(다른 실패까지 안 세면) 이 단언이
  // 빨개진다.
  it('항목 시도 회계는 그대로 있다 — 이번 변경이 재시도 전반을 죽이지 않았다', () => {
    expect(schedulerSource).toMatch(/attempts\.set\(entry\.id, \{ tried/);
    expect(schedulerSource).toContain('if (exhausted(tried))');
  });
});

// 세션 id 충돌(2026-09-07 19:03 실측)도 재시도로 낫지 않는다 — 3회가 176·185·278ms 만에
// 같은 자리에서 실패했다. 자격증명과 다른 점은 **러너가 살아 있어야 한다**는 것이다: 그
// 스레드 하나의 상태 문제이고 다른 스레드는 멀쩡하다. 그래서 `exitIfUnrecoverable` 이
// 아니라 사용량 한도와 같은 세 번째 갈래로 다루고, 여기서는 그것이 **재시도 회계보다
// 앞에** 걸려 있는지만 본다 — 뒤에 있으면 3회를 태우는 옛 동작이 그대로 남는다.
describe('세션 id 충돌은 재시도 회계에 들어가지 않는다', () => {
  const mentionCatchAt = (): number => {
    const at = schedulerSource.indexOf('// 재시도로 낫지 않는 실패는 여기서 걸러');
    expect(at).toBeGreaterThan(0);
    return at;
  };

  it('멘션 catch 에서 세션 충돌을 판정한다', () => {
    expect(schedulerSource.indexOf('isSessionIdConflict(err)', mentionCatchAt())).toBeGreaterThan(0);
  });

  it('그 판정이 재시도 회계보다 앞이다', () => {
    const at = mentionCatchAt();
    const conflict = schedulerSource.indexOf('isSessionIdConflict(err)', at);
    const accounting = schedulerSource.indexOf('답변 실패 (', at);
    expect(conflict).toBeGreaterThan(0);
    expect(accounting).toBeGreaterThan(conflict);
  });

  // 러너를 죽이면 안 된다. 판정이 `exitIfUnrecoverable` 을 타면 다른 스레드의 대기 멘션까지
  // 함께 잃는다 — 이 실패에는 그럴 이유가 없다.
  it('러너를 죽이지 않는다 — 판정은 exit 판정과 별개다', () => {
    expect(schedulerSource).toContain('sessionConflictNotice');
    const conflict = schedulerSource.indexOf('isSessionIdConflict(err)', mentionCatchAt());
    const between = schedulerSource.slice(conflict, schedulerSource.indexOf('답변 실패 (', conflict));
    expect(between).not.toContain('exitIfUnrecoverable');
  });
});

// 한도 경로는 tail 을 로그에 남기지 않았다 — 그래서 2026-09-07 19:03 사건에서 러너가
// "풀림: 알 수 없음"을 찍은 **이유**를 알 수 없었다. 세션 파일에는 CLI 가 낸 문구
// (`resets 10:50pm (Asia/Seoul)`)가 분명히 있었는데 판정은 시각을 못 읽었다. 둘 사이에
// tail 원문이 있어야 어디서 어긋났는지 보인다.
describe('한도 판정은 tail 을 로그에 남긴다', () => {
  it('시각을 못 읽었을 때 원문을 함께 찍는다', () => {
    const at = schedulerSource.indexOf('사용량 한도 — 재시도하지 않는다');
    expect(at).toBeGreaterThan(0);
    const line = schedulerSource.slice(at, schedulerSource.indexOf('\n', at));
    expect(line).toContain('err instanceof Error');
  });
});

/**
 * **네 번째 자리 — 아무도 await 하지 않은 거절**(2026-09-08 14:04 실측).
 *
 * 위 세 자리는 모두 `try/catch` 다. 그날 러너를 죽인 것은 그 셋 중 어디도 아니었다:
 * 드레인(SIGTERM)을 받은 러너가 턴을 끝내고 폴 루프를 빠져나가 `relay.stop()` → `종료`
 * 까지 정상으로 출력한 **뒤**, 떠 있던 MCP send 하나가 401 로 거절되며 프로세스를 죽였다.
 * 스택에 애플리케이션 프레임이 하나도 없었다 — 아무도 그 promise 를 들고 있지 않았다.
 *
 * 결과는 종료 코드 1 과 생 `StreamableHTTPError` 스택이었고, 앱이 읽는 것은 78 과 마커
 * 한 줄뿐이므로(`exit.ts` 주석) 앱은 그 죽음을 `needs_reissue` 로 칠할 근거를 못 받았다.
 * 사람이 화면에서 본 것은 이유 없이 사라진 러너다.
 *
 * **판정을 새로 만들지 않는다** — 같은 `exitIfUnrecoverable` 을 태운다. 그것이 물러날
 * 사유가 아니라고 하면 **다시 던져 Node 의 기본 동작으로 돌려보낸다**: 모든 거절을 로그로
 * 삼키면 이번 사고와 무관한 결함들이 조용히 묻힌다. 그물은 사유를 아는 거절 하나만 걷는다.
 *
 * 행동 층은 `credentialRejectedExit.test.ts` 가 프로세스를 띄워 확인한다. 여기서 재는 것은
 * 그 파일 머리가 적은 대로 **자리**다 — main.ts 는 import 할 수 없다.
 */
describe('아무도 await 하지 않은 거절도 같은 판정을 지난다 (2026-09-08)', () => {
  it('unhandledRejection 그물이 있다', () => {
    expect(source).toContain("process.on('unhandledRejection'");
  });

  it('그물도 `exit.ts` 의 같은 판정을 태운다 — 사유 판정을 두 벌로 만들지 않는다', () => {
    const at = source.indexOf("process.on('unhandledRejection'");
    expect(at).toBeGreaterThan(0);
    const guard = source.indexOf('exitIfUnrecoverable(', at);
    expect(guard).toBeGreaterThan(0);
    expect(guard - at).toBeLessThan(600);
  });

  // 삼키지 않는다: 판정이 "물러날 사유가 아니다"라고 하면 Node 의 기본 동작(크게 죽는다)을
  // 그대로 둔다. 이 단언이 없으면 그물이 모든 거절을 로그 한 줄로 덮는 쪽으로 흘러간다.
  it('물러날 사유가 아닌 거절은 삼키지 않고 다시 던진다', () => {
    const at = source.indexOf("process.on('unhandledRejection'");
    const guard = source.indexOf('exitIfUnrecoverable(', at);
    const rethrow = source.indexOf('throw reason;', guard);
    expect(rethrow).toBeGreaterThan(guard);
    expect(rethrow - guard).toBeLessThan(600);
  });
});

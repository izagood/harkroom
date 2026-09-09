import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 2026-09-07 16:06·16:09 의 회귀선.
 *
 * forge 의 claude 로그인이 만료되자 러너는 3회 재시도를 태우고
 * "(답변에 실패했습니다 — 운영자 확인이 필요합니다)"만 남겼다. 무엇을 확인해야 하는지는
 * 어디에도 없었다 — 사용자의 말: *"그럼 다시 로그인 할 수 있게 알려줬어야지"*.
 *
 * 판정(`policy.ts`)과 문구(`prompt.ts`)는 각자 단위 테스트가 있다. **배선은 다른 사실**이고,
 * `main.ts` 는 top-level await 로 진짜 서버에 붙으려 들어 import 로 확인할 수 없다
 * (instanceWiring.test.ts 가 같은 이유로 소스를 읽는다).
 *
 * 이 배선이 빠지면 판정과 문구가 다 있는데도 사람은 아무것도 못 본다 — 초록으로 지나가는
 * 실패라 소스로 못 박는다.
 */
const SRC = new URL('../src/', import.meta.url).pathname;
const readSrc = (name: string) => readFile(join(SRC, name), 'utf8');

describe('자격증명·한도 통지 배선', () => {
  it('하네스 로그인 만료는 물러나기 전에 스레드에 통지한다', async () => {
    // 2026-09-08: 멘션 실패 경로가 mentionScheduler 로 옮겨갔다. 순서 계약은 그대로다 —
    // 아래 판정이 process.exit 을 부르므로, 통지가 그보다 뒤에 있으면 영영 발화되지 않는다.
    const main = await readSrc('mentionScheduler.ts');
    const notice = main.indexOf('deps.hooks.noticeHarnessLogin(err');
    const exit = main.indexOf('deps.hooks.exitIfUnrecoverable(err)');
    expect(notice).toBeGreaterThan(0);
    // **순서가 계약이다.** `exitIfUnrecoverable` 는 `process.exit` 을 부른다 — 뒤에 두면
    // 그 줄에 닿지 못하고, 사람은 다시 아무것도 못 본다.
    expect(notice).toBeLessThan(exit);
  });

  it('통지 대상은 앵커다 — 답이 스레드로 가는데 통지만 채널 최상위에 남으면 못 본다(#82·#98)', async () => {
    // 로그인 통지는 main.ts 의 noticeIfHarnessLogin 에 남아 있고(정의를 읽어야 한다),
    // 한도 통지는 스케줄러로 옮겨갔다. 둘 다 앵커로 간다는 것이 이 검사의 주장이다.
    const main = await readSrc('main.ts');
    expect(main).toMatch(/harnessLoginNotice\([\s\S]{0,120}?\),\s*anchor,?\s*\)/);
    const src = await readSrc('mentionScheduler.ts');
    // 한도 통지는 2026-09-09 에 `post` → `fail` 로 바뀌었다(평문은 스레드 머리를 `끝남` 으로
    // 만든다 — `murmur.ts::fail` 주석). **이 검사가 지키는 것은 그대로다**: 통지가 앵커로
    // 간다는 것. 그래서 뒤에 옵션 객체가 붙는 것만 허용하고 `anchor` 는 계속 요구한다.
    expect(src).toMatch(/quotaNotice\(quota\.resetsAt\),\s*anchor\s*[,)]/);
  });

  it('사용량 한도는 재시도 회계에 들어가지 않는다', async () => {
    // 회계의 자리표가 `failed = true;` 에서 "답변 실패 (n/MAX)" 줄로 바뀌었다(병렬화로
    // 전역 실패 플래그가 사라졌다). 지키는 것은 같다: 한도는 그 줄에 닿기 전에 빠져나간다.
    const main = await readSrc('mentionScheduler.ts');
    const quota = main.indexOf('isQuotaExhausted(err)');
    const failed = main.indexOf('답변 실패 (', quota);
    expect(quota).toBeGreaterThan(0);
    // 한도 분기가 `failed = true` **앞**에서 `continue` 로 빠져야 3회를 태우지 않는다.
    // `continue` 가 아니라 `return` 인 이유: 이 경로는 배치 루프가 아니라 턴 하나를 도는
    // async 함수 안이다(runOne). 빠져나간다는 사실은 같다.
    expect(main.slice(quota, failed)).toContain('return;');
  });

  it('하네스 이름을 정의에서 읽는다 — 지어내지 않는다(#368)', async () => {
    const main = await readSrc('main.ts');
    expect(main).toMatch(/harnessBinaryName\(\w+\.harness\)/);
  });
});

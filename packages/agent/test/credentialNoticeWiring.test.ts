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
    const main = await readSrc('main.ts');
    const notice = main.indexOf('harnessLoginNotice');
    const exit = main.indexOf('exitIfUnrecoverable(err)');
    expect(notice).toBeGreaterThan(0);
    // **순서가 계약이다.** `exitIfUnrecoverable` 는 `process.exit` 을 부른다 — 뒤에 두면
    // 그 줄에 닿지 못하고, 사람은 다시 아무것도 못 본다.
    expect(notice).toBeLessThan(exit);
  });

  it('통지 대상은 앵커다 — 답이 스레드로 가는데 통지만 채널 최상위에 남으면 못 본다(#82·#98)', async () => {
    const main = await readSrc('main.ts');
    expect(main).toMatch(/harnessLoginNotice\([\s\S]{0,120}?\),\s*anchor,?\s*\)/);
    expect(main).toMatch(/quotaNotice\(quota\.resetsAt\),\s*anchor\)/);
  });

  it('사용량 한도는 재시도 회계에 들어가지 않는다', async () => {
    const main = await readSrc('main.ts');
    const quota = main.indexOf('isQuotaExhausted(err)');
    const failed = main.indexOf('failed = true;', quota);
    expect(quota).toBeGreaterThan(0);
    // 한도 분기가 `failed = true` **앞**에서 `continue` 로 빠져야 3회를 태우지 않는다.
    expect(main.slice(quota, failed)).toContain('continue;');
  });

  it('하네스 이름을 정의에서 읽는다 — 지어내지 않는다(#368)', async () => {
    const main = await readSrc('main.ts');
    expect(main).toMatch(/harnessBinaryName\(\w+\.harness\)/);
  });
});

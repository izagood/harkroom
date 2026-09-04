// #337 의 배선 회귀선 — instanceWiring.test.ts 와 같은 방식으로 **소스를 읽는다.**
// main.ts 는 top-level await 로 진짜 서버에 붙으려 들어 import 로 확인할 수 없고, 손으로
// 배선을 흉내낸 테스트는 main 이 이 부품들을 안 써도 초록이다 — 그러면 인터랙티브 열기는
// 코드로는 존재하고 러너에서는 없는 기능이 된다.
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const readSrc = (name: string) => readFile(join(SRC, name), 'utf8');

describe('#337 러너가 인터랙티브 경로를 실제로 배선한다', () => {
  it('relay 의 onInteractiveOpen 이 매니저로 간다', async () => {
    const main = await readSrc('main.ts');
    expect(main).toContain('onInteractiveOpen');
    expect(main).toContain('createInteractiveManager');
    // 매니저와 멘션 턴이 **같은** 레지스트리를 본다 — 갈라지면 같은 세션에 PTY 가 둘 뜬다.
    expect(main).toMatch(/registry,/);
  });

  it('러너 SIGTERM 이 인터랙티브 PTY 를 회수한다', async () => {
    const main = await readSrc('main.ts');
    expect(main).toMatch(/interactive\?\.shutdown\(\)/);
  });

  it('유예 분기가 attempts 증가·markRead 보다 앞에 있다 — 유예가 시도 횟수를 갉아먹으면 안 된다', async () => {
    const main = await readSrc('main.ts');
    const deferIdx = main.indexOf("controlling?.kind === 'interactive'");
    const attemptsIdx = main.indexOf('attempts.set(entry.id, tried)');
    expect(deferIdx).toBeGreaterThan(-1);
    expect(attemptsIdx).toBeGreaterThan(-1);
    expect(deferIdx).toBeLessThan(attemptsIdx);
    // 유예 분기 안에 markRead(done.push)가 없다 — inbox 가 곧 큐다(스펙 §5-2 결정 6).
    const deferBlock = main.slice(deferIdx, main.indexOf('continue;', deferIdx));
    expect(deferBlock).not.toContain('done.push');
    expect(deferBlock).not.toContain('markRead');
  });

  it('유예만 있고 완료가 없는 배치는 고정 5초를 쉰다 — 조종이 끝날 때까지 타이트 루프가 되면 안 된다', async () => {
    const main = await readSrc('main.ts');
    expect(main).toMatch(/deferred > 0 && done\.length === 0/);
    expect(main).toMatch(/await sleep\(5_000\)/);
  });
});

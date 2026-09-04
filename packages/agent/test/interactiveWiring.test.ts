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
    // #384: 판정 자체는 `TurnRegistry.controlOf` 로 옮겼다(도는 인터랙티브 턴 + 이어받기
    // 예약을 한 술어로 본다 — turnRegistry.test.ts 가 그 판정을 지킨다). 여기서 재는 것은
    // 그 판정을 **부르는 자리**가 여전히 attempts 증가보다 앞이라는 사실이다.
    const deferIdx = main.indexOf('registry.controlOf(threadKey)');
    const attemptsIdx = main.indexOf('attempts.set(entry.id, tried)');
    expect(deferIdx).toBeGreaterThan(-1);
    expect(attemptsIdx).toBeGreaterThan(-1);
    expect(deferIdx).toBeLessThan(attemptsIdx);
    // 유예 분기 안에 markRead(done.push)가 없다 — inbox 가 곧 큐다(스펙 §5-2 결정 6).
    const deferBlock = main.slice(deferIdx, main.indexOf('continue;', deferIdx));
    expect(deferBlock).not.toContain('done.push');
    expect(deferBlock).not.toContain('markRead');
  });

  /**
   * #384 이어받기의 배선. 예약을 푸는 자리는 **멘션 턴이 완전히 끝난 뒤**여야 한다 —
   * 레지스트리 해제(턴의 finally)는 세션 상태 저장보다 앞이라, 그때 띄우면 이어받기 턴이
   * 옛 레코드를 읽어 같은 세션을 새로 시작하려 든다. 그래서 main 루프가 그 자리를 갖고,
   * 이 회귀선이 그것을 지킨다: 이 호출이 사라지면 [이어받기] 는 영원히 기다리기만 한다.
   */
  it('멘션 턴 뒤에 이어받기 예약을 푼다 — 성공·실패 어느 경로에서도(finally)', async () => {
    const main = await readSrc('main.ts');
    const resumeIdx = main.indexOf('interactive?.resumeHandoff(threadKey)');
    expect(resumeIdx).toBeGreaterThan(-1);
    // 턴 호출보다 뒤다(그 전에 부르면 예약이 도는 턴과 겹친다).
    expect(main.indexOf('await runMentionTurn(')).toBeLessThan(resumeIdx);
    // 실패 경로에도 있어야 한다 — 예약을 남기면 그 스레드의 멘션이 영원히 유예된다.
    const finallyIdx = main.lastIndexOf('} finally {', resumeIdx);
    expect(finallyIdx).toBeGreaterThan(-1);
  });

  it('유예만 있고 완료가 없는 배치는 고정 5초를 쉰다 — 조종이 끝날 때까지 타이트 루프가 되면 안 된다', async () => {
    const main = await readSrc('main.ts');
    expect(main).toMatch(/deferred > 0 && done\.length === 0/);
    expect(main).toMatch(/await sleep\(5_000\)/);
  });
});

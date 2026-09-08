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
    // 2026-09-08: 이 배선이 mentionScheduler 로 옮겨갔다. 불변식은 그대로다 — 유예가 시도
    // 횟수를 갉아먹으면 오래 조종할수록 그 멘션이 MAX_ATTEMPTS 로 조용히 버려진다.
    const src = await readSrc('mentionScheduler.ts');
    const deferIdx = src.indexOf('deps.registry.controlOf(threadKey)');
    const attemptsIdx = src.indexOf('attempts.set(entry.id, { tried');
    expect(deferIdx).toBeGreaterThan(-1);
    expect(attemptsIdx).toBeGreaterThan(-1);
    expect(deferIdx).toBeLessThan(attemptsIdx);
    // 유예 블록 안에서 읽음 처리하지 않는다 — inbox 의 at-least-once 가 그대로 큐다.
    const deferBlock = src.slice(deferIdx, src.indexOf('continue;', deferIdx));
    expect(deferBlock).not.toContain('markRead');
  });

  /**
   * #384 이어받기의 배선. 예약을 푸는 자리는 **멘션 턴이 완전히 끝난 뒤**여야 한다 —
   * 레지스트리 해제(턴의 finally)는 세션 상태 저장보다 앞이라, 그때 띄우면 이어받기 턴이
   * 옛 레코드를 읽어 같은 세션을 새로 시작하려 든다. 그래서 main 루프가 그 자리를 갖고,
   * 이 회귀선이 그것을 지킨다: 이 호출이 사라지면 [이어받기] 는 영원히 기다리기만 한다.
   */
  it('멘션 턴 뒤에 이어받기 예약을 푼다 — 성공·실패 어느 경로에서도(finally)', async () => {
    // main.ts 는 훅으로 넘기고, 그 훅을 finally 에서 부르는 것은 스케줄러다.
    const main = await readSrc('main.ts');
    expect(main).toContain('interactive?.resumeHandoff(threadKey)');
    const src = await readSrc('mentionScheduler.ts');
    const resumeIdx = src.indexOf('deps.hooks.resumeHandoff(threadKey)');
    expect(resumeIdx).toBeGreaterThan(-1);
    // 턴 호출보다 뒤다(그 전에 부르면 예약이 도는 턴과 겹친다).
    expect(src.indexOf('deps.runMentionTurn(')).toBeLessThan(resumeIdx);
    // 실패 경로에도 있어야 한다 — 예약을 남기면 그 스레드의 멘션이 영원히 유예된다.
    const finallyIdx = src.lastIndexOf('} finally {', resumeIdx);
    expect(finallyIdx).toBeGreaterThan(-1);
  });

  it('유예만 있고 완료가 없는 배치는 고정 5초를 쉰다 — 조종이 끝날 때까지 타이트 루프가 되면 안 된다', async () => {
    const main = await readSrc('main.ts');
    // 2026-09-08: 판정의 재료가 done/deferred 에서 AdmitOutcome 으로 바뀌었다. 지키는 것은
    // 같다 — 아무것도 새로 못 띄운 폴이 곧바로 다시 폴하면 타이트 루프다. 병렬화로 `blocked`
    // (인플라이트라 미읽음이 그대로 남은 entry)가 같은 성질을 갖게 돼 함께 본다.
    expect(main).toMatch(/outcome\.started === 0 && outcome\.deferred \+ outcome\.blocked > 0/);
    expect(main).toMatch(/await sleep\(5_000\)/);
  });
});

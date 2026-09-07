import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 깨움 배선의 회귀선(마이그레이션 040).
 *
 * `mentionTurn` 의 단위 테스트는 "깨어난 턴이 오면 무엇을 하는가"를 지킨다. 러너가 실제로
 * inbox 항목의 `reason === 'wake'` 를 그 인자로 **바꿔 넘기는지**는 다른 사실이고,
 * `main.ts` 는 top-level await 로 진짜 서버에 붙으려 들어 import 로 확인할 수 없다
 * (instanceWiring.test.ts 가 같은 이유로 소스를 읽는다).
 *
 * 이 배선이 빠지면 러너는 깨움 항목을 **평범한 멘션으로** 처리한다. 그러면 델타에 남는
 * 것이 자기가 쓴 대기 줄뿐이라 프롬프트가 비고, 비면 하네스를 돌리지 않고 커서만 전진한다 —
 * 걸어 둔 기다림이 아무 흔적 없이 사라지고, 사람이 보는 스레드에는 "기다린다"는 줄만
 * 영원히 남는다. 초록으로 지나가는 실패라 소스로 못 박는다.
 */
const SRC = new URL('../src/', import.meta.url).pathname;
const readSrc = (name: string) => readFile(join(SRC, name), 'utf8');

describe('깨움 배선', () => {
  it("main.ts 가 reason === 'wake' 를 보고 턴에 사유를 싣는다", async () => {
    const main = await readSrc('main.ts');
    expect(main).toContain("entry.reason === 'wake'");
    // 사유는 그 대기 줄의 본문이다 — 서버가 wake 메시지의 body 에 사유를 넣었다(agentWakes.ts).
    expect(main).toMatch(/wake:\s*\{\s*reason:\s*mention\.body/);
  });

  it('mentionTurn 이 그 사유를 프롬프트 조립에 넘긴다', async () => {
    const src = await readSrc('mentionTurn.ts');
    expect(src).toMatch(/wake:\s*target\.wake/);
  });
});

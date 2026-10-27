/**
 * 스토리보드 여정을 브라우저로 돈다 — 결과는 「대체(브라우저)」다(playwright.config.ts 머리말).
 * `runners` 에 `browser` 가 있는 여정마다 시험 하나. 여정끼리 상태가 새지 않게 여정마다 새 채널·새 컨텍스트를
 * 쓰고, 권한을 바꾼 여정은 끝에서 되돌린다(같은 서버를 회차 안에서 함께 쓴다).
 */
import { expect, test } from '@playwright/test';
import { loadStoryboard } from '../src/stories.js';
import { runWebJourney } from './storyRunner.js';

const { journeys } = loadStoryboard();
/** 지금 브라우저로 도는 여정. 나머지(J7·J10·J12·J13·J14)는 핸들러가 붙는 PR 에서 늘린다. */
const RUN = ['J3', 'J4', 'J5', 'J8', 'J9'];

for (const journey of journeys.filter((j) => RUN.includes(j.id))) {
  test(`${journey.id} ${journey.title}`, async ({ browser }) => {
    expect(journey.runners, `${journey.id} 는 browser 러너를 달아야 한다`).toContain('browser');
    const results = await runWebJourney(browser, journey);
    test.info().annotations.push({ type: 'steps', description: JSON.stringify(results) });
    expect(results.some((r) => r.outcome === 'passed' && r.act.startsWith('ui.')), `${journey.id} 는 화면 단계를 하나도 못 봤다`).toBe(true);
  });
}

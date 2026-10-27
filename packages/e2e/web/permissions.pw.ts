/**
 * 화면 러너의 첫 시험 — 여러 사람이 각자 로그인해 **권한 차이가 화면에 나오는지**를 본다.
 * 결과는 「대체(브라우저)」다(playwright.config.ts 머리말).
 * 여정 전체(J2~J5·J8·J9)는 다음 PR 에서 `stories/` 를 읽어 돈다. 여기는 기반이 도는지만 본다.
 */
import { expect, test } from '@playwright/test';
import { loginAs } from './session.js';

test('J3 일부: 관리자에게는 [+ 채널] 이 있고 멤버·게스트에게는 없다', async ({ browser }) => {
  const admin = await loginAs(browser, 'P2');
  const member = await loginAs(browser, 'P4');
  const guest = await loginAs(browser, 'P6');
  await expect(admin.getByTestId('add-channel')).toHaveCount(1);
  await expect(member.getByTestId('add-channel')).toHaveCount(0);
  await expect(guest.getByTestId('add-channel')).toHaveCount(0);
});

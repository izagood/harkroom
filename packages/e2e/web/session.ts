import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';

export const SEED_FILE = join(import.meta.dirname, '.seed.json');

export interface Seed {
  server: string;
  password: string;
  /** `role` 은 시드가 둔 역할 — 여정이 역할을 바꾸면 끝에서 이 값으로 되돌린다. */
  accounts: Record<string, { id: string; handle: string; role: 'owner' | 'admin' | 'member' | 'guest' }>;
}

export function readSeed(): Seed {
  return JSON.parse(readFileSync(SEED_FILE, 'utf8')) as Seed;
}

/**
 * 페르소나 하나로 로그인한 화면. 사람마다 **브라우저 컨텍스트를 따로** 연다 — 저장소·쿠키가 섞이면
 * 두 사람이 한 계정으로 보인다(여러 사람 여정의 전제).
 */
export async function loginAs(browser: Browser, personaId: string): Promise<Page> {
  const seed = readSeed();
  const account = seed.accounts[personaId];
  if (!account) throw new Error(`${personaId} 는 시드되지 않았다(web/seed.ts SEEDED)`);
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  // 연결 화면: 서버 주소 · 로그인 ID · 비밀번호. 앞의 두 칸에는 testid 가 없어 순서로 잡는다.
  const fields = page.locator('input');
  await fields.nth(0).fill(seed.server);
  await fields.nth(1).fill(account.handle);
  await page.getByTestId('connect-password').fill(seed.password);
  await page.getByTestId('connect-password').press('Enter');
  await page.getByText(account.handle, { exact: true }).first().waitFor();
  return page;
}

/**
 * 브라우저 화면 러너 — 데스크톱 웹뷰(`packages/desktop` 의 vite 산출물)를 브라우저로 띄워 여정을 돈다.
 *
 * **결과는 「대체(브라우저)」다.** Tauri 앱 실물이 아니다: 오퍼레이터·러너·알림·업데이터 같은 Tauri 쪽
 * 기능은 브라우저에 없고(코드가 `__TAURI_INTERNALS__` 를 보고 비켜 간다), WebKit 이 아니라 Chromium 이다.
 * 여기서 보는 것은 "사람마다 다른 권한이 화면에 어떻게 나오나"와 "서버 신호가 열린 화면에 반영되나"다.
 *
 * 서버는 이 설정이 띄우지 않는다 — `E2E_SERVER` 로 받는다(CI 는 docker compose 로 PR 커밋 이미지를 굽는다).
 * 화면은 `vite preview` 로 띄운다(먼저 `pnpm --filter @harkroom/desktop exec vite build`).
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: '.',
  // vitest 의 기본 include(`*.spec.ts`)와 겹치지 않게 다른 접미사를 쓴다.
  testMatch: '**/*.pw.ts',
  globalSetup: './seed.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'report' }]] : 'list',
  outputDir: 'results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm --filter @harkroom/desktop exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000, hookTimeout: 120_000, pool: 'forks',
    // Postgres 컨테이너는 스위트 전체에 하나다(helpers/globalSetup.ts). 파일 격리는 컨테이너가
    // 아니라 database 로 준다 — 격리에 필요한 것은 빈 스키마이지 커널 하나가 아니었다.
    globalSetup: ['./test/helpers/globalSetup.ts'],
    // 서버 로깅 기본값은 info 다. 스위트 출력이 요청 로그로 오염되지 않게 여기서 잠재운다 —
    // 로깅 자체를 검증하는 테스트는 logLevel 을 명시적으로 올린다.
    env: { LOG_LEVEL: 'silent' },
  },
});

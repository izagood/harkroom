import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000, hookTimeout: 120_000, pool: 'forks',
    // 서버 로깅 기본값은 info 다. 스위트 출력이 요청 로그로 오염되지 않게 여기서 잠재운다 —
    // 로깅 자체를 검증하는 테스트는 logLevel 을 명시적으로 올린다.
    env: { LOG_LEVEL: 'silent' },
  },
});

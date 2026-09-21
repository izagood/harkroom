/**
 * 오퍼레이터의 시크릿 — 커뮤니티별 오퍼레이터 토큰(`hkop_…`). 스펙 2026-09-20 §3.
 *
 * 데스크탑 키체인이 아니라 오퍼레이터가 소유한다. 근거는 `claudeAccounts.ts` 와 같다 —
 * 웹뷰에는 로컬을 다룰 표면이 없고, 오퍼레이터가 이미 그 경계다. 그리고 headless
 * 오퍼레이터(단계 6)에는 앱도 키체인도 없다 — 같은 코드가 양쪽에서 돌아야 한다.
 *
 * 첫 판은 **0600 파일**이다. OS 키체인으로 옮기는 것은 이 인터페이스 뒤에서 한다 —
 * 호출자는 `getToken`·`setToken` 만 안다.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface OperatorSecrets {
  getToken(baseUrl: string): Promise<string | null>;
  setToken(baseUrl: string, token: string): Promise<void>;
  clearToken(baseUrl: string): Promise<void>;
}

/** 파일명은 baseUrl 의 해시다 — URL 문자를 경로에 그대로 쓰지 않는다. */
function fileFor(dir: string, baseUrl: string): string {
  const key = createHash('sha256').update(baseUrl.replace(/\/+$/, '')).digest('hex').slice(0, 16);
  return join(dir, `operator-token.${key}`);
}

export function fileSecrets(dir: string): OperatorSecrets {
  return {
    async getToken(baseUrl) {
      try { return (await readFile(fileFor(dir, baseUrl), 'utf8')).trim() || null; } catch { return null; }
    },
    async setToken(baseUrl, token) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(fileFor(dir, baseUrl), `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    async clearToken(baseUrl) {
      await rm(fileFor(dir, baseUrl), { force: true });
    },
  };
}

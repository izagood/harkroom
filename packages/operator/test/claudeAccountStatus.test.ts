/**
 * 계정의 로그인 상태·정체를 **디스크에서** 읽는다.
 *
 * ## 왜 `claude auth status --json` 을 안 쓰는가 — 2026-09-08 실측
 *
 * 그 명령은 **Keychain 에 있는 자격증명을 못 본다.** 사용자가 앱에서 계정 넷을 등록한 뒤
 * 관측한 것이 이것이다:
 *
 * | 관측 | 결과 |
 * |---|---|
 * | `claude auth status --json` (계정 넷 전부) | `loggedIn: false` |
 * | Keychain `Claude Code-credentials-<sha8(configDir)>` | 네 항목 **모두 존재**, 읽기 가능, 토큰 완전 |
 * | `claude -p` 로 실제 턴 | **네 계정 다 `OK`, rc=0** |
 *
 * 즉 런타임은 Keychain 을 읽고 `auth status` 는 파일(`<configDir>/.credentials.json`)만 읽는다.
 * 앞선 실측(2026-09-07)이 이것을 놓친 이유: 심볼릭 링크 실험은 **파일이 있는** 경우였고
 * "Keychain 만 있는" 경우를 재지 않았다.
 *
 * 그 결과 설정 화면이 **멀쩡한 계정 넷을 전부 "Not signed in" 으로** 그렸다. 사용자가 본
 * 것이 그것이다.
 *
 * ## 그래서 무엇을 읽는가
 *
 * - **정체**는 `<configDir>/.claude.json` 의 `oauthAccount`(`emailAddress`·`organizationName`).
 *   **비밀값이 아니다.** 미로그인 디렉터리에는 이 키가 **없다**(실측) — 그래서 존재 자체가
 *   "이 디렉터리로 로그인한 적이 있다"의 신호다.
 * - **자격증명 존재**는 파일 또는 Keychain 항목. 프로세스를 하나 덜 띄우고(claude 는 Node
 *   앱이라 무겁다) 정확하다.
 *
 * ## 이 판정의 한계를 알고 쓴다
 *
 * "자격증명이 있다"는 "토큰이 아직 유효하다"가 아니다. refresh 토큰이 만료된 계정도 여기서는
 * 로그인으로 보인다 — 그 사실은 턴을 돌려 봐야 안다. 그래서 러너가 턴 시각에 발견하고
 * **다음 계정으로 넘어간다**(`switchesAccount` 가 `oauthsessionexpired` 를 잡는다). 화면이
 * 그 판정을 흉내내려고 토큰을 읽지 않는다.
 */
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { accountStatusFromDisk } from '../src/claudeAccounts.js';

const NO_KEYCHAIN = vi.fn(async () => false);
const HAS_KEYCHAIN = vi.fn(async () => true);

async function dir(files: Record<string, unknown> = {}): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'acct-status-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(d, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return d;
}

describe('accountStatusFromDisk', () => {
  it('Keychain 에만 자격증명이 있어도 로그인으로 본다 — 이것이 이번 결함이다', async () => {
    // `claude auth status` 는 이 경우를 미로그인으로 답한다(실측). 그것을 그대로 믿으면
    // 멀쩡한 계정이 전부 "Not signed in" 으로 그려진다.
    const d = await dir({ '.claude.json': { oauthAccount: { emailAddress: 'a@b.c', organizationName: 'Org' } } });
    const s = await accountStatusFromDisk(d, HAS_KEYCHAIN);
    expect(s.loggedIn).toBe(true);
    expect(s.email).toBe('a@b.c');
    expect(s.orgName).toBe('Org');
  });

  it('파일에만 있어도 로그인으로 본다', async () => {
    // 비 macOS 와, 파일 폴백으로 쓰인 계정의 경로다.
    const d = await dir({
      '.claude.json': { oauthAccount: { emailAddress: 'a@b.c', organizationName: 'Org' } },
      '.credentials.json': '{}',
    });
    expect((await accountStatusFromDisk(d, NO_KEYCHAIN)).loggedIn).toBe(true);
  });

  it('자격증명이 어디에도 없으면 미로그인이다', async () => {
    const d = await dir({ '.claude.json': { oauthAccount: { emailAddress: 'a@b.c' } } });
    expect((await accountStatusFromDisk(d, NO_KEYCHAIN)).loggedIn).toBe(false);
  });

  it('oauthAccount 가 없으면 미로그인이다 — 미로그인 디렉터리에는 그 키가 없다', async () => {
    // 실측: 갓 만든 config 디렉터리의 `.claude.json` 에는 `oauthAccount` 가 없다.
    // 자격증명이 어쩌다 남아 있어도 정체를 모르면 사용자에게 보여 줄 것이 없다.
    const d = await dir({ '.claude.json': { machineID: 'x' }, '.credentials.json': '{}' });
    expect((await accountStatusFromDisk(d, HAS_KEYCHAIN)).loggedIn).toBe(false);
  });

  it('.claude.json 이 없으면 미로그인이다 — 던지지 않는다', async () => {
    const d = await dir();
    const s = await accountStatusFromDisk(d, HAS_KEYCHAIN);
    expect(s.loggedIn).toBe(false);
    expect(s.email).toBeUndefined();
  });

  it('.claude.json 이 깨져도 던지지 않는다', async () => {
    // 목록 하나가 못 읽혀서 화면 전체가 실패하면, 사용자는 자기 계정이 사라진 줄 안다.
    const d = await dir({ '.claude.json': '{ not json' });
    expect((await accountStatusFromDisk(d, HAS_KEYCHAIN)).loggedIn).toBe(false);
  });

  it('비밀값을 담지 않는다 — 토큰을 읽지 않는다', async () => {
    // 정체는 `.claude.json`(비밀 아님)에서 오고, 자격증명은 **존재만** 본다.
    const d = await dir({
      '.claude.json': { oauthAccount: { emailAddress: 'a@b.c', organizationName: 'Org' } },
      '.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET-TOKEN' } }),
    });
    const s = await accountStatusFromDisk(d, NO_KEYCHAIN);
    expect(JSON.stringify(s)).not.toContain('SECRET-TOKEN');
  });

  it('Keychain 조회가 던져도 파일 판정으로 떨어진다', async () => {
    // `security` 가 없는 환경·권한 거부에서 목록 전체가 죽지 않아야 한다.
    const d = await dir({
      '.claude.json': { oauthAccount: { emailAddress: 'a@b.c' } },
      '.credentials.json': '{}',
    });
    const boom = vi.fn(async () => { throw new Error('security 없음'); });
    expect((await accountStatusFromDisk(d, boom)).loggedIn).toBe(true);
  });
});

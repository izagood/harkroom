/**
 * Tauri shell 권한의 **범위** 회귀선(#250 — 보안).
 *
 * 왜 파일을 읽어 단언하는가: 이 결정은 코드가 아니라 `capabilities/default.json` 이 갖는다.
 * 앞선 판본은 스코프 없는 `"shell:allow-spawn"` 만 넣었는데, 그것은 두 가지로 틀렸다 —
 * (1) 스코프 항목이 없으면 플러그인이 프로그램 이름을 못 찾아 `ProgramNotAllowed` 로
 * 거절하므로 기능 자체가 앱에서 죽어 있었고(단위 테스트로는 보이지 않는다), (2) 나중에
 * 누가 "안 되네" 하며 `args: true` 나 셸(`sh -c`)을 허용하는 순간 **웹뷰가 임의 명령을
 * 실행할 수 있는 표면**이 열린다. 그것이 이 기능에서 가장 큰 위험이라, 여기서 못박는다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { RUNNER_ARGS, RUNNER_SCOPE_NAME } from '../src/lib/runnerLauncher';

interface ScopeEntry { name: string; cmd?: string; args?: unknown; sidecar?: boolean }
interface PermissionObject { identifier: string; allow?: ScopeEntry[] }
type Permission = string | PermissionObject;

const capabilities = JSON.parse(readFileSync(
  path.resolve(__dirname, '../src-tauri/capabilities/default.json'), 'utf8',
)) as { permissions: Permission[] };

const spawnPermissions = capabilities.permissions.filter(
  (p): p is PermissionObject => typeof p === 'object' && p.identifier === 'shell:allow-spawn',
);

describe('shell 스포운 권한은 그 한 명령만 허용한다', () => {
  it('스코프 없는 `shell:allow-spawn` 문자열이 없다', () => {
    expect(capabilities.permissions).not.toContain('shell:allow-spawn');
    expect(capabilities.permissions).not.toContain('shell:allow-execute');
    expect(spawnPermissions).toHaveLength(1);
  });

  it('허용 항목이 정확히 하나고, 실행기가 부르는 그 이름이다', () => {
    const allow = spawnPermissions[0]!.allow ?? [];
    expect(allow).toHaveLength(1);
    expect(allow[0]!.name).toBe(RUNNER_SCOPE_NAME);
  });

  it('인자가 고정 목록이다 — `true`(무엇이든)가 아니다', () => {
    const entry = spawnPermissions[0]!.allow![0]!;
    // `args: true` 는 그 프로그램에 **임의의 인자**를 넘길 수 있다는 뜻이다. `pnpm` 이면
    // `pnpm exec <아무 명령>` 이 되고, 그것으로 이 스코프는 사실상 와일드카드가 된다.
    expect(entry.args).not.toBe(true);
    expect(entry.args).toEqual(RUNNER_ARGS);
    expect(entry.cmd).toBe('pnpm');
    expect(entry.sidecar).toBeUndefined();
  });

  it('셸을 통해 도는 명령이 아니다 — `sh -c` 는 무엇이든 실행한다', () => {
    const entry = spawnPermissions[0]!.allow![0]!;
    expect(['sh', 'bash', 'zsh', 'cmd', 'powershell']).not.toContain(entry.cmd);
    expect(RUNNER_ARGS).not.toContain('-c');
  });
});

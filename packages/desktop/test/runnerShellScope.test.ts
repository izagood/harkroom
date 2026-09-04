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
import {
  LOGIN_PATH_ARGS, LOGIN_PATH_SCOPE_NAME, RUNNER_ARGS, RUNNER_SCOPE_NAME,
} from '../src/lib/runnerLauncher';

interface ScopeEntry { name: string; cmd?: string; args?: unknown; sidecar?: boolean }
interface PermissionObject { identifier: string; allow?: ScopeEntry[] }
type Permission = string | PermissionObject;

const capabilities = JSON.parse(readFileSync(
  path.resolve(__dirname, '../src-tauri/capabilities/default.json'), 'utf8',
)) as { permissions: Permission[] };

const spawnPermissions = capabilities.permissions.filter(
  (p): p is PermissionObject => typeof p === 'object' && p.identifier === 'shell:allow-spawn',
);

const executePermissions = capabilities.permissions.filter(
  (p): p is PermissionObject => typeof p === 'object' && p.identifier === 'shell:allow-execute',
);

/** 스코프 항목 전부. 새 권한이 붙어도 아래 훑기가 자동으로 그것까지 본다. */
const allScopeEntries = capabilities.permissions
  .filter((p): p is PermissionObject => typeof p === 'object')
  .flatMap((p) => p.allow ?? []);

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

/**
 * `PATH` 조회 스코프(#305). `sh` 를 허용하지만 **그 한 줄만** 허용한다 — 이것이 이슈가
 * "`sh -lc` 로 감싸는 길은 쓰지 않는다"고 적은 것과 어긋나지 않는 이유다: 감싸는 것은
 * 러너 명령이 아니고, 셸이 받는 인자는 배열 리터럴로 못박혀 있다.
 */
describe('로그인 PATH 조회 스코프는 그 한 줄만 허용한다', () => {
  it('스코프 없는 `shell:allow-execute` 문자열이 없고, 허용 항목이 정확히 하나다', () => {
    expect(capabilities.permissions).not.toContain('shell:allow-execute');
    expect(executePermissions).toHaveLength(1);
    expect(executePermissions[0]!.allow).toHaveLength(1);
    expect(executePermissions[0]!.allow![0]!.name).toBe(LOGIN_PATH_SCOPE_NAME);
  });

  it('인자가 `["-lc", "echo $PATH"]` 리터럴이다 — 변수도 `true` 도 아니다', () => {
    const entry = executePermissions[0]!.allow![0]!;
    expect(entry.cmd).toBe('sh');
    // 리터럴로 적는다. 여기서 `LOGIN_PATH_ARGS` 만 비교하면 구현이 인자를 무엇으로 바꾸든
    // 둘이 함께 움직여 초록이 된다 — 그러면 이 테스트가 지키는 것이 없다.
    expect(entry.args).toEqual(['-lc', 'echo $PATH']);
    expect(entry.args).not.toBe(true);
    expect(entry.sidecar).toBeUndefined();
    // 실행기가 부르는 값과 설정이 어긋나면 앱에서 `ProgramNotAllowed` 로 죽는다.
    expect(LOGIN_PATH_ARGS).toEqual(['-lc', 'echo $PATH']);
  });
});

describe('어떤 스코프 항목에도 와일드카드가 없다', () => {
  it('모든 항목의 인자가 고정 문자열 배열이다 — `true` 도, 정규식 인자도 없다', () => {
    expect(allScopeEntries.length).toBeGreaterThan(0);
    for (const entry of allScopeEntries) {
      // `args: true` 는 "무엇이든" 이다. `args: [{ validator: '...' }]` 는 정규식 인자로,
      // `.*` 하나면 그 프로그램에 임의 인자를 넘길 수 있다. 둘 다 여기서 막는다.
      expect(entry.args).not.toBe(true);
      expect(Array.isArray(entry.args)).toBe(true);
      for (const arg of entry.args as unknown[]) {
        expect(typeof arg).toBe('string');
      }
    }
  });
});

/**
 * 전역 저장소 provisioning(#425) 이 경계를 넓히지 않는지의 회귀선.
 *
 * **왜 shell 스코프에 `git` 항목을 넣지 않았는가**: clone 목적지는 사람마다 다른 홈
 * 디렉터리 아래(`~/.murmur/runner`)라 `ShellAllowedArg::Fixed`(리터럴 문자열)로 못박을 수
 * 없다. 남는 길은 `ShellAllowedArg::Var{validator}`(정규식)뿐인데, 그것은 위 스위트가 막는
 * "웹뷰가 인자를 고르는" 길과 같다. 그래서 git 실행 자체를 Rust 커맨드
 * (`src-tauri/src/main.rs::runner_provision_global_repo`) 뒤로 옮겨, 웹뷰 표면에서
 * `git`이라는 프로그램 이름조차 드러나지 않게 했다 — 이 스위트는 그 대체 표면이 여전히
 * "웹뷰가 인자를 넘길 수 없다"는 같은 성질을 지키는지 Rust 소스를 읽어 확인한다.
 */
describe('전역 저장소 provisioning 은 shell 스코프를 넓히지 않는다(#425)', () => {
  const mainRs = readFileSync(
    path.resolve(__dirname, '../src-tauri/src/main.rs'), 'utf8',
  );

  it('`runner_provision_global_repo` 커맨드가 웹뷰로부터 아무 인자도 받지 않는다', () => {
    // `AppHandle` 은 Tauri 가 채우는 프레임워크 값이지 웹뷰가 invoke 로 넘기는 인자가
    // 아니다. 이 서명에 `String`·`PathBuf` 등 웹뷰가 채울 수 있는 파라미터가 하나라도
    // 생기면, clone 목적지나 URL 을 웹뷰가 고를 수 있는 문이 열린다.
    const match = mainRs.match(/fn runner_provision_global_repo\(([^)]*)\)/);
    expect(match).not.toBeNull();
    expect(match![1]!.trim()).toBe('app: tauri::AppHandle');
  });

  it('clone 대상 URL 이 고정 리터럴이다 — izagood/murmur 그 저장소뿐이다', () => {
    expect(mainRs).toContain(
      'const RUNNER_REPO_URL: &str = "https://github.com/izagood/murmur.git";',
    );
    // 커맨드 함수가 그 상수를 실제로 쓴다 — 상수만 있고 안 쓰이면 이 단언은 아무것도 안 지킨다.
    const fnBody = mainRs.slice(mainRs.indexOf('fn runner_provision_global_repo'));
    expect(fnBody).toContain('RUNNER_REPO_URL');
  });

  it('clone 명령의 인자가 하드코딩된 배열이다 — 웹뷰가 준 문자열을 이어붙이지 않는다', () => {
    expect(mainRs).toContain('.args(["clone", RUNNER_REPO_URL, &dest_str])');
  });

  it('git·clone 이 shell:allow-spawn 스코프에는 없다 — 이 표면은 Tauri shell 플러그인을 거치지 않는다', () => {
    for (const entry of allScopeEntries) {
      expect(entry.cmd).not.toBe('git');
    }
  });
});

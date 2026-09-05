/**
 * Tauri shell 권한과 러너 spawn Rust 커맨드의 **범위** 회귀선(#250·#431 — 보안).
 *
 * ## `#431` 1단계가 이 경계를 어떻게 바꿨는가
 *
 * 러너는 더 이상 `tauri-plugin-shell` 의 `Command.create`(`shell:allow-spawn`)로 뜨지 않는다
 * — 그 API 는 프로세스 그룹 제어를 노출하지 않아서, spawn 자체를 Rust invoke 커맨드
 * (`runner_spawn`)로 옮겼다(`#425` 가 처음 만든 패턴 — 웹뷰는 파라미터를 넘기지 않고 실행
 * 대상·인자가 Rust 안에 고정되는 invoke 커맨드 — 를 재사용한다). 그래서 `capabilities/
 * default.json` 에는 이제 `shell:allow-spawn` 항목 자체가 없다 — **없는 것이 맞다.**
 *
 * 남은 것은 `login-path`(`shell:allow-execute`, #305) 하나뿐이다. 그 경계는 그대로다:
 * 인자가 리터럴 배열로 못박혀 있어야 하고, `args: true` 나 셸(`sh -c`)로 무엇이든 실행하는
 * 길이 열리면 안 된다.
 *
 * ## `#425` 회수에서 발견된 "옆문" 교훈을 새 spawn 커맨드에도 적용한다
 *
 * `#425` 의 최초 회귀선은 **이름을 아는 함수 하나**만 봤다 — `runner_provision_global_repo`
 * 를 그대로 둔 채 두 번째 커맨드로 `Command::new("git")` 을 웹뷰가 준 문자열로 부르면 전부
 * 초록으로 통과했다(실제로 그렇게 되는지 확인한 뒤 강화됐다). 이 파일은 그 강화를 그대로
 * 이어받아, "프로세스를 실제로 실행하는 자리가 정확히 하나이고 그것이 `runner_spawn` 이다"
 * 를 못박는다 — 새 커맨드(`runner_wait_exit`·`runner_kill`)가 생겨도 그 표를 거치지 않는
 * 자리에서 프로그램을 새로 실행하면 이 스위트가 빨개진다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { LOGIN_PATH_ARGS, LOGIN_PATH_SCOPE_NAME } from '../src/lib/runnerLauncher';

/**
 * Rust 함수 파라미터 목록을 쉼표로 쪼갠다 — 단, `<...>` 안의 쉼표(`tauri::State<'_, T>`
 * 같은 제네릭)는 무시한다. 순진하게 `.split(',')` 하면 그 제네릭 하나가 파라미터 둘로
 * 쪼개져 이 파일의 "웹뷰가 채우는 파라미터가 몇 개인가" 단언이 틀린 개수를 센다.
 */
function splitParams(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of raw) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

interface ScopeEntry { name: string; cmd?: string; args?: unknown; sidecar?: boolean }
interface PermissionObject { identifier: string; allow?: ScopeEntry[] }
type Permission = string | PermissionObject;

const capabilities = JSON.parse(readFileSync(
  path.resolve(__dirname, '../src-tauri/capabilities/default.json'), 'utf8',
)) as { permissions: Permission[] };

const executePermissions = capabilities.permissions.filter(
  (p): p is PermissionObject => typeof p === 'object' && p.identifier === 'shell:allow-execute',
);

/** 스코프 항목 전부. 새 권한이 붙어도 아래 훑기가 자동으로 그것까지 본다. */
const allScopeEntries = capabilities.permissions
  .filter((p): p is PermissionObject => typeof p === 'object')
  .flatMap((p) => p.allow ?? []);

describe('러너 spawn 은 이제 shell 플러그인을 거치지 않는다(#431)', () => {
  it('`shell:allow-spawn` 항목이 아예 없다 — spawn 이 Rust invoke 로 옮겨갔다', () => {
    const spawnPermissions = capabilities.permissions.filter(
      (p): p is PermissionObject => typeof p === 'object' && p.identifier === 'shell:allow-spawn',
    );
    expect(spawnPermissions).toHaveLength(0);
    expect(capabilities.permissions).not.toContain('shell:allow-spawn');
  });

  it('`shell:allow-kill` 도 없다 — 러너 종료는 `runner_kill` invoke 가 맡는다', () => {
    expect(capabilities.permissions).not.toContain('shell:allow-kill');
  });

  it('스코프 항목에 `murmur-runner`·`pnpm` 이름이 남아 있지 않다', () => {
    for (const entry of allScopeEntries) {
      expect(entry.name).not.toBe('murmur-runner');
      expect(entry.cmd).not.toBe('pnpm');
    }
  });
});

/**
 * `PATH` 조회 스코프(#305) — `#431` 이후에도 유일하게 남은 shell 플러그인 표면이다.
 * `sh` 를 허용하되 **그 한 줄만** 허용하므로 와일드카드가 아니다.
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
 * 러너 spawn Rust 커맨드(#431 1단계 A) 가 경계를 넓히지 않는지의 회귀선.
 *
 * **왜 shell 스코프에 사이드카 항목을 넣지 않았는가**: `tauri-plugin-shell` 의 `Command.
 * create` 는 자식의 프로세스 그룹을 제어할 수 없다(`setsid` 를 걸 자리가 없다) — 그래서
 * spawn 자체를 Rust 커맨드(`src-tauri/src/main.rs::runner_spawn`) 뒤로 옮겼다. 이 스위트는
 * 그 커맨드가 "웹뷰가 프로그램·인자를 고를 수 없다"는 `#425`·`#250` 과 같은 성질을 지키는지
 * Rust 소스를 읽어 확인한다.
 */
describe('러너 spawn Rust 커맨드는 웹뷰에 프로그램·인자 선택권을 주지 않는다(#431)', () => {
  const mainRs = readFileSync(
    path.resolve(__dirname, '../src-tauri/src/main.rs'), 'utf8',
  );

  it('`runner_spawn` 이 받는 파라미터가 env 값 세 개뿐이다 — 프로그램 경로·인자·cwd 가 아니다', () => {
    const match = mainRs.match(/fn runner_spawn\(([\s\S]*?)\)\s*->/);
    expect(match).not.toBeNull();
    const params = splitParams(match![1]!)
      // `registry`(Tauri State)·`app`(Tauri AppHandle) 은 프레임워크가 채우는 값이지
      // 웹뷰의 입력이 아니다(`#433` — `AppHandle` 은 `node-pty` 리소스 디렉터리를 찾는
      // `ensure_node_pty_alongside_sidecar` 에 쓰인다. 아래 "webviewParams" 스위트가 같은
      // 구분을 이미 쓰고 있다).
      .filter((p) => !p.startsWith('registry:') && !p.startsWith('app:'));
    expect(params.sort()).toEqual([
      'murmur_pat: String',
      'murmur_url: String',
      'path: String',
    ]);
  });

  it('실행할 프로그램은 `sidecar_path()`가 고정한다 — 웹뷰가 준 문자열이 아니다', () => {
    const fnBody = mainRs.slice(
      mainRs.indexOf('fn runner_spawn'),
      mainRs.indexOf('fn runner_wait_exit'),
    );
    // 실제 `Command::new(...)` 는 `detached_command()` 안에 있다(PGID 회귀 테스트가 그
    // 함수 하나를 `runner_spawn` 과 공유하기 위해서다 — 아래 "정확히 하나" 스위트 참고).
    // 여기서는 `runner_spawn` 이 그 함수를 `program`(= `sidecar_path()` 의 결과)으로만
    // 부르는지, 그리고 그 값이 웹뷰가 준 문자열이 아닌지를 확인한다.
    expect(fnBody).toContain('detached_command(&program)');
    expect(fnBody).toContain('sidecar_path()?');
    // 웹뷰가 넘긴 값(`murmur_pat`·`murmur_url`·`path`)은 전부 `.env(...)` 로만 들어간다 —
    // 프로그램 이름이나 인자 자리로는 쓰이지 않는다.
    expect(fnBody).not.toMatch(/detached_command\((murmur_pat|murmur_url|path)\)/);
  });

  it('사이드카 이름이 고정 리터럴이다', () => {
    expect(mainRs).toContain('const RUNNER_SIDECAR_NAME: &str = "murmur-runner"');
  });

  it('`setsid` 호출이 실제로 있다 — 이것이 빠지면 PGID 회귀선(러너 통합 테스트)이 빨개져야 한다', () => {
    expect(mainRs).toContain('libc::setsid()');
  });

  /**
   * `#425` 회수에서 "두 번째 커맨드로 옆문을 여는" 빈틈이 발견돼 강화된 이력이 있다 — 그
   * 강화를 새 spawn 커맨드에도 그대로 적용한다: 프로세스를 실제로 실행하는 자리가 정확히
   * 하나여야 한다.
   *
   * 그 자리는 `runner_spawn` 자신이 아니라 `detached_command()` 안이다 — PGID 회귀
   * 테스트(`tests::setsid_로_띄운_자식의_pgid_는_자기_자신이다`)가 `tauri::State` 없이도
   * 같은 분리 로직을 실제 프로세스로 재기 위해 그 함수를 공유한다(주석 참고). "정확히
   * 하나"라는 성질은 그대로다 — 새 자리가 생기면 이 스위트가 멈춘다.
   */
  describe('프로세스를 띄우는 자리가 정확히 하나다 — 옆문이 새로 나지 않는다', () => {
    // `mod tests` 블록(`#[cfg(all(test, unix))]`)은 회귀 테스트 코드다 — `#433` 회귀선이
    // 사이드카를 **실행 위치**에서 실제로 spawn 해 `node-pty` 로딩을 검증하려고 그 안에서
    // `Command::new(&program)` 을 부르는데, 그것은 프로덕션 spawn 자리가 아니라 이 스위트가
    // 지키려는 "옆문"과 무관하다. 그래서 프로덕션 소스만(그 블록 앞까지만) 훑는다.
    const productionRs = mainRs.slice(0, mainRs.indexOf('#[cfg(all(test, unix))]'));

    /** 프로덕션 소스에서 `Command::new(...)` 이 나오는 자리와, 그 앞의 함수 이름. */
    const processSpawns = [...productionRs.matchAll(/Command::new\((.*?)\)/g)].map((m) => {
      const before = productionRs.slice(0, m.index!);
      const fnName = [...before.matchAll(/fn\s+([A-Za-z0-9_]+)\s*\(/g)].pop()?.[1] ?? '<없음>';
      return { program: m[1]!.trim(), fn: fnName };
    });

    it('프로세스를 띄우는 자리가 정확히 하나고, 그것이 `detached_command` 다', () => {
      // 하나라도 늘면 여기서 멈춘다. 늘려야 할 이유가 진짜 있다면 이 단언을 고치면서
      // "그 새 자리도 웹뷰가 프로그램·인자를 못 고른다"를 같이 못박아야 한다.
      expect(processSpawns).toEqual([
        { program: 'program', fn: 'detached_command' },
      ]);
    });

    it('`#[tauri::command]` 중 웹뷰가 채울 수 있는 파라미터를 받는 것은 시크릿 3종·러너 3종뿐이다', () => {
      const commands = [...mainRs.matchAll(
        /#\[tauri::command\]\s*\n\s*(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g,
      )].map((m) => {
        const params = splitParams(m[2]!)
          // `AppHandle`·`State` 는 Tauri 가 채우는 프레임워크 값이지 웹뷰의 입력이 아니다.
          .filter((p) => !/^registry:\s*tauri::State/.test(p));
        return { fn: m[1]!, webviewParams: params };
      });

      expect(commands.filter((c) => c.webviewParams.length > 0).map((c) => c.fn).sort())
        .toEqual([
          'runner_kill', 'runner_spawn', 'runner_wait_exit',
          'secret_delete', 'secret_get', 'secret_set',
        ]);
      // `runner_kill`·`runner_wait_exit` 이 받는 것은 pid(핸들) 하나뿐이다 — 프로그램·인자를
      // 다시 고를 수 있는 자리가 아니다.
      const kill = commands.find((c) => c.fn === 'runner_kill')!;
      expect(kill.webviewParams).toEqual(['pid: u32']);
      const waitExit = commands.find((c) => c.fn === 'runner_wait_exit')!;
      expect(waitExit.webviewParams).toEqual(['pid: u32']);
    });
  });
});

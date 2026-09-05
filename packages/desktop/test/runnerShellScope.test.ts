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
  /**
   * `#431` 2단계-b 3/3 에서 daemon 클라이언트가 이 파일로 들어왔다. **소켓·토큰·pid·로그
   * 경로를 계산하고 daemon 을 띄우는 자리가 전부 여기다** — 그래서 "웹뷰가 프로그램·경로를
   * 못 고른다"의 회귀선도 이 파일까지 봐야 한다.
   */
  const daemonRs = readFileSync(
    path.resolve(__dirname, '../src-tauri/src/daemon_client.rs'), 'utf8',
  );

  it('`daemon_spawn_runner` 가 받는 파라미터가 agentId + env 값 세 개뿐이다 — 프로그램 경로·인자·cwd 가 아니다', () => {
    const match = mainRs.match(/fn daemon_spawn_runner\(([\s\S]*?)\)\s*->/);
    expect(match).not.toBeNull();
    const params = splitParams(match![1]!)
      // `state`(Tauri State)·`app`(Tauri AppHandle) 은 프레임워크가 채우는 값이지
      // 웹뷰의 입력이 아니다(아래 "webviewParams" 스위트가 같은 구분을 이미 쓰고 있다).
      .filter((p) => !p.startsWith('state:') && !p.startsWith('app:'));
    expect(params.sort()).toEqual([
      'agent_id: String',
      'murmur_pat: String',
      'murmur_url: String',
      'path: String',
    ]);
  });

  /**
   * **이 단계의 핵심 성질이다** — `main.rs` 의 `runner_spawn` 이 지키던 것
   * (*"실행할 프로그램 경로·인자는 `sidecar_path()`가 고정하고, 웹뷰는 그 프로그램의
   * 이름도 인자도 고르지 못한다"*)을 daemon spawn 에도 그대로 잇는다.
   *
   * daemon 쪽에는 한 겹이 더 있다: **소켓·토큰·pid 경로도 웹뷰가 고르면 안 된다.**
   * 고를 수 있으면 웹뷰가 자기가 준비한 소켓을 가리켜 daemon 행세를 하는 프로세스에
   * 앱을 붙일 수 있고, PAT 가 실린 `spawnRunner` 가 그쪽으로 간다.
   */
  it('daemon spawn 이 경로를 파라미터로 받지 않는다 — 프로그램도 소켓·토큰도 Rust 가 고정한다', () => {
    const spawnDaemon = daemonRs.slice(
      daemonRs.indexOf('fn spawn_daemon('),
      daemonRs.indexOf('fn daemon_command('),
    );
    expect(spawnDaemon.length).toBeGreaterThan(0);

    // 1. 프로그램은 `sidecar_path(DAEMON_SIDECAR_NAME)` 이 고정한다 — 상수다.
    expect(spawnDaemon).toContain('crate::sidecar_path(DAEMON_SIDECAR_NAME)?');
    // 2. 그 이름은 리터럴이다.
    expect(daemonRs).toContain('pub const DAEMON_SIDECAR_NAME: &str = "murmur-daemon"');
    // 3. **`spawn_daemon` 의 파라미터에 웹뷰가 닿는 값이 없다** — `AppHandle` 과
    //    Rust 가 만든 `EndpointPaths` 뿐이다. 문자열 경로를 받는 자리가 생기면 여기서 멈춘다.
    const sig = daemonRs.match(/fn spawn_daemon\(([\s\S]*?)\)\s*->/);
    expect(splitParams(sig![1]!).sort()).toEqual([
      'app: &tauri::AppHandle',
      'paths: &EndpointPaths',
    ]);
    // 4. 커맨드를 조립하는 자리(`daemon_command`)도 마찬가지다 — 웹뷰가 닿는 값이 없다.
    //    `nonce`·`app_version` 은 Rust 가 만든 값이고 프로그램·경로는 위 둘이 정한다.
    const cmdSig = daemonRs.match(/fn daemon_command\(([\s\S]*?)\)\s*->/);
    expect(splitParams(cmdSig![1]!).sort()).toEqual([
      'app_version: &str',
      'nonce: &str',
      'paths: &EndpointPaths',
      'program: &Path',
    ]);
    // 5. **경로를 만드는 자리도 하나다** — `app_data_dir()` 에서 Rust 가 계산한다.
    expect(daemonRs).toContain('.app_data_dir()');
    const resolve = daemonRs.match(/pub fn resolve_endpoint_paths\(([\s\S]*?)\)\s*->/);
    expect(splitParams(resolve![1]!)).toEqual(['app: &tauri::AppHandle']);
  });

  it('토큰은 파일에서 읽는다 — 웹뷰가 값을 넘기지 않는다', () => {
    // 토큰이 파라미터로 들어오는 순간 인증이 무의미해진다(자기가 아는 값을 넘기면 된다).
    expect(daemonRs).toContain('std::fs::read_to_string(&paths.token)');
    const connect = daemonRs.match(/fn connect\(([\s\S]*?)\)\s*->/);
    expect(splitParams(connect![1]!)).toEqual(['paths: &EndpointPaths']);
  });

  /**
   * **daemon 도 `detached_command()` 로 띄운다**(`#431` D2). 앱이 죽어도 daemon 이 살아야
   * 하고, 그것은 `setsid` 한 단계로만 성립한다 — 실측(2026-09-05): 앱 프로세스 그룹에
   * `kill -TERM -<PGID>` 한 번이면 그 그룹의 자식이 전부 죽는다.
   *
   * 되돌려 RED: `daemon_command` 의 `crate::detached_command(program)` 를
   * `std::process::Command::new(program)` 로 바꾸면 이 단언과 아래 "정확히 하나" 스위트가
   * **둘 다** 빨개진다(후자는 spawn 자리가 둘이 되므로). 실제로 되돌려 실행해 확인했다.
   */
  it('daemon 이 `detached_command` 로 뜬다 — 앱이 죽어도 살아야 한다', () => {
    const daemonCommand = daemonRs.slice(
      daemonRs.indexOf('fn daemon_command('),
      daemonRs.indexOf('fn new_nonce('),
    );
    expect(daemonCommand.length).toBeGreaterThan(0);
    expect(daemonCommand).toContain('crate::detached_command(program)');
    // 이 함수 안에서 `Command` 를 직접 만들면 `setsid` 가 빠진다. **주석은 세지 않는다** —
    // 이 이름은 되돌려 RED 절차를 적은 주석에도 나온다(위 doc comment).
    expect(
      daemonCommand.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'),
    ).not.toMatch(/std::process::Command::new/);
  });

  it('사이드카 이름이 고정 리터럴이다', () => {
    expect(mainRs).toContain('const RUNNER_SIDECAR_NAME: &str = "murmur-runner"');
    expect(daemonRs).toContain('pub const DAEMON_SIDECAR_NAME: &str = "murmur-daemon"');
  });

  /**
   * **`#450` — 키체인 커맨드는 메인 스레드를 잡으면 안 된다.**
   *
   * 실측(2026-09-06): 동기 `secret_get` 이 `SecKeychainFindGenericPassword` 에서 멎어
   * **5초 샘플 3875/3875 가 메인 스레드 한 지점**에 있었고, 그때 `SecurityAgent`(승인
   * 대화상자)가 떠 있었다. 앱은 죽지도 에러를 내지도 않아 — 러너가 안 뜨는 것 말고는
   * 아무 증상이 없어 — 진단이 오래 걸렸다.
   *
   * **이것은 성질 검사이지 증상 재현이 아니다.** 대화상자를 테스트에서 만들 수 없어
   * "메인 스레드가 안 막힌다"는 못 잰다(`main.rs` 의 그 자리 주석에 그 한계를 적어 뒀다).
   * 여기서 잴 수 있는 것은 **동기로 되돌리는 변경이 눈에 띄는가**뿐이고, 그것을 잰다.
   */
  it('키체인 커맨드 셋이 `async` 이고 `spawn_blocking` 위에서 돈다 (#450)', () => {
    for (const name of ['secret_get', 'secret_set', 'secret_delete']) {
      // `#[tauri::command]` 바로 다음이 `async fn` 이어야 한다 — 동기면 Tauri 가
      // **메인 스레드에서** 돌린다.
      expect(mainRs).toMatch(
        new RegExp(`#\\[tauri::command\\]\\s*\\n\\s*async fn ${name}\\(`),
        );
    }
    // `async fn` 만으로는 부족하다 — `keyring` 이 동기라 async 워커가 대신 막힌다.
    // 셋 다 블로킹 전용 풀로 넘어가는지 본다.
    const secretBlock = mainRs.slice(
      mainRs.indexOf('async fn secret_get'),
      mainRs.indexOf('// ---', mainRs.indexOf('async fn secret_delete')),
    );
    expect(
      [...secretBlock.matchAll(/tauri::async_runtime::spawn_blocking/g)],
    ).toHaveLength(3);
  });

  /**
   * **폴백이 없다** — 앱이 러너를 직접 띄우는 옛 경로(`runner_spawn`)가 사라졌는지 잰다.
   *
   * 남아 있으면 daemon 기동 실패가 조용히 그쪽으로 흘러 "daemon 이 도는 줄 알았는데
   * 아니었다"가 된다. 이름만 지운 것으로는 부족하므로, pid 를 받아 죽이는 커맨드
   * (`runner_kill`·`runner_wait_exit`)까지 함께 사라졌는지 본다 — 그 표가 남아 있다는 것은
   * 앱이 여전히 러너 프로세스를 직접 들고 있다는 뜻이다.
   */
  it('앱이 러너를 직접 띄우는 옛 경로가 없다 — 폴백이 아니라 제거다', () => {
    expect(mainRs).not.toMatch(/fn runner_spawn\(/);
    expect(mainRs).not.toMatch(/fn runner_wait_exit\(/);
    expect(mainRs).not.toMatch(/fn runner_kill\(/);
    expect(mainRs).not.toContain('struct RunnerRegistry');
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
  describe('프로세스를 실제로 실행하는 자리가 딱 정해진 만큼이다 — 옆문이 새로 나지 않는다', () => {
    /**
     * `#[cfg(test)]` 로 시작하는 테스트 모듈 **딱 그 블록만** 도려내고 나머지를 전부 돌려준다.
     *
     * **왜 "블록 앞까지만" 이 아닌가**(`#433` 회수에서 실측으로 발견): 스캔을 `mod tests`
     * 앞까지로 자르면 **그 뒤에 프로덕션 코드를 붙이는 것만으로 이 스위트를 통과할 수 있다** —
     * `#[tauri::command] fn back_door(p: String) { Command::new(p); }` 를 파일 맨 끝에 두고
     * 돌려본 결과 스캔 결과가 `detached_command` 하나 그대로였다(초록). Rust 는 항목 순서를
     * 가리지 않으므로 그것은 완전히 정상 동작하는 옆문이다. 그래서 도려내는 것은 테스트 모듈
     * **하나의 범위**뿐이고, 그 뒤에 오는 것은 다시 스캔 대상이다.
     *
     * 중괄호를 세어 블록 끝을 찾는다(문자열 리터럴 안의 중괄호는 이 파일에 없다 — 있으면
     * 아래 `모듈이 정확히 하나 도려내졌다` 단언이 개수로 걸린다).
     */
    function stripTestModule(src: string): { rest: string; found: boolean } {
      const marker = src.match(/#\[cfg\((?:all\()?test\b[^\]]*\]\s*\nmod tests\s*\{/);
      if (!marker) return { rest: src, found: false };
      const bodyStart = marker.index! + marker[0].length;
      let depth = 1;
      let i = bodyStart;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
      }
      return { rest: src.slice(0, marker.index!) + src.slice(i), found: depth === 0 };
    }

    const stripped = stripTestModule(mainRs);

    /**
     * **스캔 대상이 두 파일이다** — `#431` 2단계-b 3/3 에서 daemon 을 띄우는 코드가
     * `daemon_client.rs` 로 들어왔다. `main.rs` 만 보면 그 파일 안에
     * `std::process::Command::new(웹뷰가_준_문자열)` 을 놓는 것으로 이 스위트를 통과할 수
     * 있고, 그것이 `#425` 회수에서 발견된 "두 번째 커맨드로 옆문을 여는" 빈틈과 정확히
     * 같은 모양이다. 크레이트 안의 **모든** 프로덕션 소스를 봐야 한다.
     */
    const daemonStripped = stripTestModule(daemonRs);

    /** 프로덕션 소스에서 `Command::new(...)` 이 나오는 자리와, 그 앞의 함수 이름. */
    function scanSpawns(src: string, file: string): { program: string; fn: string; file: string }[] {
      return [...src.matchAll(/Command::new\((.*?)\)/g)].map((m) => {
        const before = src.slice(0, m.index!);
        const fnName = [...before.matchAll(/fn\s+([A-Za-z0-9_]+)\s*\(/g)].pop()?.[1] ?? '<없음>';
        return { program: m[1]!.trim(), fn: fnName, file };
      });
    }

    const processSpawns = [
      ...scanSpawns(stripped.rest, 'main.rs'),
      ...scanSpawns(daemonStripped.rest, 'daemon_client.rs'),
    ];

    /**
     * `detached_command(...)` 를 **부르는** 자리. 프로세스를 만드는 자리(`Command::new`)와
     * 따로 세는 이유: 그 함수가 하나로 남아 있어도 그것을 부르는 자리가 늘면 실행 대상이
     * 는 것과 같다. `runner_spawn` 이 사라졌으므로 지금 부르는 곳은 `spawn_daemon` 하나여야
     * 한다 — 러너를 앱이 다시 띄우기 시작하면 여기서 멈춘다.
     */
    function scanCallers(src: string, file: string): { fn: string; file: string }[] {
      // 주석 줄(`///`·`//`)은 제외한다 — 이 함수 이름은 주석에도 여러 번 나오고, 그것을
      // 호출로 세면 근거를 적을수록 회귀선이 빨개진다.
      const code = src
        .split('\n')
        .map((line) => (/^\s*\/\//.test(line) ? '' : line))
        .join('\n');
      // `fn detached_command(` 는 **정의**이지 호출이 아니다 — 앞에 `fn ` 이 없는 것만 센다.
      return [...code.matchAll(/(?<!fn\s)(?:crate::)?detached_command\(&?[A-Za-z_]/g)]
        .map((m) => {
          // 주석 줄은 빈 줄로 **바뀐 것이지 지워진 것이 아니라** 오프셋이 그대로다 —
          // 그래서 `code` 위에서 그대로 되짚어도 같은 자리를 가리킨다.
          const before = code.slice(0, m.index!);
          const fnName = [...before.matchAll(/fn\s+([A-Za-z0-9_]+)\s*\(/g)].pop()?.[1] ?? '<없음>';
          return { fn: fnName, file };
        })
        // 정의 자신(`fn detached_command(`)은 호출이 아니다.
        .filter((c) => c.fn !== 'detached_command');
    }

    it('테스트 모듈을 실제로 찾아 도려냈다 — 못 찾으면 스캔 범위 판단 자체가 틀린 것이다', () => {
      // 마커 문자열이 바뀌면(예: `unix` 조건이 빠지면) 조용히 "아무것도 못 도려냄"이 되거나,
      // `indexOf(...) === -1` 을 `slice` 에 넘겨 엉뚱한 범위를 스캔하게 된다 — 둘 다 이
      // 스위트가 지키는 것을 없앤다. 그래서 "찾았다"를 명시적으로 못박는다.
      expect(stripped.found).toBe(true);
      // 도려낸 뒤에도 `mod tests` 가 남아 있으면 테스트 모듈이 둘 이상이라는 뜻이다 —
      // 그 경우 위 함수가 첫 번째만 도려내므로 이 스위트의 전제가 깨진다.
      expect(stripped.rest).not.toContain('mod tests');
    });

    it('테스트 모듈 뒤에 붙인 프로덕션 spawn 도 잡힌다 — 스캔이 파일 끝까지 간다', () => {
      // **되돌려 RED 절차의 고정**: `mod tests` 뒤는 안전지대가 아니다. 실제 소스를 건드리지
      // 않고, 같은 스캔 로직을 "뒤에 옆문이 붙은 소스"에 돌려 그것이 잡히는지 확인한다.
      const withBackDoor = `${mainRs}\n#[tauri::command]\nfn back_door(p: String) { std::process::Command::new(p); }\n`;
      const rescanned = scanSpawns(stripTestModule(withBackDoor).rest, 'main.rs');
      expect(rescanned.length).toBe(scanSpawns(stripped.rest, 'main.rs').length + 1);
    });

    it('`daemon_client.rs` 에 붙인 옆문도 잡힌다 — 스캔이 두 파일을 다 본다', () => {
      // **이 단언이 "스캔 대상이 늘었다"의 증거다.** 3/3 에서 daemon 을 띄우는 코드가
      // 새 파일로 들어왔고, 그 파일이 스캔 밖이면 옆문을 그쪽에 놓으면 그만이다.
      const withBackDoor = `${daemonRs}\nfn back_door(p: String) { std::process::Command::new(p); }\n`;
      const rescanned = scanSpawns(stripTestModule(withBackDoor).rest, 'daemon_client.rs');
      expect(rescanned.length).toBe(scanSpawns(daemonStripped.rest, 'daemon_client.rs').length + 1);
    });

    /**
     * ## 왜 여전히 **하나**인가 — 3/3 에서 무엇이 늘고 무엇이 줄었나 (근거)
     *
     * 이 단계는 프로세스를 띄우는 대상을 바꿨지 **자리를 늘리지 않았다.**
     *
     * | | 2/3 까지 | 3/3 |
     * |---|---|---|
     * | 앱이 러너를 띄운다 | `runner_spawn` → `detached_command` | **없어졌다** |
     * | 앱이 daemon 을 띄운다 | 없음 | `daemon_command` → `detached_command` |
     * | `Command::new` 가 있는 자리 | `detached_command` 하나 | **그대로 하나** |
     *
     * 즉 spawn 하는 **호출자**는 `runner_spawn` 에서 `daemon_command` 로 바뀌었지만,
     * 프로세스를 실제로 만드는 자리는 여전히 `detached_command` 하나다. 두 호출자 모두
     * 프로그램을 `sidecar_path(<상수>)` 로 고정한다.
     *
     * **늘려야 할 이유가 진짜 생기면** 이 단언을 고치면서 그 새 자리도 웹뷰가 프로그램·인자를
     * 못 고른다는 것을 같이 못박아야 한다 — 위 표처럼 무엇이 늘었는지 근거를 남기고서.
     */
    it('프로세스를 띄우는 자리가 정확히 하나고, 그것이 `detached_command` 다', () => {
      expect(processSpawns).toEqual([
        { program: 'program', fn: 'detached_command', file: 'main.rs' },
      ]);
    });

    it('`detached_command` 를 부르는 자리는 daemon 커맨드 조립 하나뿐이다 — 러너는 daemon 이 띄운다', () => {
      const callers = [
        ...scanCallers(stripped.rest, 'main.rs'),
        ...scanCallers(daemonStripped.rest, 'daemon_client.rs'),
      ];
      expect(callers).toEqual([{ fn: 'daemon_command', file: 'daemon_client.rs' }]);
    });

    it('`#[tauri::command]` 중 웹뷰가 채울 수 있는 파라미터를 받는 것은 시크릿 3종·daemon 2종뿐이다', () => {
      const commands = [...mainRs.matchAll(
        /#\[tauri::command\]\s*\n\s*(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g,
      )].map((m) => {
        const params = splitParams(m[2]!)
          // `AppHandle`·`State` 는 Tauri 가 채우는 프레임워크 값이지 웹뷰의 입력이 아니다.
          .filter((p) => !/^(registry|state):\s*tauri::State/.test(p))
          .filter((p) => !/^app:\s*tauri::AppHandle/.test(p));
        return { fn: m[1]!, webviewParams: params };
      });

      // `daemon_list_runners` 는 웹뷰에서 아무것도 안 받는다 — 목록을 묻는 것뿐이다.
      expect(commands.filter((c) => c.webviewParams.length > 0).map((c) => c.fn).sort())
        .toEqual([
          'daemon_kill_runner', 'daemon_spawn_runner',
          'secret_delete', 'secret_get', 'secret_set',
        ]);
      // `daemon_kill_runner` 가 받는 것은 **누구를·어느 세대를** 뿐이다 — 프로그램·인자·경로를
      // 다시 고를 수 있는 자리가 아니다.
      const kill = commands.find((c) => c.fn === 'daemon_kill_runner')!;
      expect(kill.webviewParams.sort()).toEqual([
        'agent_id: String',
        'incarnation_id: Option<String>',
      ]);
    });
  });
});

/**
 * 러너 실행기(#250). **앱이 러너를 띄운다** — 서버가 아니다(docs/design.md §1: 에이전트는
 * 외부 접속형이고, 그 '외부'가 이 데스크탑 앱이다).
 *
 * ## 운영자 결정 (다시 정하지 마라)
 *
 * 1. PAT 는 앱이 서버에서 발급받아 **OS 키체인**에 보관하고, 러너에 `MURMUR_PAT` 로 넘긴다.
 *    러너는 PAT 를 저장하지 않는다.
 * 2. **기동마다 재발급하지 않는다.** 앱 재시작·업데이트 뒤에는 키체인의 PAT 를 그대로 다시
 *    쓴다 — 재발급하면 그 PAT 로 돌던 러너가 401 을 받고 물러나며 진행 중인 작업이 날아간다.
 *    앱 업데이트 한 번에 돌던 러너가 전부 죽는 것이 이 결정이 막는 것이다.
 * 3. **회전은 사람이 누를 때만** 한다: 새 PAT 발급 → 옛 PAT 서버에서 폐기 → 자식 종료 →
 *    새 PAT 로 재실행. 옛 PAT 로 돌던 러너(앱이 띄우지 않은 것 포함)는 다음 호출에서 401 을
 *    받고 스스로 **종료 코드 78**(EX_CONFIG)로 물러난다 — 러너↔앱 통신 채널은 만들지 않고,
 *    서버가 진실의 원천이다.
 *
 * ## Tauri 표면을 왜 주입하는가
 *
 * 키체인(`secret_*` invoke)과 러너 소유(`daemon_spawn_runner`/`daemon_kill_runner` invoke)를
 * 이 클래스가 직접 부르면 회귀선을 걸 자리가 없다 — 테스트가 확인할 수 있는 것이
 * "목을 손으로 넘긴 값"뿐이 되고, 앱에서 죽은 배선이 초록으로 통과한다. 두 표면을
 * 인터페이스로 뽑고 기본 구현을 이 파일 아래쪽에 둔다.
 *
 * ## `#431` 1단계 — 프로세스 그룹 분리·사이드카 배포로 바뀐 것
 *
 * 러너는 더 이상 `@tauri-apps/plugin-shell` 의 `Command.create` 로 뜨지 않는다. 그 API 는
 * 프로세스 그룹 제어를 노출하지 않아서 러너가 앱의 프로세스 그룹에 묶인 채로 떴고, 실측
 * (2026-09-05) 결과 `kill -TERM -<앱 PGID>` 한 번에 러너 전부가 죽었다 — 앱이 죽어도 러너가
 * 살아남는 것은 아무도 그 그룹에 시그널을 안 보내서일 뿐이었다. 그래서 spawn 자체를
 * Rust invoke 커맨드(`runner_spawn`)로 옮겼다 — `#425` 가 만든 패턴(웹뷰는 파라미터를 넘기지
 * 않고 실행 대상·인자가 Rust 안에 고정되는 invoke)을 그대로 재사용한다. Rust 쪽이 자식을
 * `setsid`(Unix)로 자기 세션/프로세스 그룹으로 분리한다.
 *
 * 또한 러너는 더 이상 `pnpm --filter @murmur/agent start` 로 소스를 실행하지 않는다 —
 * 단일 번들로 만들어 Tauri sidecar(`externalBin`)로 앱과 함께 배포한다. 그래서
 * `runnerRepoPath`(murmur 소스가 어디 있나) 자체가 사라졌다 — 그 역할은 이미 에이전트별
 * `workingDir`(DB)이 한다. `cwd` 도 이 실행기 표면에서 사라졌다: sidecar 는 자기 위치를
 * 스스로 알고, 러너가 일할 저장소는 `mentionTurn.ts` 가 `workingDir` 로 따로 정한다
 * (`process.cwd()`는 애초에 그 판단에 쓰인 적이 없다).
 *
 * ## `#431` 2단계-b 3/3 — **앱이 러너의 부모가 아니다**
 *
 * 러너는 이제 daemon 이 띄운다. 앱은 daemon 에 소켓으로 붙어 "이 에이전트의 러너를
 * 띄워라"라고 말할 뿐이다(`daemonSpawner`). 그래서 이 파일의 첫 줄 — *"앱이 러너를
 * 띄운다"* — 은 **한 겹 간접이 된다**: 러너를 띄우게 하는 것은 여전히 이 앱이지만,
 * 그 프로세스의 부모는 daemon 이다.
 *
 * 바뀐 것과 바뀌지 않은 것:
 *
 * | | 그대로인가 |
 * |---|---|
 * | `RunnerSpawner` 인터페이스(`spawn → { kill }`) | **그대로** — 호출부가 안 바뀐다 |
 * | `#419` 세대 토큰(`runTokens`) | **그대로** — 재는 것이 앱 안의 세대다 |
 * | PAT 운영자 결정 1·2·3 (위) | **그대로** |
 * | 러너 프로세스의 부모 | 앱 → **daemon** |
 * | 종료 통지 경로 | `runner_wait_exit` → **소켓의 `runnerExit` 이벤트** |
 * | 세대 구분자 | Symbol 하나 → **Symbol + `incarnationId`**(`daemonSpawner` 주석) |
 *
 * **`sessions.json`·`SessionStore` 는 여기서도 안 건드린다**(`#431` D5) — 이 파일이 아는
 * 것은 프로세스와 PAT 뿐이고, 세션 상태의 writer 는 러너 하나여야 한다.
 */
// **`@tauri-apps/plugin-shell` 을 더 이상 안 부른다**(`#513`). 마지막 남은 사용처가
// 로그인 `PATH` 조회(`#305`)였고, 그것이 Rust 로 옮겨가며(`login_path.rs`) 이 파일에서
// 웹뷰가 프로그램을 실행하는 자리가 하나도 안 남았다.
import { DAEMON_RETIRING_TOKEN, EX_CONFIG, harnessBinaryName, installHint, runnerExitReason } from '@murmur/shared';
// 문구는 사전이 진다(`#619`). **이 파일은 타입만 가져온다** — `translator` 를 여기서
// 부르면 판정이 언어를 스스로 고르게 되고, 그것이 `(c) 전역 번역기`(그 인터페이스 주석이
// 버린 후보)의 모양이다.
import type { Translate } from '../i18n';

/**
 * 러너의 지금 상태.
 *
 * **`needs_harness` 가 `#473` 이 더한 것이다.** 그 전에는 78 로 죽은 러너가 전부
 * `needs_reissue` 였고, 화면은 "PAT 를 재발급하라"고만 말했다 — 하네스가 없어서 죽은
 * 러너에게도. 사람이 할 일이 정반대인 두 상태를 하나로 뭉치면 화면이 사람을 틀린
 * 방향으로 보낸다(`docs/design.md` §4 의 거짓 신호).
 *
 * `failed`(기동 자체가 안 됐다)와도 따로 둔다: `needs_harness` 는 러너가 **떴고**
 * 하네스를 찾다 물러난 상태다. 사람이 할 일이 다르다 — 앞은 앱·daemon 을 봐야 하고
 * 뒤는 하네스를 설치하면 된다.
 *
 * ## `external` 이 사라지고 `adopted` 가 들어왔다 (`#431` 2단계 A, `#430`)
 *
 * `external` 은 **presence 로 지은 이름**이었다: "서버가 이 계정이 붙어 있다고 한다 →
 * 누군가 띄웠나 보다". 그 판정이 무엇을 못 봤는지는 `doStartOne` 주석에 실측과 함께
 * 적어 뒀다 — 요지는 **서버는 "누가 붙어 있나"만 알고 "그게 내 것인가"를 모른다**는
 * 것이다. 그래서 `#430` 의 두 실측이 정반대 방향으로 어긋났다(러너 0개인데 `external`,
 * 러너 2개인데 우연히 맞음).
 *
 * `adopted` 는 **daemon 이 아는 사실**이다: 이 daemon 의 장부에 있고
 * `kill(pid, 0)` 으로 살아 있음을 방금 확인했지만 이번 앱 세션이 띄운 것은 아니다
 * (`RunnerInfo.adopted`). 즉 생사를 **단언한다** — `external` 이 못 하던 것이다.
 *
 * **문구는 여기서 정하지 않는다**(`#443` 범위). 이 타입이 정하는 것은 상태값과 그
 * 의미뿐이고, `RunnerStatus.tsx` 는 최소한으로만 따라온다.
 */
/**
 * 앞 세대 러너가 물러나기를 기다리는 간격(`waitForRetirement`).
 *
 * 15초인 이유: 사람이 화면을 보고 있을 수 있는 시간 안에 다시 시도하되(멈춘 것으로
 * 읽히지 않게), 30분짜리 턴을 기다리는 동안 daemon 에 백 번씩 묻지도 않는 값이다.
 */
const RETIRE_WAIT_MS = 15_000;

export type RunnerStatus =
  | 'stopped'
  | 'running'
  | 'adopted'
  /**
   * 재기동을 **예약했다** — 죽이라고 말했고, 실제 종료를 기다리는 중이다.
   *
   * 이 상태가 따로 있어야 하는 이유: SIGTERM 은 graceful 이고 SIGKILL 승격이 없으므로
   * (`packages/daemon/src/runners.ts`) 러너는 진행 중인 턴을 마친 뒤에야 죽는다 —
   * 실측 5분이 넘은 턴도 있다. 그동안 'running' 으로 두면 사람에게는 "눌렀는데 아무 일이
   * 없다"이고, 'stopped' 로 두면 없는 종료를 단정한다. 둘 다 거짓 신호다(design.md §4).
   */
  | 'restarting'
  | 'needs_reissue'
  | 'needs_harness'
  /**
   * 하네스 **로그인**이 풀렸다(2026-09-07). `needs_reissue` 와 갈라야 하는 이유: 그 상태는
   * 화면에 PAT 재발급 버튼을 세우는데, 여기서 사람이 할 일은 터미널에서 `claude` 를 한 번
   * 실행하는 것이다. 버튼을 눌러도 낫지 않는 일을 시키지 않는다(`#473` 과 같은 결).
   */
  | 'needs_login'
  | 'failed';

export interface RunnerState {
  agentId: string;
  status: RunnerStatus;
  /** 자식의 종료 코드. `null` 은 '아직 종료하지 않았다' 또는 '시그널로 죽어 코드가 없다'다. */
  exitCode: number | null;
  /**
   * 사람에게 보일 사유. **`failed` 는 반드시 이유를 갖는다** — 이유 없는 '실패'는 사람이
   * 할 수 있는 일이 없는 신호이고, 그것이 docs/design.md §4 가 금지하는 거짓 신호다.
   */
  message: string | null;
}

/** 키체인에 넣는 것. **라벨을 함께 보관한다** — 회전 때 폐기할 대상이 이 라벨이다. */
export interface StoredRunnerPat {
  label: string;
  token: string;
}

/**
 * 키체인 읽기 결과. **'없다'와 '못 읽었다'를 구분한다.** 못 읽은 것을 '없다'로 삼키면
 * 앱은 새 PAT 를 발급하고 옛 것을 폐기하는데, 그 옛 PAT 로 **지금 일하고 있는 러너**가
 * 다음 호출에서 401 을 받고 죽는다 — 결정 2 가 막으려는 사고를 키체인 한 번의 실패로
 * 재현하는 것이다. 그래서 실패는 실패로 올라간다.
 */
export type SecretRead =
  | { ok: true; value: StoredRunnerPat | null }
  | { ok: false; error: string };

export interface RunnerSecretStore {
  read(agentId: string): Promise<SecretRead>;
  write(agentId: string, value: StoredRunnerPat): Promise<void>;
  clear(agentId: string): Promise<void>;
  /** 이 설치를 가리키는 안정된 id. PAT 라벨에 들어간다(`deviceId()` 주석 참고). */
  deviceId(): Promise<string>;
}

/** 띄운 자식. 종료 통지는 `spawn` 에 넘긴 `onExit` 으로 온다. */
export interface RunnerProcess {
  kill(): Promise<void>;
}

export interface SpawnRequest {
  /**
   * 어느 에이전트의 러너인가(`#431` 2단계-b 3/3에서 추가됐다).
   *
   * **daemon 은 러너를 `agentId` 로 센다** — pid 가 아니다(`daemonProtocol.ts` 의
   * `SpawnRunnerParams`·`KillRunnerParams` 가 전부 `agentId` 를 축으로 한다). 앱이 pid 를
   * 들고 있던 시절에는 이 값이 필요 없었지만, 소유권이 daemon 으로 넘어가면서 "누구의
   * 러너인가"를 소켓 너머로 말해야 한다.
   */
  agentId: string;
  env: Record<string, string>;
  /**
   * 자식이 끝나면 정확히 한 번 불린다. `code` 가 `null` 이면 시그널로 죽은 것이다.
   *
   * `tailLines` 는 러너 로그의 마지막 몇 줄이다(`#473`). **선택적인 것이 의도다** —
   * 옛 daemon 은 안 보내고, 로그를 못 열었거나 못 읽었으면 daemon 이 빈 배열을 보낸다.
   * 그 셋 전부에서 "구분자를 못 봤다"가 답이고, 그때 앱은 사유를 지어내지 않는다.
   */
  onExit(code: number | null, tailLines?: string[]): void;
}

export interface RunnerSpawner {
  spawn(req: SpawnRequest): Promise<RunnerProcess>;
}

/**
 * daemon 이 **지금 무엇을 들고 있는지** 묻는 표면 — `#431` 2단계 A 가 만든 것.
 *
 * ## 이 표면이 곧 "daemon 을 먼저 세운다"이다
 *
 * `observe()` 는 조회처럼 보이지만 **부작용이 요점이다**: Rust 쪽 `daemon_list_runners`
 * 가 `ensure_daemon` 을 부르므로, 이 한 번의 호출로 daemon 이 없으면 뜨고 있으면 붙는다.
 * 그래서 앱은 **띄울 러너가 하나도 없어도** 기동 직후 이것을 부른다.
 *
 * ## 왜 그 순서여야 하나 — 순환을 끊는다
 *
 * 앞 판본에서 daemon 에 닿는 자리는 `daemonSpawner.spawn()` **하나뿐**이었다. 그런데
 * 그 앞단(`doStartOne`)이 presence 를 보고 `external` 로 판정하면 `spawn()` 을 안
 * 부른다. 그래서 이런 고리가 생긴다:
 *
 * ```
 * 내 장부에 없는 러너가 서버 presence 에 있다
 *   → 앱이 external 로 판정한다 → spawn() 을 안 부른다
 *   → daemon 이 안 뜬다 → 무엇이 도는지 물을 상대가 없다
 *   → 판정은 영영 presence 뿐이다
 * ```
 *
 * **실측(2026-09-06, 두 번)**: 다른 워크트리의 러너들이 살아 있기만 해도 이 앱이
 * 아무것도 못 띄웠고, 사람이 `ps` 로 찾아 죽여야 풀렸다. 두 번째 실측에서 그중 2개는
 * **고아가 아니라 남의 살아 있는 daemon(pid 35721)의 자식**이었다 — 즉 사람이 고아를
 * 지워도 안 풀린다. **"고아를 정리하면 되는 문제"가 아니라 판정 주체가 틀린 문제다.**
 *
 * `observe()` 를 먼저 부르는 것이 그 고리의 첫 화살표를 끊는다.
 */
export interface DaemonObserver {
  /**
   * daemon 을 확보하고 그 장부를 읽는다. 실패는 **던진다** — 삼키면 "daemon 이 도는 줄
   * 알았는데 아니었다"가 되고, 그 상태가 `#431` 이 없애려는 바로 그것이다.
   */
  observe(): Promise<DaemonObservation>;
  /**
   * 이 에이전트의 러너를 **세대를 지정하지 않고** 끝낸다 — daemon 장부의 현 세대에
   * SIGTERM 을 보낸다(`daemon/src/runners.ts::killRunner(agentId, incarnationId?)`).
   *
   * ## 왜 자식 핸들(`RunnerProcess.kill`)이 아닌가
   *
   * 그 핸들은 **이 앱 세션이 띄운 자식**만 갖는다. 앱을 다시 띄우면 이전 세션의 러너는
   * 장부에 남아 `adopted` 로 판정되고 핸들은 없다 — 그런데 번들이 뒤처진 러너는 정확히
   * 그 경우가 대부분이다. 자식 핸들로만 죽이면 이 기능이 가장 필요한 자리에서 아무 일도
   * 일어나지 않는다.
   *
   * ## 왜 세대(`incarnationId`)를 싣지 않는가
   *
   * 세대를 싣는 이유는 "앱이 옛 세대를 죽이라고 보낸 명령이 그 사이 새로 뜬 러너를
   * 데려가는 것"을 막기 위해서다(`RunnerProcess.kill` 주석). 재기동은 사람이 **지금**
   * 누른 것이고 그 뜻은 "지금 도는 것을 새 번들로 갈아라"다 — 그 사이 세대가 바뀌었다면
   * 이미 새로 뜬 것이므로 그것을 죽이는 것도 사람의 뜻에 맞다.
   */
  kill(agentId: string): Promise<void>;
}

/**
 * 이 앱 번들의 버전을 읽는 표면. `LoginPathReader` 와 **같은 규율**이다 —
 * `null` 은 '얻지 못했다'이고, 그때 조용히 아무 값으로 넘어가지 않는다.
 *
 * 이 값이 두 곳에 쓰인다: 러너의 `AGENT_VERSION`(러너가 서버에 자기 버전을 보고하는
 * 근거)과 뒤처짐 판정의 기준(`runnerVersions.ts::staleRunners`). **한 곳에서 읽어 둘에
 * 쓰는 것이 요점이다** — 따로 얻으면 "러너에 심은 버전"과 "비교에 쓰는 버전"이 갈릴 수
 * 있고, 그러면 방금 재기동한 러너가 계속 뒤처진 것으로 보인다.
 */
export interface AppVersionReader {
  read(): Promise<string | null>;
}

/**
 * 재기동이 러너의 **실제 종료**를 기다리는 방식. 테스트가 즉시 끝내려고 주입한다 —
 * 실제로 자면 회귀선이 분 단위로 느려진다.
 */
export interface RestartWaitOptions {
  /** 장부를 다시 읽는 간격. */
  intervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  /**
   * 기다림의 상한. 진행 중인 턴이 이보다 길면 예약을 포기하고 사유를 남긴다 —
   * 무한히 기다리면 앱이 사는 동안 폴링이 영원히 남는다. 기본 15분은 실측된 가장 긴
   * 턴(326초)의 두 배 이상이다.
   */
  timeoutMs?: number;
}

/** daemon 이 말한 사실. **관측이지 판단이 아니다**(`daemonProtocol.ts::RunnerInfo`). */
export interface DaemonObservation {
  daemonPid: number;
  /** 이미 서비스 중인 daemon 에 붙었는가(`false` 면 이번에 띄웠다). */
  attached: boolean;
  runners: ObservedRunner[];
}

/**
 * daemon 이 러너 하나에 대해 **직접 확인한** 것.
 *
 * ## 왜 셋이 아니라 여섯인가 (`#443`, `docs/desktop-agent-cards.html` 3단계)
 *
 * 앞 판본은 `agentId`·`alive`·`adopted` 셋만 들었고, 그 셋이 실행기의 판정
 * (*"띄울까 말까"*)에 필요한 전부였다. 나머지는 파싱 루프가 **버렸다** — daemon 소켓과
 * Rust(`main.rs::daemon_list_runners` 가 `runners` 를 그대로 통과시킨다)까지는 왔는데
 * TS 로 넘어오는 자리에서 사라졌다(실측 2026-09-08).
 *
 * 그래서 러너가 안 죽을 때 사람이 볼 것이 아무것도 없었다. 정본 문서가 그 자리를 이렇게
 * 적었다: *"카드에 올릴 것은 아니지만 상세에는 있어야 한다 — **러너가 안 죽을 때 사람이
 * 볼 것이 그것뿐이다**."*
 *
 * ## 새 필드가 전부 옵셔널인 이유
 *
 * 옛 daemon 은 이것을 안 보낼 수 있다(아래 파싱 루프 주석과 같은 사정). `0` 이나 `-1`
 * 같은 자리표시를 넣지 않는 것이 요점이다 — 그러면 화면이 "pid 0" 같은 거짓을 그리고,
 * 사람은 그것이 진짜 pid 인지 '모른다'의 표현인지 구분할 수 없다. `undefined` 이면
 * 화면은 **그 행을 그리지 않는다**(규칙 06: 없는 것을 그리지 않는다).
 */
export interface ObservedRunner {
  agentId: string;
  /** daemon 이 `kill(pid, 0)` 으로 **직접 확인한** 생사. 서버 추측이 아니다. */
  alive: boolean;
  /** 띄운 것이 아니라 채택한 것인가(`#431` 2-c). */
  adopted: boolean;
  /** 러너 프로세스의 pid. daemon 장부(`runners-v1.json`)에 적힌 그 값이다. */
  pid?: number;
  /**
   * 이 spawn 이 만든 세대(`daemonProtocol.ts::SpawnRunnerResult`). 같은 에이전트가
   * 재기동을 거치면 올라가므로, 사람이 "방금 누른 재기동이 실제로 갈았나"를 이것으로 본다.
   */
  incarnationId?: string;
  /** daemon 이 이 러너를 띄운(또는 채택한) 시각. epoch ms. */
  startedAtMs?: number;
  /**
   * **daemon 이** SIGTERM 을 보낸 시각. **daemon 이 안 보냈으면 `null`.**
   *
   * `null` 과 `undefined` 가 다르다: `null` 은 *"daemon 이 안 보냈다"* 이고 daemon 이
   * 실제로 말한 사실이며, `undefined` 는 *"옛 daemon 이라 이 필드를 아예 모른다"* 다.
   *
   * **`null` 은 "아무도 종료를 요청하지 않았다"가 아니다.** 종료 요청 경로가 둘이고 이
   * 필드는 그중 하나만 안다 — 사람이 UI 에서 한 것은 서버 DB 의 `stopRequestedAt`(`#428`)이
   * 알고 daemon 은 모른다. 그래서 화면은 두 출처를 **합쳐** 한 줄로 내야 한다
   * (`daemonProtocol.ts::RunnerInfo.termSentAtMs` 의 표 전체가 이 한 줄의 근거다).
   */
  termSentAtMs?: number | null;
}

/**
 * 로그인 셸의 `PATH` 를 읽는 표면(#305). 자식 프로세스와 마찬가지로 **주입한다** —
 * 테스트가 "조회에 실패했다"를 만들 수 없으면 그 경로의 회귀선을 걸 자리가 없다.
 *
 * `null` 은 '얻지 못했다'다(실패했거나 빈 문자열이었다). 그때 조용히 기존 `PATH` 로
 * 넘어가지 않는 것이 이 기능의 요점이다 — 그것이 지금의 실패 모습이다.
 */
export interface LoginPathReader {
  read(): Promise<string | null>;
}

export interface RunnerApi {
  baseUrl: string;
  mintPat(accountId: string, label: string): Promise<string>;
  listPats(accountId: string): Promise<{ label: string; revokedAt: string | null }[]>;
  revokePat(accountId: string, label: string): Promise<{ revoked: number }>;
}

/** 실행기가 대상 판정에 쓰는 에이전트의 사실만. `AgentView` 전체를 요구하지 않는다. */
export interface LaunchableAgent {
  id: string;
  handle: string;
  ownerAccountId: string | null;
  disabled: boolean;
  stopRequestedAt: string | null;
  /**
   * 이 에이전트가 쓰는 하네스(`#473`). **문구에 실행 파일 이름을 넣기 위해 있다.**
   *
   * "하네스를 설치해라"만으로는 사람이 무엇을 설치할지 모른다 — 에이전트마다 다르다
   * (`claude-code` → `claude`, `codex` → `codex`). 그 이름은 이 값에서만 나온다.
   *
   * **선택적이다.** `AgentView` 는 언제나 이 값을 갖지만(`AgentConfig` 를 상속한다),
   * 이 인터페이스는 그보다 좁게 만들어져 있고 호출부가 부분 객체를 넘길 수 있다.
   * 없으면 문구가 실행 파일 이름 없이 나간다 — 지어내는 것보다 낫다(`#368`).
   */
  harness?: string;
}

export interface StartAllInput {
  agents: LaunchableAgent[];
  /** 나(사람) 계정 id. 소유 판정의 기준이다. */
  myAccountId: string;
  /**
   * **지금 폴을 걸고 있는** 계정 id 들(#124 presence). `null` 은 '모른다'다(소켓이 끊겨
   * 있으면 `online` 은 그냥 빈 배열이고, 그것은 '아무도 없다'가 아니다).
   *
   * ## 이 값은 더 이상 **판정하지 않는다** — `#431` 2단계 A 의 결정
   *
   * 앞 판본은 이 집합에 에이전트가 있으면 `external` 로 두고 러너를 안 띄웠다. 그리고
   * `null` 이면(연결 끊김) 아예 아무것도 안 띄웠다. **둘 다 없앴다.**
   *
   * **왜 — presence 는 다른 질문의 답이다.** 서버가 아는 것은 *"이 계정으로 지금 누가
   * 폴을 걸고 있다"* 뿐이고, *"그게 이 기계의, 이 daemon 이 띄운 러너인가"* 는 모른다.
   * `#430` 의 두 실측이 그 간극을 양방향으로 보여 준다:
   *
   * | 실제 러너 | presence | 앞 판본의 판정 | 맞았나 |
   * |---|---|---|---|
   * | 0개 | online | `external` → 안 띄움 | **틀렸다** — 아무도 없는데 안 띄웠다 |
   * | 2개(내 것) | online | `external` → 안 띄움 | 맞다 — 그러나 **우연히** 맞다 |
   *
   * 두 번째 줄이 우연인 이유: 같은 `online` 이 남의 기계·남의 워크트리 러너에서도
   * 똑같이 나온다. 실측(2026-09-06)에서 정확히 그것이 났다 — 다른 워크트리의 러너
   * 8개(고아 6 + **살아 있는 남의 daemon 의 자식 2**)가 presence 에 올라와 있기만 해도
   * 이 앱이 자기 에이전트를 하나도 못 띄웠다.
   *
   * **daemon 은 그 질문에 답할 수 있다**: 장부(`runners-v1.json`)에는 **이 daemon 계보가
   * 자기 손으로 spawn 하거나 채택한 것만** 오르고, 생사는 `kill(pid, 0)` 으로 직접
   * 확인한다(`adopt.ts` 의 "남의 러너를 채택할 수 있는가" 절). 추측과 관측 중 관측이 이긴다.
   *
   * ## 그럼 왜 남겨 두나 — 교차 검증 때문이다
   *
   * 버리지 않은 이유는 **어긋남 자체가 사람에게 의미 있는 사실**이어서다. daemon 장부에
   * 없는데 presence 에 있으면 *"내가 모르는 러너가 이 계정으로 붙어 있다"* 이고, 그것은
   * 실제로 일어나는 일이다(위 실측). 그 사실을 `message` 로 남기되 **기동은 막지 않는다** —
   * 막는 것이 정확히 이 이슈가 없애는 것이다.
   *
   * `null`(연결 끊김)도 이제 기동을 막지 않는다. 막을 이유였던 것은 "중복 러너가 생길까
   * 봐"였는데, 중복을 막는 것은 이제 daemon 장부이지 presence 가 아니다.
   *
   * **`runnerVersion` 은 이 신호가 아니다.** 그 값은 "마지막으로 붙었던 러너의 빌드
   * 버전"이고 러너가 죽어도 지워지지 않는다(013_agent_runner_version.sql 이 그렇게 적어
   * 뒀다: "지금 붙어 있나는 이 테이블이 답하지 않는다. #124 의 인메모리 presence 가
   * 답한다").
   */
  liveAccountIds: Set<string> | null;
}

/** 방금 만든 에이전트와 발급 순간에만 볼 수 있는 PAT 를 앱 실행기에 넘기는 입력. */
export interface StartCreatedInput {
  agent: LaunchableAgent;
  pat: StoredRunnerPat;
  /** 연결 설정의 자동 기동 토글. 꺼져 있어도 PAT 는 키체인에 보관한다. */
  autoStart: boolean;
  /** 현재 presence 사실. 새 계정이어도 연결이 끊긴 상태에서 무작정 띄우지는 않는다. */
  liveAccountIds: Set<string> | null;
}

/** 살아 있는 PAT 라벨의 접두사. 회전 라벨(`desktop:<id>#<epoch>`)도 이 접두사를 갖는다. */
export const patLabelPrefix = (deviceId: string): string => `desktop:${deviceId}`;

/**
 * 자식이 쓸 `PATH` 를 Rust 에게 묻는 invoke 커맨드 이름(`#305` → `#513`).
 *
 * ## 이 자리에 있던 것 — 그리고 왜 사라졌나
 *
 * 앞 판본에는 여기에 shell 스코프 항목이 있었다:
 *
 * ```ts
 * export const LOGIN_PATH_SCOPE_NAME = 'login-path';
 * export const LOGIN_PATH_ARGS = ['-lc', 'echo $PATH'];
 * ```
 *
 * 웹뷰가 `sh` 를 직접 부르되 **그 한 줄만** 부를 수 있게 좁힌 것이었다(`#305`).
 * `#513` 에서 셸 호출이 Rust 로 옮겨가며 그 항목이 통째로 필요 없어졌고,
 * `capabilities/default.json` 에서도 지웠다. 웹뷰가 프로그램을 실행할 수 있는 표면이
 * 이제 **0개**다 — `#250` 부터 좁혀 온 경계의 끝이다.
 *
 * **왜 옮겼는가**(`login_path.rs` 모듈 주석에 자세히 있다): daemon 은 웹뷰보다 먼저
 * 뜨므로 웹뷰가 캐낸 값을 못 쓴다. Rust 가 캐내되, 웹뷰까지 자기 셸을 계속 부르면
 * 출처가 둘이 되어 갈릴 수 있다. 그래서 **하나로 합쳤다.**
 *
 * 왜 이 값이 애초에 필요한가: macOS 에서 Dock/Finder 로 띄운 앱은 로그인 셸의 `PATH` 를
 * 물려받지 않는다(`/usr/bin:/bin:/usr/sbin:/sbin` 정도다). `docs/operations.md` §8-1 이
 * launchd 감독에서 같은 함정을 이미 기록해 뒀다 — 같은 것을 다시 발견하지 마라.
 */
export const LOGIN_PATH_COMMAND = 'login_path';

/**
 * 로그인 셸의 `PATH` 를 못 읽었을 때 자식에 넘기는 기본 디렉터리들(#305).
 *
 * **디렉터리 하나만 남기면 안 된다.** 러너(사이드카)가 실행 중에 부르는 `claude`·`codex`·
 * `avcs`·`git` 이 이 `PATH` 안에서 발견돼야 한다 — 하나라도 없으면 턴이 알 수 없는 이유로
 * 실패하는 모습이 된다. 로그인 셸 값을 얻었을 때는 그것이 이 자리를 대신하므로 쓰지 않는다.
 */
export const SYSTEM_PATH_FALLBACK = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * daemon 장부에는 없는데 서버 presence 에는 있는 상태를 사람에게 말하는 한 줄
 * (`#431` 2단계 A).
 *
 * **이것은 실패가 아니다.** 러너는 떴고 상태는 `running` 이다 — 이 문장이 붙는 이유는
 * 오직 하나, *"이 계정으로 내가 모르는 러너가 하나 더 붙어 있을 수 있다"* 가 사람이
 * 알아야 할 사실이기 때문이다. 앞 판본은 같은 상황에서 **아무것도 안 띄우고** 화면에는
 * `외부에서 실행 중` 이라고 적었다 — 그것이 `#430` 이 기록한 오독이다.
 *
 * **문구를 여기서 크게 손대지 마라** — 화면 문구 재정의는 `#443` 범위다. 이 자리는
 * "그런 상태가 있다"를 표시할 최소한의 자리만 잡는다.
 *
 * ## 상수에서 함수가 됐다(`#619`)
 *
 * 문구가 사전으로 가면서 **모듈 상수로는 둘 수 없게 됐다** — 상수는 모듈이 로드되는
 * 순간 한 언어로 굳고, 그 뒤에 사람이 언어를 바꿔도 이 줄만 옛 언어로 남는다. 언어를
 * 넘겨받는 함수여야 그 굳음이 구조적으로 불가능하다.
 *
 * 회귀선이 이 이름으로 문구를 집으므로(`runnerLauncher.test.ts`) **이름은 그대로 둔다** —
 * 부르는 쪽이 `STRANGER_ATTACHED(t)` 가 되는 것이 변화의 전부다.
 */
export const STRANGER_ATTACHED = (t: Translate): string => t('runner.stranger.attached');

export class RunnerLauncher {
  /** 이 앱이 띄운 자식만. 외부 러너는 여기 없다(앱은 그것을 죽일 수도, 죽여서도 안 된다). */
  private runners = new Map<string, RunnerProcess>();
  /**
   * 에이전트별 최신 실행 세대. 종료 콜백은 자식보다 늦게 도착할 수 있으므로, 에이전트 id만
   * 보고 상태를 바꾸면 PAT 재발급 뒤 옛 자식의 종료가 새 자식을 `stopped`로 덮어쓴다(#419).
   */
  private runTokens = new Map<string, symbol>();
  /** `startOne` 의 비동기 구간까지 포함한 에이전트별 잠금. */
  private starting = new Map<string, Promise<void>>();
  /** dispose 뒤 완료된 비동기 준비가 자식을 다시 띄우지 못하게 하는 수명 경계. */
  private disposed = false;
  private states = new Map<string, RunnerState>();
  private onStateChange?: (states: RunnerState[]) => void;
  /** `setOnObservation` 이 건 구독자. daemon 이 말한 사실이 화면까지 가는 통로다(`#443`). */
  private onObservation?: (runners: ObservedRunner[]) => void;

  /**
   * 로그인 셸 `PATH` 조회 결과의 캐시(#305). **프로세스 생애 동안 한 번만 읽는다** —
   * 자식을 띄울 때마다 셸을 부르면 러너 수만큼 셸이 뜨고, 값은 어차피 바뀌지 않는다.
   * 실패도 캐시한다: 실패를 캐시하지 않으면 셸이 없는 환경에서 매번 다시 시도한다.
   */
  private loginPathOnce: Promise<string | null> | null = null;
  /** 앱 버전을 한 번만 읽어 재사용한다(`loginPathOnce` 와 같은 규율). */
  private appVersionOnce: Promise<string | null> | null = null;

  constructor(
    private api: RunnerApi,
    private secrets: RunnerSecretStore,
    private spawner: RunnerSpawner,
    /** 로그인 셸의 `PATH` 를 읽는 표면(#305). 테스트가 실패를 만들 수 있게 주입한다. */
    private loginPath: LoginPathReader = tauriLoginPathReader,
    /** 회전 라벨에 들어가는 시각. 테스트가 고정할 수 있게 주입한다. */
    private now: () => number = () => Date.now(),
    /**
     * daemon 에게 "무엇이 돌고 있나"를 묻는 표면(`#431` 2단계 A). 주입하는 이유는
     * `spawner`·`secrets` 와 같다 — 회귀선이 "장부에 무엇이 있다"를 만들 수 있어야 한다.
     */
    private daemon: DaemonObserver = tauriDaemonObserver,
    /** 이 앱 번들의 버전. 러너에 심고, 뒤처짐 판정의 기준이 된다. */
    private appVersion: AppVersionReader = tauriAppVersionReader,
    /** 재기동이 실제 종료를 기다리는 방식. 기본은 2초 간격, 상한 15분. */
    private restartWait: RestartWaitOptions = {},
    /**
     * 러너 상태에 실릴 문구를 그 언어로 내는 번역기(`#619` 의 **(b) 주입**).
     *
     * ## 왜 **기본값이 없나**
     *
     * `translator('en')` 을 기본으로 두면 이 클래스를 만드는 자리가 언어를 안 넘겨도
     * 컴파일이 되고, 그러면 **부르는 화면이 조용히 한 언어로 굳는다** — 사람이 설정에서
     * 언어를 바꿔도 러너 사유만 영어로 남는다. 그 굳음은 렌더까지 가야 드러나고,
     * 그때는 이미 여러 자리가 기본값에 기대고 있다. `AgentsSettings::lastTurnLabel` 이
     * 같은 이유로 `Translate` 를 필수로 받는다(그 함수 주석).
     *
     * ## 왜 **맨 뒤인가**
     *
     * 앞에 끼우면 이 클래스를 만드는 회귀선 여섯 자리가 인자를 전부 한 칸씩 민다.
     * 그중 `now` 를 고정해 시각을 재는 시험들(`() => 1_700_000_000_000`)은 자리만
     * 어긋나도 **다른 값이 조용히 그 자리에 들어가** 초록인 채로 틀린 것을 재게 된다.
     *
     * ## 왜 **함수 하나이고 언어 코드가 아닌가**
     *
     * 이 클래스가 만드는 문구에는 길이·시각이 없다(그것은 `daemonFacts` 쪽이다).
     * `Intl` 에 넘길 `locale` 이 필요한 자리가 없으므로 그 인자를 받지 않는다 —
     * 안 쓰는 인자를 받으면 다음 사람이 그것으로 시간을 조립하기 시작한다.
     */
    private t: Translate,
  ) {}

  /**
   * 재기동을 예약해 둔 에이전트들. **취소는 이 집합에서 빼는 것이 전부다** — 이미 보낸
   * SIGTERM 은 되돌릴 수 없으므로(시그널에는 취소가 없다) 취소가 뜻하는 것은
   * "죽은 뒤 다시 띄우지 않는다" 하나다. 그 사실은 화면 문구가 말한다.
   */
  private restarting = new Set<string>();
  /**
   * 회전이 도는 중인 에이전트. **재진입을 막는다**(2026-09-08 실측).
   *
   * 그날 감사 로그에 회전이 1초 간격으로 두 번 찍혔다 — 두 번째가 첫 번째가 방금 발급한
   * PAT 를 폐기했다. 사람이 ▶ 를 두 번 누르거나 두 자리(사이드바·설정)에서 누르면 그렇게
   * 된다. 그 사이에 뜬 러너는 이미 폐기된 PAT 를 들고 있고, 그 상태가 다시 이 사고의 모양이다.
   */
  private reissuing = new Set<string>();
  /** 회수 대기 타이머(`waitForRetirement`). `dispose` 가 거둔다. */
  private retireWaits = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * **앱이 뜨면 daemon 을 세운다** — 띄울 러너가 하나도 없어도(`#431` 2단계 A).
   *
   * 러너 자동 기동 토글이 꺼져 있어도, 소유한 에이전트가 없어도 이것은 돈다.
   * **daemon 은 러너의 부산물이 아니라 상주 프로세스다**(사용자 결정: *"daemon 은 그냥
   * 떠 있는 것"*). 그리고 daemon 이 떠 있어야 비로소 "무엇이 도는가"를 물을 상대가 생긴다
   * — `DaemonObserver` 주석의 순환이 그것 없이는 안 끊긴다.
   *
   * **실패를 던지지 않는다.** 호출자(`controller.start`)는 기동 경로이고, 여기서 던지면
   * daemon 이 없다는 이유로 앱 자체가 안 뜬다. 대신 관측 결과를 `null` 로 돌려 주고,
   * 뒤이은 `startAll` 이 그때 다시 시도하며 그 실패는 러너 상태에 사유로 오른다(`#368`).
   */
  async ensureDaemon(): Promise<DaemonObservation | null> {
    if (this.disposed) return null;
    try {
      return await this.observeAndPublish();
    } catch {
      return null;
    }
  }

  setOnStateChange(cb: (states: RunnerState[]) => void): void {
    this.onStateChange = cb;
  }

  /**
   * daemon 이 말한 **사실**을 받는 자리(`#443`). `setOnStateChange` 와 **갈라 둔다** —
   * 저쪽은 이 앱의 판정이고 이쪽은 관측이다(`appStore.ts::daemonRunners` 의 표).
   *
   * 관측이 **여러 자리에서** 일어난다는 것이 이 구독자가 필요한 이유다: 기동
   * (`ensureDaemon`), 일괄 기동(`startAll`), 방금 만든 에이전트(`startCreated`),
   * 재기동 뒤 재spawn, 그리고 종료를 기다리는 폴링(`awaitRunnerExit`)까지 다섯 곳이다.
   * 호출자가 각자 스토어에 밀어 넣게 두면 새 관측 자리가 생길 때마다 그것을 빠뜨리고,
   * 그러면 **화면의 pid 가 조용히 낡는다.** 그래서 관측을 한 함수(`observeAndPublish`)로
   * 좁히고 그 안에서만 알린다.
   */
  setOnObservation(cb: (runners: ObservedRunner[]) => void): void {
    this.onObservation = cb;
  }

  /**
   * daemon 에게 묻고 **그 답을 구독자에게 흘린다.** 이 클래스의 모든 `observe()` 는 이
   * 함수를 거친다 — 위 `setOnObservation` 주석이 그 이유다.
   *
   * 실패는 **그대로 던진다.** 호출자마다 실패에 붙일 문구가 다르고(누구의 러너를 못
   * 띄웠는지), 여기서 삼키면 그 문구가 사라진다. 실패했을 때 구독자에게 빈 목록을
   * 보내지 않는 것도 같은 규율이다 — "daemon 에 못 닿았다"를 "러너가 없다"로 바꿔
   * 말하는 셈이 되고, 그러면 화면이 방금 전까지 보고 있던 pid 를 잃는다.
   */
  private async observeAndPublish(): Promise<DaemonObservation> {
    const observation = await this.daemon.observe();
    this.onObservation?.(observation.runners);
    return observation;
  }

  getStates(): RunnerState[] {
    return [...this.states.values()];
  }

  private setState(agentId: string, patch: Omit<RunnerState, 'agentId'>): void {
    this.states.set(agentId, { agentId, ...patch });
    this.onStateChange?.(this.getStates());
  }

  /**
   * 대상 전부를 띄운다. **한 에이전트가 못 떠도 나머지는 뜬다** — 하나의 throw 가 루프를
   * 끊으면 목록 뒤쪽 에이전트들은 이유도 없이 안 뜬다.
   *
   * ## daemon 에게 **먼저 묻는다** — 그리고 한 번만 묻는다(`#431` 2단계 A)
   *
   * 관측을 루프 밖에서 한 번 하는 것이 의도다. 에이전트마다 물으면 목록 열 개짜리
   * 워크스페이스에서 소켓 왕복이 열 번 나고, 더 나쁘게는 **루프 도중 장부가 바뀐다** —
   * 앞에서 띄운 러너가 뒤 에이전트의 판정에 끼어든다. 이 앱이 이번 세션에 띄운 것은
   * `this.runners` 가 이미 알고 있으므로(`doStartOne` 첫 줄) 그 창은 필요 없다.
   *
   * 관측에 실패하면 `null` 이고, 그때 **띄우지 않는다** — daemon 이 없으면 러너를 띄울
   * 상대 자체가 없다(폴백 경로는 없앴다, `daemonSpawner` 주석). 사유는 각 에이전트의
   * 상태에 그대로 오른다.
   */
  async startAll(input: StartAllInput): Promise<void> {
    const targets = input.agents.filter((a) =>
      a.ownerAccountId === input.myAccountId && !a.disabled && !a.stopRequestedAt,
    );

    let observation: DaemonObservation;
    try {
      observation = await this.observeAndPublish();
    } catch (err) {
      for (const agent of targets) {
        this.setState(agent.id, {
          status: 'failed',
          exitCode: null,
          message: this.t('runner.launch.daemonUnreachable', { reason: errText(err) }),
        });
      }
      return;
    }

    for (const agent of targets) {
      try {
        await this.startOne(agent, input, observation);
      } catch (err) {
        this.setState(agent.id, {
          status: 'failed',
          exitCode: null,
          message: this.t('runner.launch.failed', { reason: errText(err) }),
        });
      }
    }
  }

  /**
   * 설정 화면에서 만든 에이전트를 앱 재시작 없이 바로 실행 가능하게 만든다.
   *
   * 서버는 PAT 원문을 다시 주지 않으므로 생성 API 가 방금 돌려준 **그 PAT** 를 먼저
   * 키체인에 저장한다. 저장에 실패하면 계정 생성 자체를 실패한 척하지 않고 러너 상태에
   * 복구 가능한 이유를 남기며, 원문은 호출자가 생성 결과 화면에 계속 보여줄 수 있다.
   */
  async startCreated(input: StartCreatedInput): Promise<void> {
    try {
      await this.secrets.write(input.agent.id, input.pat);
    } catch (err) {
      this.setState(input.agent.id, {
        status: 'failed',
        exitCode: null,
        message: this.t('runner.launch.patNotStored', { reason: errText(err) }),
      });
      return;
    }
    if (!input.autoStart || this.disposed) return;

    // 방금 만든 에이전트라도 daemon 을 먼저 확보한다 — 여기가 `startAll` 을 안 거치는
    // 유일한 기동 경로이고, 관측 없이 띄우면 daemon 이 이미 그 에이전트의 러너를 들고
    // 있는 경우(앱을 다시 띄운 직후 같은 핸들을 다시 만들었다면)를 못 본다.
    let observation: DaemonObservation;
    try {
      observation = await this.observeAndPublish();
    } catch (err) {
      this.setState(input.agent.id, {
        status: 'failed', exitCode: null,
        message: this.t('runner.launch.daemonUnreachable', { reason: errText(err) }),
      });
      return;
    }

    await this.startOne(input.agent, {
      agents: [input.agent],
      myAccountId: input.agent.ownerAccountId ?? '',
      liveAccountIds: input.liveAccountIds,
    }, observation).catch((err) => {
      this.setState(input.agent.id, {
        status: 'failed', exitCode: null, message: this.t('runner.launch.failed', { reason: errText(err) }),
      });
    });
  }

  private startOne(
    agent: LaunchableAgent,
    input: StartAllInput,
    observation: DaemonObservation,
  ): Promise<void> {
    const pending = this.starting.get(agent.id);
    if (pending) return pending;

    const started = this.doStartOne(agent, input, observation).finally(() => {
      if (this.starting.get(agent.id) === started) this.starting.delete(agent.id);
    });
    this.starting.set(agent.id, started);
    return started;
  }

  /**
   * 한 에이전트를 띄울지 정한다. **판정의 주체가 daemon 이다**(`#431` 2단계 A).
   *
   * ## 무엇이 사라졌나 — presence 로 하던 `external` 판정
   *
   * 앞 판본은 이 자리에서 두 번 물러났다:
   *
   * ```ts
   * if (input.liveAccountIds === null) return;              // 연결 끊김 → 안 띄움
   * if (input.liveAccountIds.has(agent.id)) { external }     // presence → 안 띄움
   * ```
   *
   * **둘 다 없앴다.** 근거는 `StartAllInput.liveAccountIds` 주석에 실측과 함께 적어 뒀다 —
   * 요지는 서버가 *"이 계정으로 누가 붙어 있다"* 만 알고 *"그게 내 daemon 이 띄운
   * 것인가"* 를 모른다는 것이다. 그 둘을 같게 다루면 **남의 워크트리 러너가 내 앱을
   * 마비시킨다**(실측 2026-09-06, 두 번).
   *
   * ## 무엇이 대신 들어왔나 — 장부에 있고 살아 있는가
   *
   * daemon 은 자기 장부(`runners-v1.json`)에 있는 pid 에 `kill(pid, 0)` 을 직접 걸어
   * 생사를 안다. 그래서 판정이 이렇게 좁아진다:
   *
   * | daemon 장부 | 이 앱의 행동 |
   * |---|---|
   * | 있고 `alive` | 안 띄운다 — **중복 금지**(2-c 가 만든 성질) |
   * | 있지만 죽었다 | 띄운다 — 장부는 이력이지 현재가 아니다 |
   * | 없다 | 띄운다 — **presence 에 무엇이 있든** |
   *
   * 세 번째 줄이 이 이슈의 핵심이다. **장부에 없는 러너는 내 것이 아니고**, 남의 것 때문에
   * 내 에이전트를 못 띄울 이유가 없다. 그것이 고아든(`ppid=1`) 남의 살아 있는 daemon 의
   * 자식이든 구분하지 않는다 — 실측에서 8개 중 2개가 후자였고, 판정 기준이 presence 하나일
   * 때는 **둘이 똑같이 앱을 막았다.**
   *
   * ## presence 는 남아서 무엇을 하나 — 말은 하되 막지는 않는다
   *
   * 장부에 없는데 presence 에 있으면 *"내가 모르는 러너가 이 계정으로 붙어 있다"* 이고,
   * 그것은 사람이 알아야 할 사실이다. `message` 로 남기고 **띄우기는 그대로 진행한다.**
   */
  private async doStartOne(
    agent: LaunchableAgent,
    input: StartAllInput,
    observation: DaemonObservation,
  ): Promise<void> {
    if (this.disposed) return;
    // 이 앱이 이미 띄웠으면 그대로 둔다.
    if (this.runners.has(agent.id)) return;

    const known = observation.runners.find((r) => r.agentId === agent.id && r.alive);
    if (known) {
      // daemon 이 들고 있고 살아 있다 — 새로 띄우지 않는다. `adopted` 는 "이 daemon 이
      // 채택했다"이고, 그렇지 않으면 이 daemon 이 (다른 앱 세션에서) 직접 띄운 것이다.
      // 어느 쪽이든 **daemon 이 소유하고 있고 살아 있다**는 사실은 같다.
      this.setState(agent.id, { status: 'adopted', exitCode: null, message: null });
      return;
    }

    // 장부에 없는데 presence 에 있다 — 어긋남을 사람에게 말하되 **막지는 않는다**.
    const strangerAttached = input.liveAccountIds?.has(agent.id) === true;

    const pat = await this.ensurePat(agent.id);
    if (!pat || this.disposed) return; // 사유는 ensurePat 이 상태에 남겼다.
    await this.spawnRunner(agent, pat.token, strangerAttached ? STRANGER_ATTACHED(this.t) : null);
  }

  /**
   * 앞 세대 러너가 물러나기를 기다렸다 **다시 띄운다**(2026-09-07 후속).
   *
   * 간격을 고정으로 두는 이유: 기다리는 대상이 "진행 중인 턴 하나"이고 그 길이는
   * 러너의 턴 예산(기본 30분)까지 갈 수 있다. 지수 백오프를 걸면 늦게 끝난 턴 뒤에
   * 자리가 비어 있는데도 한참 안 뜨고, 그 사이 그 에이전트는 아무 멘션도 못 받는다.
   *
   * 상한을 두지 않는 이유: 상한을 넘기면 남는 선택은 "실패로 칠한다"인데, 그것은 사실이
   * 아니다(앞 세대는 여전히 물러나는 중이다). 앱이 닫히면(`dispose`) 함께 사라지므로
   * 무한히 도는 타이머도 아니다.
   */
  private waitForRetirement(agent: LaunchableAgent, token: string, note: string | null): void {
    if (this.disposed) return;
    this.setState(agent.id, {
      status: 'restarting',
      exitCode: null,
      message: this.t('runner.restart.waitingForRetirement'),
    });
    const timer = setTimeout(() => {
      this.retireWaits.delete(agent.id);
      if (this.disposed) return;
      // 실패는 여기서 삼킨다 — 이 경로는 이미 예약이고, 던져도 받을 호출자가 없다.
      // `spawnRunner` 가 다시 `retiring` 을 만나면 스스로 또 예약한다.
      void this.spawnRunner(agent, token, note).catch((err: unknown) => {
        this.setState(agent.id, { status: 'failed', exitCode: null, message: errText(err) });
      });
    }, RETIRE_WAIT_MS);
    // 앱이 닫힐 때 거둘 수 있게 들고 있는다 — 안 그러면 dispose 뒤에 러너가 하나 뜬다.
    this.retireWaits.set(agent.id, timer);
  }

  /**
   * 키체인의 PAT 를 쓰고, **없을 때만** 발급한다(결정 2). 못 읽었으면 발급하지 않는다 —
   * `SecretRead` 주석에 이유가 있다.
   */
  private async ensurePat(agentId: string): Promise<StoredRunnerPat | null> {
    const read = await this.secrets.read(agentId);
    if (!read.ok) {
      this.setState(agentId, {
        status: 'failed',
        exitCode: null,
        // 여기서 발급으로 넘어가지 않는 것이 요점이라, 그 사실을 사람에게도 말한다.
        message: this.t('runner.launch.keychainUnreadable', { reason: read.error }),
      });
      return null;
    }
    if (read.value) return read.value;

    const deviceId = await this.secrets.deviceId();
    const label = patLabelPrefix(deviceId);

    // 키체인이 비어 있는데 서버에 이 기기 라벨이 살아 있으면, 그 토큰은 **아무도 가지고
    // 있지 않다**(비밀은 발급 순간에만 보인다). 되찾을 수 없으므로 먼저 폐기한다 — 라벨은
    // 살아 있는 토큰 안에서 유일해서(마이그레이션 010) 폐기하지 않으면 발급이 409 로 막힌다.
    const live = (await this.api.listPats(agentId)).filter(
      (p) => p.revokedAt === null && p.label.startsWith(label),
    );
    for (const p of live) await this.api.revokePat(agentId, p.label);

    const token = await this.api.mintPat(agentId, label);
    const stored = { label, token };
    await this.secrets.write(agentId, stored);
    return stored;
  }

  /**
   * 자식이 쓸 `PATH` 를 정한다(#305, `#431` 1단계에서 `pnpm` 경로 설정이 빠지며 단순해졌다).
   *
   * 1. 로그인 셸의 `PATH` 를 **한 번** 읽어 캐시한다 — 러너(사이드카)가 실행 중에 부르는
   *    `claude`·`codex`·`avcs`·`git` 이 그 안에 있어야 한다.
   * 2. 못 읽었으면 `SYSTEM_PATH_FALLBACK` 으로 물러난다. **여기서는 실패하지 않는다** —
   *    사이드카 자신은 `pnpm`처럼 `PATH` 에서 찾아야 하는 대상이 아니라(Rust 가 그 경로를
   *    직접 알고 있다, `sidecar_path()`), 이 값이 없다고 사이드카 실행 자체가 막히지는
   *    않는다. 다만 그 안에서 도는 하네스 CLI 를 못 찾으면 그 턴이 실패하고, 그 사유는
   *    이 앱이 지어내지 않고 러너 자신의 출력이 그대로 사람에게 보인다(`#368`).
   */
  private async resolveChildPath(): Promise<string> {
    this.loginPathOnce ??= this.loginPath.read()
      .then((p) => (p && p.trim() ? p.trim() : null))
      .catch(() => null);
    const login = await this.loginPathOnce;
    return login ?? SYSTEM_PATH_FALLBACK;
  }

  /**
   * 이 앱 번들의 버전. `resolveChildPath` 와 같은 규율으로 **한 번만 읽어 재사용한다** —
   * 앱이 도는 동안 자기 버전이 바뀌는 일은 없고, spawn 마다 IPC 를 왕복할 이유도 없다.
   *
   * 실패는 `null` 이다(던지지 않는다). 버전을 못 얻은 것이 러너를 못 띄울 이유는 아니다 —
   * 그때 잃는 것은 뒤처짐 판정뿐이고, 그 사실은 화면이 '모른다'로 말한다.
   */
  private async readAppVersion(): Promise<string | null> {
    this.appVersionOnce ??= this.appVersion.read()
      .then((v) => (v && v.trim() ? v.trim() : null))
      .catch(() => null);
    return this.appVersionOnce;
  }

  /** 화면이 뒤처짐을 판정할 때 쓰는 기준값. `readAppVersion` 과 **같은 값**이어야 한다. */
  async currentAppVersion(): Promise<string | null> {
    return this.readAppVersion();
  }

  /**
   * 이 에이전트의 러너를 **새 번들로 갈아 띄운다.**
   *
   * ## 왜 한 동작이 아니라 예약인가
   *
   * SIGTERM 은 graceful 이고 SIGKILL 승격이 없다(`daemon/src/runners.ts` 의 "SIGTERM
   * 하나. 여기서 끝이다"와 그 회귀선). 러너는 진행 중인 턴을 마친 뒤에야 죽는다 —
   * 사람이 기다리는 답을 잃지 않기 위한 성질이고, 실측 5분이 넘은 턴도 있다. 그래서
   * 여기서 하는 일은 셋이다: 죽이라고 말한다 → **실제로 죽은 것을 확인한다** → 띄운다.
   *
   * **종료 확인을 daemon 장부로 하는 이유**: 자식 핸들의 `onExit` 은 이 앱 세션이 띄운
   * 러너에만 온다. 뒤처진 러너는 대부분 이전 세션의 것(`adopted`)이라 그 통지가 없다.
   * 장부의 `alive` 는 daemon 이 `kill(pid, 0)` 으로 커널에 직접 물은 값이므로 두 경우를
   * 한 경로로 덮는다.
   *
   * 상한에 걸리면 예약을 접고 사유를 남긴다 — 무한히 기다리면 앱이 사는 동안 폴링이
   * 영원히 남는다. 그때도 SIGTERM 은 이미 갔으므로 러너는 결국 물러나고, 다음 앱 기동의
   * `startAll` 이 새 번들로 띄운다(기존 동작으로 수렴한다).
   */
  async restart(agent: LaunchableAgent, input: StartAllInput): Promise<void> {
    if (this.disposed) return;
    this.restarting.add(agent.id);
    this.setState(agent.id, { status: 'restarting', exitCode: null, message: null });

    try {
      await this.daemon.kill(agent.id);
    } catch (err) {
      this.restarting.delete(agent.id);
      this.setState(agent.id, {
        status: 'failed', exitCode: null,
        message: this.t('runner.restart.killFailed', { reason: errText(err) }),
      });
      return;
    }

    // 이 앱이 들고 있던 자식 핸들은 이제 무효다. 남겨 두면 `dispose()` 가 이미 죽은
    // 자식에게 kill 을 한 번 더 보낸다(무해하지만, 장부의 새 세대를 죽일 창이 생긴다).
    this.runners.delete(agent.id);
    this.runTokens.delete(agent.id);

    await this.pursueRespawn(agent, input);
  }

  /**
   * 종료를 확인하고 다시 띄운다 — **상한에 걸려도 포기하지 않는다.**
   *
   * ## 포기가 왜 못 쓰는 답인가 (2026-09-10 실측)
   *
   * 앞 판본은 상한(15분)에 걸리면 사유만 적고 예약을 접었다. 그 상한은 "실측된 가장 긴
   * 턴(326초)의 두 배"로 잡은 값인데, 지금 턴은 36분까지 간다(러너 턴 예산이 그렇다).
   * 그리고 접으면 **이 앱 세션 동안 이 에이전트에는 러너가 하나도 없다** — 자동 기동은
   * 세션당 한 번뿐이기 때문이다(`controller.ts::startRunners` 의 `runnerAutoStartDone`).
   *
   * 러너가 없으면 아무도 inbox 를 폴하지 않는다. 멘션은 사람이 다시 부르면 되지만
   * **깨움(`agent_wake`)은 부를 사람이 없다** — 서버는 시각이 되어 inbox 항목을 만들고
   * 거기서 끝이다. 실측: 17:26 에 뜬 깨움이 21분 뒤 앱이 새 번들로 다시 뜰 때까지
   * 열리지 않았고, 사람이 "시간이 지났는데 안 열린다"로 먼저 알았다.
   *
   * 그래서 상한은 **포기의 근거가 아니라 사람에게 한 번 말할 근거**다: 문구를 적고
   * 같은 기다림을 다시 건다. 모양은 `waitForRetirement` 와 같다(고정 간격 · 상한 없음 ·
   * `dispose` 가 거둔다) — 두 경로가 기다리는 것이 같은 사실이므로 정책도 같아야 한다.
   */
  private async pursueRespawn(agent: LaunchableAgent, input: StartAllInput): Promise<void> {
    const outcome = await this.awaitRunnerExit(agent.id, () => this.restarting.has(agent.id));
    if (this.disposed) return;
    if (outcome === 'timeout') {
      // **예약을 지우지 않는다**(`restarting` 에 그대로 둔다) — 지우면 아래 재시도가
      // 자기 예약을 잃고, 화면의 [취소] 도 누를 대상이 없어진다.
      this.queueRespawnRetry(agent, input);
      return;
    }
    if (!this.restarting.delete(agent.id)) {
      // 사람이 예약을 취소했다. 종료는 이미 일어났거나 일어날 것이고, 우리는 띄우지 않는다.
      return;
    }
    if (outcome !== 'exited') return;

    let observation: DaemonObservation;
    try {
      observation = await this.observeAndPublish();
    } catch (err) {
      this.setState(agent.id, {
        status: 'failed', exitCode: null,
        message: this.t('runner.restart.respawnUnreachable', { reason: errText(err) }),
      });
      return;
    }
    await this.startOne(agent, input, observation);
  }

  /**
   * 종료 확인이 상한에 걸렸다 — 사람에게 사실을 적고 **같은 기다림을 다시 건다.**
   *
   * 간격을 `RETIRE_WAIT_MS` 로 두는 이유는 `waitForRetirement` 와 같다: 기다리는 대상이
   * 진행 중인 턴 하나이고, 지수 백오프를 걸면 턴이 끝나 자리가 빈 뒤에도 한참 안 뜬다.
   *
   * 타이머를 `retireWaits` 에 넣는다 — `dispose` 가 거두는 그 장부다. 앱이 닫힌 뒤에
   * 러너가 하나 뜨는 일을 두 경로가 같은 방법으로 막는다.
   */
  private queueRespawnRetry(agent: LaunchableAgent, input: StartAllInput): void {
    if (this.disposed) return;
    this.setState(agent.id, {
      status: 'restarting', exitCode: null,
      message: this.t('runner.restart.stillRunning'),
    });
    const timer = setTimeout(() => {
      this.retireWaits.delete(agent.id);
      if (this.disposed) return;
      // 사람이 그 사이 취소했으면 다시 묻지 않는다.
      if (!this.restarting.has(agent.id)) return;
      void this.pursueRespawn(agent, input).catch((err: unknown) => {
        this.restarting.delete(agent.id);
        this.setState(agent.id, { status: 'failed', exitCode: null, message: errText(err) });
      });
    }, RETIRE_WAIT_MS);
    this.retireWaits.set(agent.id, timer);
  }

  /**
   * 재기동 예약을 취소한다 — **뜨는 것만** 취소된다.
   *
   * 이미 보낸 SIGTERM 은 되돌릴 수 없다(시그널에는 취소가 없다). 그래서 이 메서드가
   * 약속하는 것은 "죽은 뒤 다시 띄우지 않는다" 하나이고, 화면 문구도 그렇게 적어야
   * 한다 — "취소했다"로만 적으면 사람은 러너가 계속 살아 있을 것이라 믿는다.
   */
  cancelRestart(agentId: string): void {
    this.restarting.delete(agentId);
    // 기다림을 다시 걸어 둔 타이머도 함께 거둔다 — 남기면 취소한 뒤에 러너가 뜬다.
    // (타이머 콜백도 `restarting` 을 한 번 더 보지만, 여기서 거두는 쪽이 정직하다:
    // 화면의 '기다리는 중' 이 취소 즉시 끝나야 한다.)
    const timer = this.retireWaits.get(agentId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retireWaits.delete(agentId);
    }
  }

  /** 재기동을 예약해 둔 에이전트인가. 화면이 버튼을 이중으로 누르지 않게 본다. */
  isRestarting(agentId: string): boolean {
    return this.restarting.has(agentId);
  }

  /**
   * 장부에서 이 러너가 사라지거나 `alive: false` 가 될 때까지 기다린다.
   *
   * **답이 셋인 이유**: 앞 판본은 `boolean` 이라 "상한에 걸렸다"와 "사람이 그만두라고
   * 했다"가 같은 `false` 였다. 두 사실에 할 일이 다르다 — 상한은 다시 기다릴 근거이고
   * (`queueRespawnRetry`), 취소는 아무것도 하지 않을 근거다. 하나로 두면 호출자가
   * 취소를 상한으로 읽어 취소한 러너를 다시 띄운다.
   *
   * `stillWanted` 는 **이 기다림이 아직 누군가의 것인가**다. 재기동은 사람이 예약을
   * 취소했는지(`restarting`), 회전은 회전이 아직 도는지(`reissuing`)를 본다. 두 호출자가
   * 같은 집합을 보게 두면 한쪽의 취소가 다른 쪽의 기다림을 조용히 끊는다.
   */
  private async awaitRunnerExit(
    agentId: string, stillWanted: () => boolean,
  ): Promise<'exited' | 'timeout' | 'abandoned'> {
    const intervalMs = this.restartWait.intervalMs ?? 2_000;
    const timeoutMs = this.restartWait.timeoutMs ?? 15 * 60_000;
    const wait = this.restartWait.wait ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
    const deadline = this.now() + timeoutMs;

    for (;;) {
      if (this.disposed || !stillWanted()) return 'abandoned';
      let alive: boolean;
      try {
        const observation = await this.observeAndPublish();
        alive = observation.runners.some((r) => r.agentId === agentId && r.alive);
      } catch {
        // 관측 실패는 "살아 있다"도 "죽었다"도 아니다. 다음 주기에 다시 묻는다 —
        // 여기서 죽었다고 단정하면 살아 있는 러너 옆에 두 번째를 띄운다.
        alive = true;
      }
      if (!alive) return 'exited';
      if (this.now() >= deadline) return 'timeout';
      await wait(intervalMs);
    }
  }

  /**
   * `note` 는 **띄우는 것을 막지 않은 어긋남**을 사람에게 남기는 자리다(`#431` 2단계 A).
   * 지금 넘어오는 것은 `STRANGER_ATTACHED` 하나뿐이고, 없으면 `null` 이다 — 없는 사실을
   * 문장으로 만들지 않는다(`#368`).
   */
  private async spawnRunner(
    agent: LaunchableAgent,
    token: string,
    note: string | null = null,
  ): Promise<void> {
    if (this.disposed) return;
    const path = await this.resolveChildPath();
    if (this.disposed) return;
    const version = await this.readAppVersion();
    if (this.disposed) return;
    const runToken = Symbol(agent.id);
    this.runTokens.set(agent.id, runToken);
    let child: RunnerProcess;
    try {
      child = await this.spawner.spawn({
        agentId: agent.id,
        // `AGENT_VERSION` 이 없으면 러너는 자기 버전을 `'unknown'` 으로 보고하고
        // (`packages/agent/src/version.ts`), 그러면 앱은 도는 러너가 옛 번들인지
        // 영원히 알 수 없다 — 뒤처짐 판정 전체가 이 값에 걸려 있다. 얻지 못했으면
        // **넣지 않는다**: 거짓 버전을 심는 것보다 '모른다'가 낫다(design.md §4).
        env: {
          MURMUR_PAT: token,
          MURMUR_URL: this.api.baseUrl,
          PATH: path,
          ...(version === null ? {} : { AGENT_VERSION: version }),
        },
        onExit: (code, tailLines) => this.handleExit(agent, runToken, code, tailLines),
      });
    } catch (err) {
      if (this.runTokens.get(agent.id) === runToken) this.runTokens.delete(agent.id);
      // ── 앞 세대가 아직 물러나는 중이다 — 실패가 아니라 **순서**다 ────────────────
      // daemon 이 낡은 세대의 러너에 SIGTERM 을 보냈고(#551), 러너는 그것을 드레인으로
      // 받아 진행 중인 턴을 끝내고 나간다(`agent/src/main.ts`). 그 전에 교체를 띄우면
      // 둘이 같은 inbox 를 폴해 같은 멘션을 두 번 답한다(`#430`·`#174`).
      //
      // `failed` 로 칠하지 않는 이유: 그러면 사람은 멀쩡한 회수를 고장으로 읽고, 화면에
      // 할 일이 없는 붉은 줄이 선다. 기다리는 것이 사실이므로 기다린다고 말한다.
      if (errText(err).includes(DAEMON_RETIRING_TOKEN)) {
        this.waitForRetirement(agent, token, note);
        return;
      }
      throw err;
    }
    // spawn IPC 도 비동기다. 그 사이 앱/세션이 닫혔다면 방금 생긴 자식을 즉시 거둔다.
    // 또는 자식이 spawn 응답보다 먼저 끝났다면 종료 콜백이 이미 이 세대를 지웠다. 그때
    // 뒤늦게 `running`을 쓰면 죽은 자식을 살아 있다고 표시하므로 같은 경계로 막는다.
    if (this.disposed || this.runTokens.get(agent.id) !== runToken) {
      try { await child.kill(); } catch { /* 이미 끝난 자식 */ }
      return;
    }
    this.runners.set(agent.id, child);
    this.setState(agent.id, { status: 'running', exitCode: null, message: note });
  }

  /**
   * 자식이 끝났다. **78 은 다른 종료와 다른 이야기다 — 그리고 그 안이 또 갈린다**(`#473`).
   *
   * ## 78 이 하나가 아니었다
   *
   * 이 함수의 앞 판본은 이랬다:
   *
   * ```ts
   * if (code === 78) { … message: 'PAT 가 폐기·회전됐다 — 재발급하면 다시 뜬다' }
   * ```
   *
   * **단정이다. 그리고 절반은 틀렸다.** 78(`EX_CONFIG`)을 두 사유가 공유한다:
   *
   * | 사유 | 사람이 할 일 |
   * |---|---|
   * | 자격증명 거부(`#250`) | PAT 를 재발급한다 |
   * | 하네스 실행 파일 부재(`#340`) | `claude`/`codex` 를 설치하고 `PATH` 를 고친다 |
   *
   * `claude`·`codex` 는 사용자가 직접 설치한다(2026-09-06 결정) — 즉 **"하네스가 없다"는
   * 예외가 아니라 새 사용자의 기본 상태다.** `.dmg` 를 받아 처음 여는 사람은 멘션 →
   * 무응답 → "PAT 가 폐기됐다" → 재발급 → 여전히 무응답을 겪었다. 틀린 안내가 사람을
   * 틀린 방향으로 보낸 것이다.
   *
   * ## 무엇으로 가르는가 — 로그의 그 줄
   *
   * 러너는 두 사유를 로그의 마지막 줄로 가른다(`@murmur/shared` 의
   * `CREDENTIAL_REJECTED_LINE`·`EXECUTABLE_NOT_FOUND_LINE`). 그 줄이 여기 닿지 못한
   * 이유는 러너의 stderr 가 `/dev/null` 로 버려졌기 때문이고(`#434`), 그것을 파일로
   * 돌려(`daemon/src/runnerLog.ts`) daemon 이 exit 통지에 꼬리를 실으면서 닿게 됐다.
   *
   * **판정은 여기서 한다. daemon 이 아니라.** daemon 은 꼬리를 그대로 옮길 뿐이고
   * (`RunnerExitEvent.tailLines` 주석), 판정의 결과는 화면 문구다 — 그것을 아는 곳은
   * 여기뿐이다.
   *
   * ## 셋째 갈래 — **둘 다 아닌 78**
   *
   * 꼬리가 비었거나(로그를 못 열었다·옛 daemon 이다) 두 줄 다 없으면 **모른다고 한다.**
   * 지어내지 않는다(`#368`): 코드와 로그 꼬리를 그대로 보여 주는 쪽이 낫다. 앞 판본이
   * 이 자리에서 "PAT" 를 말했고 그것이 이 이슈다.
   */
  private handleExit(
    agent: LaunchableAgent,
    runToken: symbol,
    code: number | null,
    tailLines?: string[],
  ): void {
    const agentId = agent.id;
    // PAT 재발급으로 대체된 옛 자식의 늦은 종료 통지는 최신 자식의 사실이 아니다.
    if (this.runTokens.get(agentId) !== runToken) return;
    this.runTokens.delete(agentId);
    this.runners.delete(agentId);
    if (code === EX_CONFIG) {
      this.setState(agentId, { exitCode: code, ...exitStateFor78(agent, tailLines, this.t) });
      return;
    }
    // 재기동을 예약해 둔 러너의 종료는 **끝이 아니라 중간**이다. 'stopped' 로 적으면
    // 화면이 "멈췄다"로 바뀌고, 곧 새 러너가 뜨면 상태가 두 번 튄다 — 사람은 그 사이에
    // 실패한 줄 안다. 예약을 든 `restart()` 가 다음 상태를 책임진다.
    if (this.restarting.has(agentId)) return;
    // 사유를 따로 적지 않는다 — 코드가 곧 사유이고, `runnerStatusLabel` 이 그것을 문장으로
    // 만든다. 여기서 같은 말을 한 번 더 하면 화면에 같은 숫자가 두 번 뜬다.
    this.setState(agentId, { status: 'stopped', exitCode: code, message: null });
  }

  /**
   * PAT 재발급. **새 발급 → 옛 폐기 → 재실행** 순서다(결정 3).
   *
   * 왜 발급이 먼저인가: 폐기가 먼저면 발급이 실패한 순간(서버가 죽었거나 권한이 바뀌었거나)
   * 쓸 수 있는 PAT 가 하나도 없고, 그 사이 돌고 있던 러너는 이미 401 로 물러난다 — 사람은
   * 버튼 하나로 러너를 잃는다. 발급이 먼저면 실패해도 옛 PAT 가 살아 있어 아무것도 잃지 않는다.
   *
   * 라벨을 새로 만드는 이유: 서버는 **살아 있는 토큰 안에서 라벨이 유일**하고 중복을 409 로
   * 거절한다(마이그레이션 010). 같은 라벨로 먼저 발급하는 것은 불가능하므로, 회전 라벨에
   * 시각을 붙여 새 라벨로 발급하고 곧바로 옛 라벨을 폐기한다 — 두 개가 함께 사는 시간은
   * 그 사이뿐이다.
   */
  async reissue(target: { agent: LaunchableAgent }): Promise<void> {
    const agentId = target.agent.id;
    if (this.disposed) return;
    // 이미 도는 회전이 있으면 아무 일도 하지 않는다 — 두 번째 회전은 첫 번째가 방금
    // 발급한 PAT 를 폐기한다(`reissuing` 주석의 실측).
    if (this.reissuing.has(agentId)) return;
    this.reissuing.add(agentId);
    try {
      await this.doReissue(target);
    } finally {
      this.reissuing.delete(agentId);
    }
  }

  private async doReissue(target: { agent: LaunchableAgent }): Promise<void> {
    const agentId = target.agent.id;
    const read = await this.secrets.read(agentId);
    if (!read.ok) {
      this.setState(agentId, {
        status: 'failed', exitCode: null,
        message: this.t('runner.reissue.keychainUnreadable', { reason: read.error }),
      });
      return;
    }

    const deviceId = await this.secrets.deviceId();
    const newLabel = `${patLabelPrefix(deviceId)}#${this.now()}`;

    let token: string;
    try {
      token = await this.api.mintPat(agentId, newLabel);
    } catch (err) {
      // 옛 PAT 는 그대로 살아 있다 — 돌고 있는 러너도 그대로다. 아무것도 잃지 않았다.
      this.setState(agentId, {
        status: 'failed', exitCode: null,
        message: this.t('runner.reissue.mintFailed', { reason: errText(err) }),
      });
      return;
    }

    await this.secrets.write(agentId, { label: newLabel, token });

    // ── 폐기 전에 **그 PAT 로 도는 러너가 정말 없는지** 확인한다 (2026-09-08 실측) ──────
    //
    // 앞 판본은 `this.stop(agentId)` 로 자식을 거뒀다고 믿고 곧바로 폐기했다. 그 핸들은
    // **이 앱 세션이 띄운 자식만** 갖는다(`stop` 주석). 그날 드레인 중이던 러너는 앞
    // 세대(옛 앱 번들이 띄운 것)라 그 맵에 없어 `stop()` 은 no-op 이었고, 폐기만 성공해
    // 멀쩡히 턴을 돌던 러너의 자격증명이 발밑에서 사라졌다.
    //
    // 그래서 둘 다 한다: 자식 핸들이 있으면 그것으로, 없으면 **daemon 에게** 말한다
    // (daemon 은 세대를 안다 — `DaemonObserver.kill` 주석이 정확히 그 자리를 적어 뒀다).
    await this.stop(agentId);
    let toldDaemon = true;
    try {
      await this.daemon.kill(agentId);
    } catch {
      // 못 전했다는 사실만 남긴다. 이때 폐기하면 안 되는 것이 요점이므로 아래에서
      // `gone` 이 `false` 가 되고, 폐기는 미뤄진다.
      toldDaemon = false;
    }
    // SIGTERM 은 graceful 이다 — 러너는 진행 중인 턴을 마친 뒤에 나간다. 그 시차가
    // 이 결함의 전부이므로 **부재를 관측**한다(고정 sleep 이 아니다).
    //
    // 기다림을 화면에 적는다. 이 사고의 시작이 정확히 그 침묵이었다 — 카드가
    // "활동 11분 전"에서 굳어 있었고 아무도 "턴을 마치는 중이다"를 말하지 않아 사람이
    // 그것을 고장으로 읽고 눌렀다. `restart()` 가 같은 자리에서 같은 것을 한다.
    this.setState(agentId, {
      status: 'restarting', exitCode: null,
      message: this.t('runner.reissue.waiting'),
    });
    const gone = toldDaemon
      && await this.awaitRunnerExit(agentId, () => this.reissuing.has(agentId)) === 'exited';

    // 옛 것을 폐기한다. 여기서 실패하면 폐기되지 않은 PAT 가 남으므로 **삼키지 않는다** —
    // 자식은 새 PAT 로 다시 띄우되(새 PAT 는 이미 유효하다) 사람에게 남은 일을 말한다.
    let revokeError: string | null = null;
    let deferredLabel: string | null = null;
    if (read.value && read.value.label !== newLabel) {
      if (gone) {
        try {
          await this.api.revokePat(agentId, read.value.label);
        } catch (err) {
          revokeError = errText(err);
        }
      } else {
        deferredLabel = read.value.label;
      }
    }

    await this.spawnRunner(target.agent, token);
    if (deferredLabel) {
      // **미뤘다는 사실을 말한다.** 폐기되지 않은 PAT 가 남았고, 그것은 사람이 알아야
      // 하는 상태다(바로 위 폐기 실패 경로와 같은 규율). 그리고 옛 러너가 왜 아직
      // 사는지도 함께 적는다 — 그 사실을 안 적으면 사람은 이것을 고장으로 읽고 다시
      // 누르며, 그 반복이 이 사고의 시작이었다.
      this.setState(agentId, {
        status: 'running', exitCode: null,
        message: this.t('runner.reissue.revokeDeferred', { label: deferredLabel }),
      });
    } else if (revokeError) {
      this.setState(agentId, {
        status: 'running', exitCode: null,
        message: this.t('runner.reissue.revokeFailed', {
          label: read.value?.label ?? '', reason: revokeError,
        }),
      });
    }
  }

  /**
   * 이 앱이 띄운 자식을 끝낸다. 세대를 먼저 무효화하므로 그 뒤 도착하는 `onExit` 은
   * `handleExit` 첫 줄에서 early-return 한다 — **상태를 갱신하지 않는다.** 호출자가
   * 상태를 책임져야 한다(현재 유일한 호출처인 `reissue` 는 바로 뒤 `spawnRunner` 로 새로 쓴다).
   */
  async stop(agentId: string): Promise<void> {
    const child = this.runners.get(agentId);
    if (!child) return;
    // kill 결과보다 종료 이벤트가 늦을 수 있다. 먼저 세대를 무효화해야 그 콜백이 뒤이어
    // 뜨는 새 자식의 상태를 지우지 못한다.
    this.runTokens.delete(agentId);
    this.runners.delete(agentId);
    try {
      await child.kill();
    } catch { /* 이미 죽었으면 할 일이 없다 */ }
  }

  /** 앱이 닫힌다 — 띄운 자식도 같이 끝낸다. 상태는 지우지 않는다(창이 다시 열리면 보여야 한다). */
  dispose(): void {
    // 회수 대기 타이머를 먼저 거둔다 — 남기면 앱이 닫힌 뒤에 러너가 하나 뜬다.
    for (const timer of this.retireWaits.values()) clearTimeout(timer);
    this.retireWaits.clear();
    this.disposed = true;
    for (const child of this.runners.values()) void child.kill().catch(() => {});
    this.runners.clear();
    this.runTokens.clear();
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * exit 통지에 실려 온 꼬리에서 사람이 볼 몇 줄을 고른다(`#473`).
 *
 * **가공하지 않는다** — 자르지도 요약하지도 않고, 빈 줄만 걸러 마지막 `max` 줄을 잇는다.
 * 여기서 무엇을 다듬기 시작하면 그것이 곧 앱이 사유를 지어내는 자리가 된다(`#368`).
 *
 * `max` 를 두는 이유: 이 문구가 목록 한 줄 옆에도 붙는다(`RunnerStatusLine`). 꼬리
 * 스무 줄을 통째로 붙이면 그 줄이 화면을 밀어낸다. 전문은 러너 로그 파일에 있다.
 */
function tailExcerpt(tailLines: readonly string[] | undefined, max = 3): string | null {
  if (!tailLines || tailLines.length === 0) return null;
  const picked = tailLines.map((l) => l.trim()).filter((l) => l.length > 0).slice(-max);
  return picked.length > 0 ? picked.join(' / ') : null;
}

/**
 * 실행 파일 이름을 모를 때 문장의 주어가 되는 말(`이 에이전트의 하네스(claude-code)`).
 *
 * 두 갈래가 **같은 글자를 두 번 적고 있었다**(없는 파일 갈래와 로그인 갈래). 사전으로
 * 옮기며 합친 이유가 그것이다 — 한쪽만 고치면 두 사유가 다른 말로 같은 것을 가리킨다.
 *
 * 하네스 이름조차 없으면 `알 수 없음` 이 들어간다. **지어내지 않는다**(`#368`) —
 * 이름을 비워 두면 문장이 `이 에이전트의 하네스()` 가 되어 사람이 버그로 읽는다.
 */
function subjectHarness(agent: LaunchableAgent, t: Translate): string {
  return t('runner.exit.subjectHarness', {
    harness: agent.harness ?? t('runner.exit.subjectHarnessUnknown'),
  });
}

/**
 * 78 로 죽은 러너의 **상태와 문구**를 정한다 — `#473` 의 핵심 판정.
 *
 * `handleExit` 에서 떼어낸 이유는 회귀선이 이 판정을 상태 기계 없이 직접 부를 수 있어야
 * 하기 때문이다. 그리고 이 함수가 순수하다는 사실 자체가 성질이다: 입력은 꼬리와
 * 하네스 이름뿐이고, 그 둘 말고 판정에 영향을 주는 것이 없다 — **번역기도 인자라**
 * 그 성질이 유지된다(`#619` 의 (b) 주입).
 *
 * 세 갈래다. **셋째("모른다")가 이 이슈가 만든 것이다.**
 */
function exitStateFor78(
  agent: LaunchableAgent,
  tailLines: string[] | undefined,
  // **맨 뒤다.** 앞에 끼우면 이 판정을 직접 부르는 회귀선들이 인자를 한 칸씩 민다
  // (`RunnerLauncher` 생성자 주석의 그 근거와 같다).
  t: Translate,
): { status: RunnerStatus; message: string } {
  const reason = runnerExitReason(tailLines);

  if (reason === 'executable-not-found') {
    // **이름을 말한다.** "하네스를 설치해라"로는 사람이 무엇을 설치할지 모른다 —
    // 에이전트마다 다르다(`claude-code` → `claude`, `codex` → `codex`).
    const binary = harnessBinaryName(agent.harness);
    // 실행 파일 이름은 **번역하지 않는다** — 사람이 터미널에 치는 그 글자다. 감싸는
    // 백틱도 여기서 붙인다: 사전에 두면 번역자가 그 표시를 지울 수 있고, 그러면 이름과
    // 문장이 눈으로 안 갈린다.
    const what = binary ? `\`${binary}\`` : subjectHarness(agent, t);
    // **어떻게 설치하는지까지 말한다**(`#476`). `#473` 이 이름을 넣어 "무엇이 없는가"는
    // 답했지만 "어떻게 채우는가"는 여전히 사람이 검색해야 했다. murmur 는 하네스를
    // 동봉하지 않기로 했으므로(2026-09-06 방침) **어디서 받는지 알려 주는 것이
    // 이 앱이 할 수 있는 전부**다 — 그것마저 안 하면 사람이 할 수 있는 일이 없다.
    //
    // 모르는 하네스면 `null` 이고 그때는 붙이지 않는다 — 지어내지 않는다(`#368`).
    const hint = installHint(binary);
    return {
      status: 'needs_harness',
      // 러너가 로그에 적은 것(넘긴 PATH 원문 등)이 그대로 뒤에 붙는다 — 앱이 다시
      // 설명하지 않고 러너가 한 말을 보인다(`#368`).
      // 안내가 없으면 **그 문장을 안 만든다** — `{hint}` 를 빈 값으로 채우면 마침표만
      // 남은 꼬리가 붙는다. 갈래를 사전에서 갈라 두는 이유가 그것이다.
      message: hint
        ? t('runner.exit.notFound', { what, hint })
        : t('runner.exit.notFoundNoHint', { what }),
    };
  }

  if (reason === 'harness-login-required') {
    // **이름을 말하고, 무엇을 하는지 말한다**(`#473`·`#476` 과 같은 규율). "자격증명을
    // 확인하라"로는 사람이 어디를 볼지 모른다 — 실제로 필요한 것은 한 줄짜리 명령이다.
    const binary = harnessBinaryName(agent.harness);
    const what = binary ? `\`${binary}\`` : subjectHarness(agent, t);
    return {
      status: 'needs_login',
      message: binary
        ? t('runner.exit.loginRequired', { what, binary: `\`${binary}\`` })
        : t('runner.exit.loginRequiredNoBinary', { what }),
    };
  }

  if (reason === 'credential-rejected') {
    // **대조군이다.** 이 갈래는 앞 판본과 문구가 같다 — 이 이슈가 고친 것은 78 을
    // 전부 이쪽으로 보내던 것이지, 이쪽 자체가 아니다.
    return { status: 'needs_reissue', message: t('runner.exit.credentialRejected') };
  }

  // ── 둘 다 아닌 78 — **지어내지 않는다** ────────────────────────────────────
  // 꼬리가 비었거나(daemon 이 로그를 못 열었다·옛 daemon 이라 안 보낸다) 두 구분자가
  // 다 없는 경우다. 여기서 한쪽을 골라 단정하는 것이 정확히 `#473` 의 결함이다.
  //
  // `stopped` 로 두는 이유: `needs_reissue` 는 화면에 "재발급" 버튼을 세우는 상태이고,
  // 사유를 모르는데 그 버튼을 세우면 사람은 다시 틀린 일을 한다. 코드와 꼬리를 그대로
  // 보이고 사람이 판단하게 둔다.
  const excerpt = tailExcerpt(tailLines);
  return {
    status: 'stopped',
    message: excerpt
      ? t('runner.exit.unknownWithLog', { excerpt })
      : t('runner.exit.unknown'),
  };
}

// ---------------------------------------------------------------------------
// Tauri 기본 구현. 위 클래스는 이것을 몰라도 되고, 테스트는 이것을 쓰지 않는다.
// ---------------------------------------------------------------------------

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauriInvoke(): Invoke | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function' ? internals.invoke : null;
}

const PAT_KEY = (agentId: string) => `murmur.runner.pat.${agentId}`;
const DEVICE_KEY = 'murmur.runner.device';

/**
 * 세션 토큰과 **같은 자리**를 쓴다(`lib/session.ts`): Tauri 가 있으면 OS 키체인
 * (`secret_get`/`secret_set`/`secret_delete`), 없으면 `localStorage` 로 물러난다.
 * 폴백의 값이 평문인 것도 session.ts 와 같고, 같은 이유로 받아들인다 — 배포되는 표면이
 * 아니다(브라우저 개발에서는 자식 프로세스 자체를 띄울 수 없다).
 *
 * **키체인 오류는 폴백으로 내려가지 않는다.** session.ts 가 같은 결정을 적어 뒀다: 키체인을
 * 쓰겠다고 해놓고 조용히 평문이 되는 것이 더 나쁘다. 읽기 오류는 `{ ok: false }` 로 올라간다.
 */
export const tauriSecretStore: RunnerSecretStore = {
  async read(agentId) {
    const invoke = tauriInvoke();
    const key = PAT_KEY(agentId);
    if (!invoke) {
      try {
        const raw = localStorage.getItem(key);
        return { ok: true, value: raw ? (JSON.parse(raw) as StoredRunnerPat) : null };
      } catch (err) {
        return { ok: false, error: errText(err) };
      }
    }
    try {
      const raw = await invoke('secret_get', { key });
      if (typeof raw !== 'string' || !raw) return { ok: true, value: null };
      return { ok: true, value: JSON.parse(raw) as StoredRunnerPat };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  },

  async write(agentId, value) {
    const invoke = tauriInvoke();
    const key = PAT_KEY(agentId);
    if (!invoke) { localStorage.setItem(key, JSON.stringify(value)); return; }
    await invoke('secret_set', { key, value: JSON.stringify(value) });
  },

  async clear(agentId) {
    const invoke = tauriInvoke();
    const key = PAT_KEY(agentId);
    if (!invoke) { localStorage.removeItem(key); return; }
    await invoke('secret_delete', { key });
  },

  /**
   * 이 설치를 가리키는 id. 없으면 만들어 키체인에 넣는다.
   *
   * **호스트명을 쓰지 않는다.** 웹뷰의 `location.hostname` 은 Tauri 에서 `tauri.localhost`
   * 로, 어느 머신에서든 같은 값이다. 그것을 라벨에 넣으면 두 대의 맥이 같은 라벨을 쓰고,
   * 라벨이 살아 있는 토큰 안에서 유일하므로(마이그레이션 010) 둘째 머신의 발급이 409 로
   * 막힌다 — 더 나쁘게는, 키체인이 빈 첫 기동의 "같은 라벨 먼저 폐기" 경로가 **다른
   * 머신에서 잘 돌고 있는 러너의 PAT** 를 폐기해 그 러너를 죽인다. 진짜 호스트명은
   * `@tauri-apps/plugin-os` 가 필요한데(lib/platform.ts 가 같은 이유로 그 의존을 거절했다),
   * 라벨에 필요한 것은 사람이 읽을 이름이 아니라 **기기마다 다른 값**이므로 id 로 충분하다.
   */
  async deviceId() {
    const invoke = tauriInvoke();
    const read = async (): Promise<string | null> => {
      if (!invoke) return localStorage.getItem(DEVICE_KEY);
      const raw = await invoke('secret_get', { key: DEVICE_KEY });
      return typeof raw === 'string' && raw ? raw : null;
    };
    const existing = await read();
    if (existing) return existing;
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (invoke) await invoke('secret_set', { key: DEVICE_KEY, value: id });
    else localStorage.setItem(DEVICE_KEY, id);
    return id;
  },
};

/**
 * `runnerExit` 이벤트가 웹뷰로 오는 이름. **Rust 의 `RUNNER_EXIT_EVENT` 와 같아야 한다** —
 * 다르면 exit 통지가 영영 안 와서 죽은 러너가 화면에 계속 `running` 으로 남는다.
 */
export const RUNNER_EXIT_EVENT = 'harkroom://runner-exit';

/** daemon 이 보낸 exit 통지. **`incarnationId` 가 이 이벤트의 핵심 필드다.** */
export interface DaemonRunnerExit {
  agentId: string;
  incarnationId: string;
  code: number | null;
  signal: string | null;
  /**
   * 러너 로그의 마지막 몇 줄(`#473`). 옛 daemon 은 안 보낸다 — 그때 `undefined` 다.
   *
   * **`undefined` 를 빈 배열로 조용히 바꾸지 않는 것이 이 타입의 요점이다.** 아래
   * `SpawnRequest.onExit` 이 그 값을 그대로 넘기고, `handleExit` 이 "꼬리가 없다"를
   * "구분자를 못 봤다"로 다룬다 — 없는 것을 봤다고 하지 않는다.
   */
  tailLines?: string[];
}

/**
 * 러너를 **daemon 을 통해** 띄운다(`#431` 2단계-b 3/3).
 *
 * ## 무엇이 바뀌었나 — 앱은 더 이상 러너의 부모가 아니다
 *
 * 1단계·2/3 까지 이 자리는 `runner_spawn` 이었다: 앱이 사이드카를 직접 띄우고 pid 를
 * 들고 있었다. 이제는 daemon 이 띄우고 daemon 이 들고 있다. 앱이 갖는 것은 소켓 하나다.
 *
 * **`RunnerSpawner` 인터페이스는 그대로다** — `spawn(req) → { kill() }`. 그래서
 * `RunnerLauncher` 의 호출부는 `agentId` 한 줄 말고 바뀌지 않았고, `#419` 의 세대 토큰
 * 판정(`handleExit`)도 그대로 선다.
 *
 * ## `incarnationId` 로 세대를 가린다 — **두 겹이다**
 *
 * `#419` 의 `runTokens`(Symbol)는 **앱 안의** 세대를 가린다. 그런데 소켓을 한 겹 더
 * 거치면서 창이 넓어졌다: daemon 이 보낸 exit 이 앱에 닿기 전에 앱이 그 에이전트의
 * 러너를 새로 띄울 수 있다. 그때 Symbol 은 **새 것**을 가리키고 있으므로 옛 exit 이
 * 그대로 통과한다 — Symbol 은 "이 콜백이 지금 세대의 것인가"를 보지만, 소켓 너머에서
 * 온 통지가 어느 세대의 것인지는 모른다.
 *
 * 그래서 이 자리가 **먼저** 거른다: 이벤트의 `incarnationId` 가 이 spawn 이 받은 것과
 * 다르면 `onExit` 을 아예 안 부른다. 그러면 `handleExit` 의 Symbol 판정은 자기가 원래
 * 재던 것(앱 안의 세대)만 재면 된다. 두 판정이 겹치는 것이 아니라 **다른 것을 재는** 것이다.
 *
 * ## 실패는 폴백하지 않는다
 *
 * daemon 기동에 실패하면 이 함수가 그대로 던진다 — `RunnerLauncher.startAll` 이 그것을
 * 잡아 `failed` + `기동 실패: <사유>` 로 화면에 올린다. **앱이 직접 러너를 띄우는 경로는
 * 이제 없다**(`src-tauri/src/main.rs` 에서 `runner_spawn` 자체가 사라졌다). 있으면
 * "daemon 이 도는 줄 알았는데 아니었다"가 되고, 무엇이 러너를 소유하는지 아무도 모른다.
 */
export const daemonSpawner: RunnerSpawner = {
  async spawn(req) {
    const invoke = tauriInvoke();
    if (!invoke) {
      // 브라우저 개발에서는 unix 소켓도 자식 프로세스도 없다(`RunnerSecretStore` 폴백
      // 주석과 같은 사정) — 그 사실을 그대로 실패로 올린다.
      throw new Error('이 환경에서는 러너를 띄울 수 없다 — Tauri invoke 표면이 없다');
    }
    // **env 를 이름 붙은 값으로 펴서 넘긴다** — 맵째로 넘기면 웹뷰가 자식의 환경을
    // 임의로 고를 수 있고, 그것은 `#431` 이 지키는 성질(웹뷰는 값만 넘긴다)을 깬다.
    // 대신 펴는 자리가 **한 칸씩 빠뜨릴 수 있는 자리**가 된다: `AGENT_VERSION` 이
    // 그렇게 빠져서, 위층이 심어 준 버전이 여기서 사라지고 모든 러너가 자기 버전을
    // `'unknown'` 으로 보고했다. 키를 늘릴 때는 이 자리도 같이 본다.
    const result = await invoke('daemon_spawn_runner', {
      agentId: req.agentId,
      murmurPat: req.env.MURMUR_PAT,
      murmurUrl: req.env.MURMUR_URL,
      path: req.env.PATH,
      // 앱 버전을 얻지 못하면 위층이 `env` 에 키를 아예 넣지 않는다
      // (`spawnRunner` 주석). 그 '없음'을 `null` 로 그대로 넘긴다 — Rust 쪽
      // `Option<String>` 이 받아 env 에 넣지 않는다.
      agentVersion: req.env.AGENT_VERSION ?? null,
    });
    const spawned = result as { agentId?: unknown; pid?: unknown; incarnationId?: unknown };
    if (typeof spawned?.incarnationId !== 'string' || typeof spawned.pid !== 'number') {
      // 지어내지 않는다 — 무엇이 왔는지 그대로 보인다(`#368`).
      throw new Error(`daemon 의 spawnRunner 응답이 계약과 다르다: ${JSON.stringify(result)}`);
    }
    const incarnationId = spawned.incarnationId;

    let notified = false;
    const unlisten = await listenRunnerExit(invoke, (event) => {
      if (notified) return;
      if (event.agentId !== req.agentId) return;
      // **세대가 다르면 버린다** — 위 "두 겹이다" 주석이 이 한 줄의 근거다.
      if (event.incarnationId !== incarnationId) return;
      notified = true;
      void unlistenSafely();
      // 꼬리를 **그대로** 넘긴다(`#473`). 여기서 해석하지 않는 이유는 daemon 이 해석하지
      // 않는 이유와 같다 — 판정은 `handleExit` 한 곳에만 있어야 한다. 옛 daemon 이 안
      // 보내면 `undefined` 이고, 그것을 빈 배열로 바꾸지 않는다.
      req.onExit(event.code, event.tailLines);
    });
    const unlistenSafely = async (): Promise<void> => {
      try { await unlisten(); } catch { /* 이미 떼였다 */ }
    };

    return {
      kill: async () => {
        // **세대를 실어 보낸다** — 안 실으면 daemon 이 "지금 것"을 죽이고, 그 사이 새로
        // 뜬 러너가 대신 죽을 수 있다(`daemonProtocol.ts::KillRunnerParams` 주석).
        await invoke('daemon_kill_runner', { agentId: req.agentId, incarnationId });
      },
    };
  },
};

/**
 * daemon 을 **세우고** 그 장부를 읽는다(`#431` 2단계 A).
 *
 * ## 조회처럼 보이지만 부작용이 요점이다
 *
 * `daemon_list_runners` 는 Rust 쪽에서 `ensure_daemon` 을 부른다 — 즉 이 한 번의 invoke
 * 로 **daemon 이 없으면 뜨고 있으면 붙는다.** 앱이 기동 직후 이것을 부르는 이유가 그것이고,
 * `DaemonObserver` 주석의 순환은 이 호출로만 끊긴다.
 *
 * ## 실패를 삼키지 않는다
 *
 * daemon 이 안 뜨면 러너를 띄울 상대가 없다. 여기서 빈 목록으로 물러나면 호출자는
 * "daemon 은 도는데 러너가 없다"로 읽고 러너를 띄우려 들며, 그 spawn 이 다시 같은
 * 이유로 실패한다 — 사람이 보는 것은 두 번째 실패의 사유뿐이다. 첫 사유를 그대로 올린다.
 *
 * 응답 형태가 계약과 다르면 그것도 실패다. 지어내지 않고 온 것을 그대로 보인다(`#368`).
 */
export const tauriDaemonObserver: DaemonObserver = {
  async observe() {
    const invoke = tauriInvoke();
    if (!invoke) {
      // 브라우저 개발에는 unix 소켓도 자식 프로세스도 없다(`daemonSpawner` 와 같은 사정).
      throw new Error('이 환경에서는 daemon 을 세울 수 없다 — Tauri invoke 표면이 없다');
    }
    const result = await invoke('daemon_list_runners');
    const body = result as {
      daemonPid?: unknown;
      attached?: unknown;
      runners?: unknown;
    };
    if (typeof body?.daemonPid !== 'number' || typeof body.attached !== 'boolean') {
      throw new Error(`daemon 의 listRunners 응답이 계약과 다르다: ${JSON.stringify(result)}`);
    }
    // `runners` 가 배열이 아닌 것은 daemon 이 목록을 못 만들었다는 뜻이지 "0개"가 아니다.
    // 그 둘을 같게 다루면 "장부에 없다 → 띄운다"가 중복 러너를 만든다.
    if (!Array.isArray(body.runners)) {
      throw new Error(`daemon 이 러너 목록을 주지 않았다: ${JSON.stringify(result)}`);
    }
    const runners: ObservedRunner[] = [];
    for (const raw of body.runners) {
      const r = raw as {
        agentId?: unknown; alive?: unknown; adopted?: unknown;
        pid?: unknown; incarnationId?: unknown; startedAtMs?: unknown; termSentAtMs?: unknown;
      };
      if (typeof r?.agentId !== 'string') continue;
      runners.push({
        agentId: r.agentId,
        // 옛 daemon 은 이 필드를 안 보낼 수 있다. 그때 **살아 있다고 본다** — 장부에
        // 이름이 올라 있다는 것 자체가 daemon 이 소유를 주장하는 것이고, 모르는 채로
        // 두 번째 러너를 띄우는 쪽이 더 나쁘다.
        alive: r.alive !== false,
        adopted: r.adopted === true,
        // **아래 넷은 판정에 쓰이지 않는다** — 상세 화면이 사람에게 보일 사실이다(`#443`).
        //
        // 위의 `alive` 와 달리 **없으면 없는 대로 둔다.** `alive` 가 기본값을 갖는 이유는
        // 그것이 "띄울까 말까"를 가르기 때문이고, 판정에 쓰이지 않는 값에 기본값을 주면
        // 그것은 곧 화면에 그리는 거짓이 된다 — `pid: 0` 은 사람이 진짜 pid 로 읽는다.
        // 그래서 형이 맞을 때만 담고, 아니면 키 자체가 없다(규칙 06).
        ...(typeof r.pid === 'number' ? { pid: r.pid } : {}),
        ...(typeof r.incarnationId === 'string' ? { incarnationId: r.incarnationId } : {}),
        ...(typeof r.startedAtMs === 'number' ? { startedAtMs: r.startedAtMs } : {}),
        // `termSentAtMs` 만 `null` 을 **받아 담는다.** daemon 이 보낸 `null` 은
        // *"내가 시그널을 안 보냈다"* 라는 사실이지 결측이 아니고, 그것을 결측으로
        // 접으면 상세가 '시그널' 행을 못 그린다(`ObservedRunner.termSentAtMs` 주석).
        ...(typeof r.termSentAtMs === 'number' || r.termSentAtMs === null
          ? { termSentAtMs: r.termSentAtMs as number | null }
          : {}),
      });
    }
    return { daemonPid: body.daemonPid, attached: body.attached, runners };
  },

  async kill(agentId: string) {
    const invoke = tauriInvoke();
    if (!invoke) throw new Error('이 환경에서는 러너를 끝낼 수 없다 — Tauri invoke 표면이 없다');
    // `incarnationId` 를 **싣지 않는다** — 인터페이스 주석의 근거 그대로다: 사람이 지금
    // 누른 뜻은 "지금 도는 것을 갈아라"이고, Rust 쪽 파라미터는 이미 `Option<String>` 이다.
    await invoke('daemon_kill_runner', { agentId });
  },
};

/**
 * daemon 의 `runnerExit` 이벤트를 듣는다.
 *
 * `@tauri-apps/api` 를 의존으로 들이지 않고 이벤트 플러그인의 invoke 표면을 직접 쓴다 —
 * 이 파일은 이미 `__TAURI_INTERNALS__.invoke` 하나로 키체인·프로세스 표면을 다루고
 * 있고(`tauriInvoke`), 이벤트 하나 때문에 그 규칙을 깨면 표면이 둘로 갈린다.
 */
async function listenRunnerExit(
  invoke: Invoke,
  handler: (event: DaemonRunnerExit) => void,
): Promise<() => Promise<void>> {
  const internals = (globalThis as {
    __TAURI_INTERNALS__?: { transformCallback?: (cb: (payload: unknown) => void) => number };
  }).__TAURI_INTERNALS__;
  if (typeof internals?.transformCallback !== 'function') {
    throw new Error('이 환경에는 Tauri 이벤트 표면이 없다 — 러너 종료 통지를 들을 수 없다');
  }
  const handlerId = internals.transformCallback((payload) => {
    const message = payload as { payload?: unknown };
    const body = message?.payload as DaemonRunnerExit | undefined;
    if (body && typeof body.agentId === 'string' && typeof body.incarnationId === 'string') {
      handler(body);
    }
  });
  const eventId = await invoke('plugin:event|listen', {
    event: RUNNER_EXIT_EVENT,
    target: { kind: 'Any' },
    handler: handlerId,
  });
  return async () => {
    await invoke('plugin:event|unlisten', { event: RUNNER_EXIT_EVENT, eventId });
  };
}

/**
 * 자식이 쓸 `PATH` 를 **Rust 에게 묻는다**(`#305` → `#513`).
 *
 * ## 앞 판본은 여기서 셸을 직접 불렀다 — 그리고 그것이 출처를 둘로 만들었다
 *
 * `#305` 판본은 이랬다:
 *
 * ```ts
 * const out = await Command.create('login-path', ['-lc', 'echo $PATH']).execute();
 * ```
 *
 * shell 플러그인으로 셸을 직접 돌려 값을 만들었다. 그 값이 닿는 곳은 러너 env 하나였고,
 * **daemon 은 그 값을 못 받았다** — daemon 은 웹뷰보다 먼저 뜨기 때문이다(`#431`
 * 2단계 A: `controller.start` 가 러너를 띄울지 정하기 **전에** `ensureDaemon` 을 부른다).
 * 그것이 `#513` 이다: 러너에 `PATH` 를 주는 코드가 정작 그 러너를 띄울 daemon 에는 안 닿았다.
 *
 * 그래서 Rust 가 스스로 캐내게 됐다(`src-tauri/src/login_path.rs`). 그런데 웹뷰가 자기
 * 셸 호출을 그대로 들고 있으면 **출처가 둘**이 된다 — 다른 셸을 부를 수도, 다른 시점의
 * 값을 볼 수도, 한쪽만 실패할 수도 있다. **그래서 이 자리를 조회에서 질의로 바꿨다.**
 * 값을 만드는 곳은 Rust 하나이고, 캐시도 그쪽 하나다.
 *
 * ## 부수 효과 — 웹뷰의 실행 표면이 0개가 됐다
 *
 * `capabilities/default.json` 에서 `shell:allow-execute`(`login-path`) 항목이 통째로
 * 사라졌다. `#250` 이 좁히고 `#305` 가 하나만 남겼던 그 경계가 이제 비었다 —
 * **넓힌 것이 아니라 없앤 것이다**(`test/runnerShellScope.test.ts` 가 못박는다).
 *
 * 실패는 `null` 로 올라간다 — invoke 표면이 없는 환경(브라우저 개발)이나 커맨드가
 * 실패한 경우다. 그때 호출자가 `SYSTEM_PATH_FALLBACK` 으로 넘어간다.
 */
/**
 * 이 앱 번들의 버전. Rust 가 `app.package_info().version` 으로 아는 값을 그대로 받는다 —
 * 러너 사이드카가 **그 Rust 앱과 같은 번들**에서 나오므로 그 값이 곧 러너의 버전이다.
 *
 * daemon 의 `--app-version` 을 쓰지 않는 이유: 상주 daemon 은 자기를 띄운 옛 앱 세대일
 * 수 있다(실측 2026-09-07: daemon 0.1.6 이 소켓을 쥔 채 0.1.7 에게 물러나지 않았다).
 * 그 값을 심으면 새 번들 러너에 옛 버전이 붙어, 재기동해도 계속 뒤처진 것으로 보인다.
 */
export const tauriAppVersionReader: AppVersionReader = {
  async read() {
    const invoke = tauriInvoke();
    if (!invoke) return null;
    try {
      const value = await invoke('app_version');
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  },
};

export const tauriLoginPathReader: LoginPathReader = {
  async read() {
    const invoke = tauriInvoke();
    if (!invoke) return null;
    try {
      const value = await invoke(LOGIN_PATH_COMMAND);
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  },
};

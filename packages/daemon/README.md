# @murmur/daemon

murmur daemon. 앱이 아니라 이쪽이 러너를 소유하게 만드는 상주 프로세스다(`#431` 2단계).

이 패키지는 지금 **소켓을 열고, 토큰으로 인증하고, 러너를 소유하고, 앞선 daemon 이 남긴
고아 러너를 다시 소유한다**(`#431` 2단계-b·c). 배포 경로(Tauri 사이드카 `murmur-daemon`)는
2단계-a 가 이미 깔았다.

## 무엇을 하는가

| 요청 | 하는 일 |
|---|---|
| `spawnRunner` | 러너 사이드카를 **자기 프로세스 그룹으로**(`detached`=`setsid`) 띄우고 `incarnationId` 를 발급한다. **이미 살아 있으면 새로 안 띄운다** |
| `killRunner` | **SIGTERM 을 보내고 기다린다.** 승격 타이머가 없다 — 아래 참조 |
| `listRunners` | `alive`(= `kill(pid, 0)`)·`termSentAtMs`·`adopted` 를 그대로 준다 |
| `adoptRunner` | 장부를 다시 훑어 고아를 소유한다. **payload 를 안 받는다** — 아래 참조 |
| `ping` | `nowMs` |

러너가 끝나면 `runnerExit` 이벤트가 **`incarnationId` 를 달고** 나간다 — 늦게 도착한 exit 이
새 세대를 죽이지 않게 하는 축이다(`#419` 의 `runTokens` 와 같은 성격).

## 고아 재발견 — 무엇으로 찾고 왜 그것인가 (`#431` 2단계-c)

daemon 이 죽어도 러너는 산다(성질 2). 그러면 새 daemon 은 그 러너를 모르고, 앱이
`spawnRunner` 를 부르면 **중복 러너가 생긴다** — `#430` 이 관측한 것이 그것이다.

**후보의 출처는 `<appDataDir>/daemon/runners-v<N>.json` 장부 하나이고, 그 writer 는 daemon
하나다.** presence 도 프로세스 목록 훑기도 쓰지 않는다:

| 안 | 왜 아닌가 |
|---|---|
| presence(서버) | **pid 를 모른다** — `killRunner` 를 걸 수 없다. 그리고 실측에서 러너 0개인데 online 이 나왔다(`#430`) |
| 프로세스 목록 훑기 | 고아는 정의상 `ppid=1` 이라 `ppid` 로 못 거르고, 다른 워크트리의 러너가 **실행 경로까지 같다**(실측 2026-09-06: 이 기계에 6개). `agentId` 는 env 에만 있는데 macOS 는 남의 env 를 못 읽는다 |
| **장부(채택)** | pid·`agentId` 를 함께 남기는 유일한 방법이고 writer 가 하나다(D5) |

**남의 러너를 채택할 수 있는가 — 없다.** 장부에는 이 daemon 계보가 자기 손으로 spawn 한
pid 만 오르고, 다른 워크트리·다른 빌드는 다른 `appDataDir` 를 쓴다. 채택은 곧
`killRunner` 의 대상이 된다는 뜻이라 이 경계가 이 설계에서 가장 중요하다.

**pid 재사용**은 커널이 아는 프로세스 시작 시각(`ps -o lstart`)으로 가른다. 남는 한계
(1초 해상도 · Windows 미대응)는 `src/adopt.ts` 모듈 주석에 적혀 있다. **확실하지 않으면
채택하지 않는다** — 안 채택하면 중복 러너가 생기지만(복구 가능), 잘못 채택하면 무관한
프로세스를 죽인다(되돌릴 수 없다).

`adoptRunner` 요청에 **pid 를 실어 보낼 수 없다.** 받으면 소켓에 붙은 누구든 임의의 pid 를
daemon 의 표에 올려 죽일 수 있다(`#250` 의 경계).

## 이 패키지가 지키는 세 성질

**1. `killRunner` 에 타임아웃이 없다.** `#337` 의 고아 PTY 회수는 유예 뒤 SIGKILL 로 승격하는데,
그 근거는 *"세션은 디스크라 kill 로 잃는 것이 없다"* 이다. 러너 종료에는 그 근거가 성립하지
않는다 — 잃는 것이 **사람이 기다리는 답**이고 디스크 어디에도 없다. 그리고 daemon 은 "지금
죽여도 되는가"를 알 수 없다: 알려면 `sessions.json` 을 읽어야 하는데 그것이 D5 가 금지한
바로 그것이다. 그래서 **모르니까 기다린다.** 근거 전문은 `src/runners.ts::killRunner` 주석에 있다.

**2. daemon 이 죽어도 러너는 산다.** 종료 경로는 엔드포인트만 정리하고 러너에는 아무 시그널도
보내지 않는다. `detached` 덕분에 daemon 의 프로세스 그룹에 오는 시그널도 러너에 닿지 않으므로,
daemon 이 SIGKILL 로 죽어도 결과가 같다.

**3. 엔드포인트가 점유돼 있으면 물러난다.** 종료 코드 `10`(점유) · `11`(판정 미결)이 서로
다른 뜻을 갖는다 — 앱이 "붙어라 / 다시 띄워라 / 사람에게 보여라"를 가를 수 있어야 한다.

## 아직 없는 것

- **수명 관리**(채택 타임아웃·은퇴 플래그·크래시 루프 차단) — 2-d
- **`external` 판정을 앱에서 daemon 으로 옮기는 것** — 2-e. 이 단계는 daemon 이 고아를
  알아보는 데까지다. 화면 문구는 `#443` 이다

`shutdownIfIdle` 은 지금 `unknown-request` 로 거절된다(회귀선으로 고정).

## `sessions.json` 은 여기 없다 (`#431` D5)

daemon 이 소유하는 것은 **프로세스**이지 세션이 아니다. 세션 상태의 원자성은 "쓰는 주체가
하나(러너)"에서 나오고, daemon 이 두 번째 writer 가 되면 lost update 가 — 그것도 조용히 —
난다.

2-c 가 디스크에 파일 하나(장부)를 더하지만 **그 파일도 writer 가 daemon 하나**이고,
`<appDataDir>/daemon/` 안에 산다 — 러너의 상태 디렉터리(`~/.murmur-agent/…`)를 열지
않는다. 스펙 D5 가 제안한 자리가 그 트리였는데 채택하지 않은 근거는
`src/runnerLedger.ts` 모듈 주석에 있다. 회귀선(`test/adopt.test.ts`)이 daemon 소스에
`sessions.json`·`SessionStore`·`.murmur-agent` 가 나타나지 않는 것을 고정한다.

## 로그 — 판정을 남긴다 (`#456` ②)

daemon 은 stdout 에 적고, 앱이 그것을 `daemon-v<N>.log` 로 돌린다(`daemon_client.rs`).
**미묘한 판정일수록 반드시 남긴다:**

- 엔드포인트를 새로 잡았는가 / **잔해를 강탈했는가**(직전 소유자 pid·nonce·근거까지) /
  물러났는가(점유 중인 pid) / 판정 불가인가
- 고아를 몇 건 채택했고, **안 한 것은 왜 안 했는가**(죽은 pid / pid 재사용 / 확인 불가)
- `spawnRunner` 가 **띄운 것인지 이미 있던 것을 돌려준 것인지**

실측(2026-09-06)이 이 항목을 만들었다: 잔해 강탈에 **성공했는데** 로그에 아무것도 없었다.
성공이 안 남으면 실패는 더더욱 안 남는다.

> daemon 을 셸에서 직접 띄우면 이 줄들은 **터미널로 간다** — 로그 파일로 돌리는 것은
> 앱의 spawn 경로이고 daemon 자신은 `--log-file` 인자를 받지 않는다(그 판단의 근거는
> `daemon_client.rs::EndpointPaths::log` 주석).

## 왜 `packages/agent/` 안이 아니라 별도 패키지인가

daemon 을 `@murmur/agent` 안에 두 번째 엔트리로 넣는 것이 더 짧은 길이었다. 그렇게 하지
않은 이유는 **의존 경계 하나** 때문이다.

`@murmur/agent` 는 `node-pty` 를 dependency 로 가진다 — 러너가 하네스를 PTY 로 돌려야 하기
때문이다. **daemon 은 PTY 가 필요 없다.** daemon 이 하는 일은 러너 프로세스를 spawn 하고
unix 소켓으로 말하는 것이고, 그 어느 것도 네이티브 애드온을 요구하지 않는다.

두 엔트리가 한 패키지에 있으면 그 구분이 **관례로만** 남는다. daemon 코드가 어느 날
`../pty.js` 를 import 해도 아무것도 막지 않고, 그러면 esbuild 가 `node-pty` 를 external 로
끌어들여 daemon 사이드카가 조용히 네이티브 의존을 갖게 된다 — 그리고 그 사실은 daemon 을
배포한 앱에서 `node-pty` 를 못 찾아 스폰이 실패할 때 처음 드러난다.

패키지를 나누면 그 경계가 **빌드가 강제하는 것**이 된다: `packages/daemon/package.json` 에
`node-pty` 가 없으므로 daemon 이 그것을 import 하면 typecheck 와 번들이 그 자리에서 깨진다.
`scripts/build-sidecars.mjs` 가 daemon 에 `nativeDeps: []` 를 주는 것도 같은 판단의 다른 쪽
면이다 — external 목록이 비어 있으면 번들에 못 들어가는 것을 눈감아 줄 여지 자체가 없다.

## 인자

앱이 daemon 을 띄울 때 넘기는 값들. 이름은 지어내지 않고 orca daemon 의 실제 명령줄을 읽어
맞췄다(2026-09-05 실측, 근거는 `src/args.ts` 주석).

| 인자 | 뜻 | 근거 |
|---|---|---|
| `--socket` | unix 소켓 경로. 버전이 이름에 박힌다 | `#431` D3 |
| `--token` | 토큰 파일 경로. 같은 머신의 다른 프로세스를 막는다 | `#431` D6 |
| `--pid-record` | pid 기록 파일. 어느 앱 빌드가 띄웠는지 판정한다 | `#431` D3 |
| `--launch-nonce` | 이번 기동의 식별자 | `#431` D3 |
| `--entry-path` | daemon 실행 파일 자신의 경로 | `#431` D3 |
| `--app-version` | 띄운 앱의 버전. 버전 공존 판정의 근거 | `#431` D3·D4 |

**필수는 `--socket` 하나다** — 그것이 없으면 daemon 은 어디에 소켓을 열지 모른다. 나머지는
없으면 빈 값으로 pid 레코드에 실린다(`--launch-nonce` 는 어차피 `claimDaemonEndpoint` 가
이긴 뒤에 스스로 만든 값이 사실이 된다 — 진 daemon 이 알 수 없어야 하기 때문이다).

세 경로를 조립하는 규칙은 여전히 `daemonEndpointPaths` **한 곳에만** 있다. daemon 은
`--socket` 에서 앱 데이터 디렉터리를 되짚어 그 함수에 다시 넣는다(`src/run.ts::appDataDirFromSocket`) —
앱과 daemon 이 각자 이어 붙이면 하나가 옛 이름을 쓰는 어긋남이 조용히 지나간다.

> **경로 길이 주의**: unix 소켓 경로에는 커널 상한이 있다(macOS 104바이트). 넘으면 `bind` 가
> `EINVAL` 로 실패하는데 그 이름만으로는 원인을 알 수 없다 — 실물 검증에서 실제로 밟았다.
> 근거는 `src/server.ts::bindTemporary` 주석에 있다.

## 빌드

```sh
pnpm --filter @murmur/desktop build:sidecar
```

러너와 daemon 사이드카를 **함께** 낸다(같은 디렉터리로 나가므로 청소 지점이 하나여야 한다 —
근거는 `packages/desktop/scripts/build-sidecars.mjs` 주석).

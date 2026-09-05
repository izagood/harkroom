# @murmur/daemon

murmur daemon. 앱이 아니라 이쪽이 러너를 소유하게 만드는 상주 프로세스다(`#431` 2단계).

이 패키지는 지금 **소켓을 열고, 토큰으로 인증하고, 러너를 소유한다**(`#431` 2단계-b).
배포 경로(Tauri 사이드카 `murmur-daemon`)는 2단계-a 가 이미 깔았다.

## 무엇을 하는가

| 요청 | 하는 일 |
|---|---|
| `spawnRunner` | 러너 사이드카를 **자기 프로세스 그룹으로**(`detached`=`setsid`) 띄우고 `incarnationId` 를 발급한다 |
| `killRunner` | **SIGTERM 을 보내고 기다린다.** 승격 타이머가 없다 — 아래 참조 |
| `listRunners` | `alive`(= `kill(pid, 0)`)와 `termSentAtMs` 를 그대로 준다 |
| `ping` | `nowMs` |

러너가 끝나면 `runnerExit` 이벤트가 **`incarnationId` 를 달고** 나간다 — 늦게 도착한 exit 이
새 세대를 죽이지 않게 하는 축이다(`#419` 의 `runTokens` 와 같은 성격).

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

- **고아 재발견**(`adoptRunner`) — 2-c. daemon 이 재시작하면 이전 러너를 못 알아본다.
  그때까지 그 정리는 **사람이** 한다
- **수명 관리**(채택 타임아웃·은퇴 플래그·크래시 루프 차단) — 2-d
- **앱 클라이언트 전환** — 2-b 3/3. 지금 이 소켓에 붙는 앱은 아직 없다

`adoptRunner`·`shutdownIfIdle` 은 지금 `unknown-request` 로 거절된다(회귀선으로 고정).

## `sessions.json` 은 여기 없다 (`#431` D5)

daemon 이 소유하는 것은 **프로세스**이지 세션이 아니다. 세션 상태의 원자성은 "쓰는 주체가
하나(러너)"에서 나오고, daemon 이 두 번째 writer 가 되면 lost update 가 — 그것도 조용히 —
난다. 그래서 러너 표는 **프로세스 사실만** 담고 메모리에만 있다.

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

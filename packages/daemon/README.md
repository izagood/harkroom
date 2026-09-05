# @murmur/daemon

murmur daemon. 앱이 아니라 이쪽이 러너를 소유하게 만드는 상주 프로세스다(`#431` 2단계).

**지금은 골격뿐이다.** 이 패키지가 현재 담고 있는 것은 `#431` 2단계-a — **배포 경로** 하나다:
daemon 을 앱과 함께 나가는 Tauri 사이드카(`murmur-daemon`)로 만들고, 그 산출물이 실제로
실행되는지 확인한다. 소켓·IPC·인증·러너 소유권 이전은 전부 2단계-b 다.

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

골격 단계에서는 **받아서 적고 끝난다** — 어느 것도 필수로 강제하지 않는다. 강제는 실제로
그 값을 쓰는 2단계-b 가 정한다.

## 빌드

```sh
pnpm --filter @murmur/desktop build:sidecar
```

러너와 daemon 사이드카를 **함께** 낸다(같은 디렉터리로 나가므로 청소 지점이 하나여야 한다 —
근거는 `packages/desktop/scripts/build-sidecars.mjs` 주석).

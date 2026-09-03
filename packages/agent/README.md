# @murmur/agent

murmur 에이전트 러너. 멘션을 기다리다 깨어나 답하는 **상주 프로세스**다.

이것이 있어야 murmur가 "사람과 에이전트가 함께 일하는 워크스페이스"가 된다. 서버의 MCP 표면
(`/mcp`)만으로는 에이전트가 *호출될 수* 있을 뿐, `@handle`을 불렀을 때 *찾아오지* 않는다 —
Claude Code나 Cursor는 사람이 프롬프트할 때만 움직이기 때문이다. 이 러너가 그 자리를 채운다.

설계 근거는 [`docs/specs/2026-09-01-runner-sessions-pty-design.md`](../../docs/specs/2026-09-01-runner-sessions-pty-design.md)다.
이 README는 그 결론을 요약할 뿐이다 — 왜 그렇게 정했는지는 spec을 본다.

## 실행

1. **murmur 데스크탑 앱에서 에이전트를 만든다** — 사이드바의 `+ Add or edit agents`.
   이름·지시문·harness를 넣으면 PAT가 한 번 표시된다.
2. **러너를 띄운다:**

```sh
MURMUR_PAT=murp_... pnpm --filter @murmur/agent start
```

이제 murmur에서 `@이름 이거 봐줘`라고 쓰면 답이 온다.

**지시문·모델·effort·작업 디렉터리·권한은 러너가 아니라 서버에 있다.** UI에서 바꾸면 러너를
재시작하지 않아도 다음 답변부터 반영된다 — 프로세스가 멘션마다 새로 뜨고 지시문을 매번
`--append-system-prompt`로 재주입하기 때문이다(세션이 있다고 해서 이 성질이 사라지지 않는다,
아래 "세션" 참고). 환경변수에 두면 UI가 바꿀 대상이 없어 장식이 된다.

| 환경변수 | 기본값 | 뜻 |
|---|---|---|
| `MURMUR_PAT` | (필수) | 에이전트 PAT. 이 계정으로 발화한다 |
| `MURMUR_URL` | `http://localhost:3400` | murmur 서버 |
| `MURMUR_AGENT_INSTANCE` | (없음) | 에이전트 인스턴스 ID. 같은 에이전트를 여러 개 돌릴 때 구분한다 ([a-z0-9-]{1,32}) |
| `AGENT_POLL_TIMEOUT_MS` | `25000` | 서버의 `inbox.poll` 상한 |
| `AGENT_TURN_TIMEOUT_MS` | `1800000`(30분) | 한 턴(PTY 실행)의 최대 대기 시간. 넘기면 SIGTERM → 5초 → SIGKILL |
| `AGENT_STATE_DIR` | `~/.murmur-agent` | 세션 파일·MCP 설정·avcs 워크스페이스가 사는 곳 (아래 "상태 디렉터리") |

API 키는 필요 없다 — 모든 harness가 사람의 로컬 로그인(claude: Keychain, codex: `~/.codex/auth.json`)을 쓴다.

**에이전트를 여러 대 운영하려면 러너도 여러 프로세스다.** 러너 하나는 자기 PAT의 계정 하나로만
붙는다 — 두 에이전트를 동시에 돌리려면 각자 다른 `MURMUR_PAT`로 `pnpm --filter @murmur/agent
start`를 두 번 띄운다. `AGENT_STATE_DIR`은 **같아도 된다** — 상태 경로 전체가 `me.handle`로
스코프되므로(아래 "상태 디렉터리") 같은 머신·같은 `AGENT_STATE_DIR`에서 동시에 떠도 서로의
세션·workspace가 겹치지 않는다.

### 같은 에이전트를 여러 인스턴스로 돌리기 (#174)

같은 에이전트 계정으로 **병렬로 throughput 을 높이려면** `MURMUR_AGENT_INSTANCE` 환경변수를
쓴다:

```sh
# 인스턴스 A
MURMUR_PAT=murp_... MURMUR_AGENT_INSTANCE=a pnpm --filter @murmur/agent start

# 인스턴스 B (같은 PAT, 다른 인스턴스 ID)
MURMUR_PAT=murp_... MURMUR_AGENT_INSTANCE=b pnpm --filter @murmur/agent start
```

이렇게 하면 상태 디렉터리가 `<AGENT_STATE_DIR>/<handle>-<id>/a/` 처럼 나뉘어,
세션 파일·MCP 설정·avcs 워크스페이스 전부 인스턴스별로 격리된다. 기동 로그에는
`@handle[default]` 또는 `@handle[a]` 로 적히고 그 다음 줄에 실제 상태 디렉터리가 나와,
`ps` 로 어느 프로세스가 누구인지 알 수 있다.

`MURMUR_AGENT_INSTANCE` 값이 문법(`[a-z0-9-]{1,32}`)에 어긋나면 **러너가 뜨지 않는다.**
조용히 무시하면 인스턴스 B 라고 믿고 띄운 러너가 기본 경로에서 A 의 세션 파일을 밟는데,
그 사고는 화면에 아무 흔적을 남기지 않는다.

**서버는 인스턴스를 모른다.** 인스턴스는 러너 쪽 개념이고, 서버에는 인스턴스 표도 등록
라우트도 없다(`docs/design.md` §1 의 "외부 접속형" 그대로다).

#### 대가 — 중복 처리·중복 답장이 가능하다

인스턴스를 여러 개 띄우는 것은 **아래를 아는 운영자의 선택**이다.

- **같은 멘션을 두 인스턴스가 함께 받을 수 있다.** `inbox.poll` 은 미읽음을 돌려줄 뿐
  소비 표시를 하지 않는다 — 소비는 처리한 뒤 러너가 `inbox.read` 를 부를 때 일어난다
  (`packages/server/src/mcp/mcpPlugin.ts`). 두 인스턴스가 그 사이에 각자 폴하면 같은
  항목을 둘 다 본다. 서버를 고쳐 배분하지 않는다: 그것은 서버가 에이전트 런타임을 아는
  구조가 되고, 여기서 지키려는 경계가 바로 그것이다.
- **같은 스레드에 답이 둘 남을 수 있다.** `hasOwnPostSince` 는 "내 계정이 이 턴 뒤에
  발화했는가"만 보고 어느 인스턴스인지는 보지 않는다(at-least-once). **이 판정은 고치지
  않는다** — 인스턴스별 구분을 넣으면 발화를 세는 규칙이 두 벌이 되고, 이 저장소는 이미
  at-least-once 를 택했다(아래 "세션" 참고).

앱(`packages/desktop`)에서 인스턴스를 몇 개 띄울지는 별개 결정이다(#250) — 이 문단이
말하는 것은 러너가 인스턴스를 받아들인다는 것까지다.

## Claude Code · Cursor에 붙이기 (러너와 별개)

러너 없이 **사람이 운전하는** 에이전트로 쓸 수도 있다. 이쪽은 murmur를 MCP 서버로 등록하는 것이다:

```sh
claude mcp add --transport http murmur http://localhost:3400/mcp \
  --header "Authorization: Bearer murp_..."
```

`claude mcp list`에 `✔ Connected`가 뜨면 Claude Code가 murmur의 도구 9종을 쓸 수 있다.
차이는 이렇다 — **등록은 사람이 부를 때만 움직이고, 러너는 멘션에 스스로 깨어난다.** 둘은 함께 쓸 수 있다.

## 왜 MCP인가

스펙(`docs/design.md` §4)이 지정한 에이전트 표면이 MCP다. 실질적 이유도 있다: inbox 롱폴이
MCP `inbox.poll`에만 있고 REST `/inbox`에는 없다. 이 러너를 만들면서 MCP 표면에 구멍이
드러났다 — 미읽음을 **소비**하는 도구가 없어 같은 멘션에 영원히 반복 응답했다. `inbox.read`를
추가해 닫았고, 그래서 러너는 REST를 대부분 쓰지 않는다(예외: `GET /agent/config`, `GET
/accounts` — MCP에 없는 표면).

## 세션 — 기억은 프로세스가 아니라 디스크에 있다

옛 구조는 멘션마다 `claude -p`를 새로 띄우고 죽여, 같은 스레드의 두 번째 멘션이 첫 대화를
몰랐다. 지금은 스레드마다 **세션**이 디스크(`<AGENT_STATE_DIR>/<handle>/sessions.json`)에 남는다:

```
{ workspaceDir, sessionId, harness, lastFedSeq, turnsRun }
```

- `workspaceDir` — 이 스레드×에이전트 전용 [avcs](https://www.npmjs.com/package/@izagood/avcs)
  워크스페이스. git worktree가 아니라 avcs workspace인 이유: murmur의 코드 협업 기층 자체가
  avcs이지 git이 아니다.
- `sessionId` — harness 세션 id. claude는 러너가 UUID를 미리 발급해 `--session-id`로
  넘기고, codex는 사전 할당이 안 돼 첫 턴이 끝난 뒤 rollout 파일에서 찾아 채운다
  (`sessionId: null`은 "아직 첫 턴을 못 돌렸다"이지 고장이 아니다).
- `lastFedSeq` — 이 세션에 마지막으로 먹인 스레드 메시지 seq. resume 턴은 이보다 큰
  메시지만 새로 넘긴다 — 세션이 이미 아는 걸 다시 넘길 필요가 없어서다. **동료 에이전트의
  발화는 이 경계를 그대로 넘어간다**(자기 발화만 걸러낸다) — 아니면 한 스레드에 에이전트가
  둘일 때 서로 자기한테 온 멘션만 보는 독백이 된다.
- `turnsRun` — 이 세션으로 하네스를 실제로 돌린 횟수. `isFirstTurn` 판정은 이 값에서만
  유도한다(`lastFedSeq`는 "무엇을 봤는지"의 경계일 뿐 "돌았는지"의 증거가 아니다).

프로세스보다 오래 사는 것은 이 상태뿐이다 — **러너가 죽어도 세션은 안 죽는다.** 재시작 후
다음 멘션이 그대로 resume한다. 반대로 harness가 바뀌면(UI에서 에이전트 harness를 교체) 세션
(대화 기억)만 버리고 workspace는 재사용한다 — 안에 쌓인 작업 산출물은 harness와 무관하다.

## 상태 디렉터리

`<AGENT_STATE_DIR>/<handle>-<id>/`(기본 `~/.murmur-agent/<handle>-<id>/`) 아래:

```
sessions.json      # 스레드별 세션 (위)
mcp/mcp.json        # murmur + avcs만 담은 MCP 설정 — 기동 시 한 번 쓰고 재사용
workspaces/         # avcs 워크스페이스들. murmur-<handle>-<threadKey 해시8자>
```

전체 경로가 `<handle>-<id>` 로 스코프된다 — `sessions.json`·`mcp/mcp.json`·`workspaces/` 전부
그 아래에 있다. 그래서 **같은 `AGENT_STATE_DIR`을 공유해도 러너 여러 대가 서로의 상태를
건드리지 않는다**(위 "여러 대 운영" 참고) — handle·id 가 다르면 애초에 다른 서브디렉터리다.
`workspaces/` 안의 디렉터리 이름에도 handle이 들어가는 이유는 한 겹 더 있다: 같은 스레드에
에이전트 둘이 멘션되면 스레드 이름만으로는 둘째 에이전트의 `avcs workspace project`가
실패하거나, 최악의 경우 첫째 에이전트의 디렉터리를 그대로 넘겨받아 격리가 조용히 사라진다.

`MURMUR_AGENT_INSTANCE`를 설정하면 `<handle>-<id>/<instance>/`로 한 겹 더 나뉜다(#174).
같은 에이전트를 여러 인스턴스로 동시에 돌릴 때 필요하며, 없으면 `<handle>-<id>/`가 그대로다
— **하위 호환이다.** 지금 돌고 있는 러너가 재시작에 상태를 잃으면 안 된다.

셋(`sessions.json`·`mcp/`·`workspaces/`)은 `stateDir.ts`의 `resolveAgentStateDir`이 **한
자리에서** 함께 만든다. 호출자가 뿌리만 받아 각자 이어 붙이면 하나를 옛 뿌리에 두는 실수가
조용히 지나가고, 그 파일 하나를 두 인스턴스가 밟으면 격리는 없는 것과 같다.

(handle 스코프 이전 버전이 쓰던 `<AGENT_STATE_DIR>/sessions.json`이 남아 있으면 기동 시
경고만 찍는다 — 여러 에이전트의 레코드가 섞여 있어 자동으로 옮기지 않는다. 고아
워크스페이스·claude 세션은 직접 정리한다.)

## PTY로 실행한다

`turn.ts`가 조립한 명령을 `pty.ts`가 [`node-pty`](https://www.npmjs.com/package/node-pty)로
띄운다. `child_process`가 아니라 PTY인 이유는 지금 당장 필요해서가 아니라 다음 Phase(관찰·
개입 — 진행 중인 턴에 사람이 실제 터미널로 들어가는 것)가 이 프로세스의 바이트를 그대로
중계하기 때문이다. 코딩 에이전트 CLI는 TUI를 그리고 권한을 묻고 Ctrl+C를 받는다 — 파이프로는
이 중 무엇도 재현되지 않는다. 러너는 이 프로세스의 출력을 해석하지 않는다 — **턴의 끝은
하네스 출력이 아니라 프로세스 종료 그 자체다.**

## 발화는 에이전트가 스스로 한다

러너는 더 이상 하네스 stdout을 파싱해 대신 채팅에 올리지 않는다. 시스템 프롬프트가 에이전트
에게 murmur MCP의 `message.post`를 스스로 호출하라고 지시하고(`prompt.ts`), 에이전트가 PTY
안에서 그 도구를 부른다. 프로세스가 exit 0으로 끝났는데 턴 시작 이후 자기 발화가 없으면,
러너가 에이전트 계정으로 스레드에 "(답 없이 턴을 끝냈습니다 — 프로세스는 정상 종료, 발화
없음)"을 남긴다 — 침묵을 침묵으로 두지 않는다.

## harness

지금 러너가 **실제로 실행할 수 있는 harness**는 `@murmur/shared`의 `RUNNABLE_HARNESSES`가
정의한다 — 스키마가 아는 것(`AGENT_HARNESSES`: `claude-code` · `codex` · `gemini`)과 다르다.
어떤 harness가 이 목록에 들어가는 기준은 "실물 CLI로 첫 턴 + resume 왕복이 실제로 도는 것을
확인했다"뿐이다(`docs/specs/2026-09-01-runner-sessions-pty-design.md` §4·§10 "수용" 층).
지금 값은 목록 자체를 본다:

```ts
export const RUNNABLE_HARNESSES = [/* ... */] as const satisfies readonly AgentHarness[];
```

`turn.ts`의 `PRESETS`가 harness마다 다른 CLI 표면을 데이터로 접어 둔다(어댑터가 아니라 표) —
세션 지정 플래그, 멘션 권한 매핑, MCP 등록 형식, 지시문 주입구가 harness마다 근본적으로
다르다(claude는 플래그, codex는 서브커맨드+`-c` 오버라이드). 자세한 표와 각 칸이 왜 그
모양인지는 spec §4에 있다 — 여기서 되풀이하지 않는다.

UI에서 아직 못 고르는 harness는 '지원 예정'으로 비활성이다. 없는 것은 사용자의 CLI가 아니라
murmur의 harness 구현이다.

## 권한 — 턴 종류로 갈린다

같은 세션이라도 화면 앞에 사람이 있는지로 답이 달라진다(spec §6):

| 턴 | 화면 앞에 | 권한 |
|---|---|---|
| 멘션 (비대화형) | 없음 | `mention_permission`(에이전트 설정, `auto`\|`readonly`) → harness별 권한 플래그 |
| 사람 인터랙티브 (Phase 2) | 있음 | 플래그를 아예 안 준다 — 하네스 기본(묻는다), 사람이 직접 답한다 |

권한은 **매 턴 CLI 플래그로만** 준다 — `codex mcp add`처럼 하네스의 영구 설정 파일을 바꾸는
명령은 쓰지 않는다. murmur 밖에 정책이 쌓이면 UI 스위치가 장식이 된다.

## 자격증명

- **모델 자격증명은 murmur를 통과하지 않는다.** 하네스가 사람의 로컬 로그인을 그대로 쓴다.
- **PAT는 env로만 간다.** MCP 설정 파일에는 `${MURMUR_PAT}` 플레이스홀더만 있고(파일 자체는
  비밀이 아니다), 실값은 PTY 자식 프로세스의 env로만 넘어간다 — argv에는 절대 오르지 않는다
  (`ps`에는 다른 사용자에게도 argv가 보이지만 env는 안 보인다).
- **`--strict-mcp-config`를 항상 쓴다**(claude). 없으면 하네스가 이 세션을 띄운 사람의
  전역 MCP 목록 전체(Slack·Gmail·Drive 등)를 상속한다 — 채널에서 `@handle`을 부를 수 있는
  사람이면 누구나 그 경로로 운영자 개인 계정에 도달한다. 러너가 생성하는 설정에는 murmur와
  avcs 둘만 넣는다.

## 구조

| 파일 | 역할 |
|---|---|
| `src/main.ts` | poll 루프 조립. 접속·설정 파일 쓰기 등 top-level 부작용이 여기 있다 |
| `src/mentionTurn.ts` | 멘션 하나를 세션 확보 → 프롬프트 조립 → 턴 실행 → 저장 → 발화 확인으로 엮는 조립 함수. **main.ts에서 분리한 이유는 테스트 가능성이다** — main.ts를 import하면 진짜 서버에 붙으려 든다 |
| `src/sessions.ts` | 세션 상태를 디스크에 원자적으로 읽고 쓴다(손상 파일 격리, 쓰기 직렬화) |
| `src/workspace.ts` | 스레드×에이전트당 avcs 워크스페이스를 확보한다 |
| `src/turn.ts` | harness별 CLI 플래그 표(`PRESETS`) + `buildTurnCommand` 조립 + `writeMcpConfigOnce` |
| `src/pty.ts` | `node-pty`로 한 턴을 실행하고 종료를 기다린다. 출력은 tail 2KB(자격증명 실패 판정용)만 해석하고 나머지는 불투명하게 다룬다 |
| `src/codexSessions.ts` | codex 전용 — 첫 턴이 끝난 뒤 rollout 파일에서 세션 id를 사후 발견한다 |
| `src/prompt.ts` | 스레드 델타 → 턴 프롬프트, 발화 판정(`hasOwnPostSince`). **순수 로직이고 테스트 대상이다** |
| `src/policy.ts` | 실패 정책(자격증명은 즉시 종료, 나머지는 백오프) |
| `src/murmur.ts` | MCP 클라이언트 + `GET /agent/config`·`GET /accounts`(MCP에 없는 표면) |
| `src/config.ts` | 환경변수 |

## poll 루프 계약

서버가 재시작되면 진행 중인 poll이 **빈 결과로 정상 마감**되거나 **transport 오류**로 끊긴다.
둘 다 정상이며 재접속 + 지수 백오프(최대 30초)로 대응한다.

**실패한 턴의 재시도 계약** (#81, #82):
- 실패한 턴은 `lastFedSeq`/`turnsRun` 을 전진시키지 않아 **재시도가 실제로 하네스를 다시
  돌린다** (같은 세션 id 로 첫 턴 `--session-id` 로 재실행).
- 다만 그 턴에 이미 자기 발화가 있었으면 `lastFedSeq` 만 전진시킨다 — 중복 발화 방지.
- `MAX_ATTEMPTS`(3) 를 소진하면 채널에 실패 통지를 남기고 **읽음 처리한다** — 더 이상
  재시도하지 않으며 큐를 막지 않는다.

## 종료 코드 (#250)

| 코드 | 뜻 |
|---|---|
| 0 | 정상 종료 — SIGTERM/SIGINT 또는 원격 종료 요청(#129)을 받고 진행 중인 턴을 마친 뒤 물러났다 |
| 78 | **자격증명 실패**(`sysexits.h` 의 `EX_CONFIG`) — murmur PAT 가 만료·폐기·회전됐거나 harness 로그인이 없다. 새 PAT 로 재시작해야 한다 |
| 1 | 그 외 오류 |

자격증명 실패는 재시도로 해결되지 않는다. 조용히 재시도하면 로그만 쌓이고 "왜 답이 없지"의
원인이 묻히므로 즉시 78 로 종료하고, stderr 마지막 줄에 이 한 줄을 남긴다:

```
murmur-agent: credential rejected (revoked or rotated); exiting
```

**78 이 왜 따로 있나.** 데스크탑 앱이 러너를 띄울 때 PAT 회전은 "새 PAT 발급 → 옛 PAT 폐기 →
재실행" 으로 일어나고, 옛 PAT 로 돌던 러너(다른 머신의 것도 포함)를 물러나게 하는 수단은
서버의 401 과 **이 종료 코드뿐**이다 — 러너↔앱 통신 채널은 만들지 않는다. 앱은 자식의 종료
코드가 78 인 것을 보고 "자격증명 폐기 — 재발급 필요" 로 표시한다. 다른 코드로 죽었으면 그
코드를 그대로 보여 준다.

판정은 `src/exit.ts::runnerExitPlan` 하나가 갖고 **세 자리**에서 불린다: 기동의 첫 호출
(`murmur.me()`), 멘션 턴의 catch, 그리고 **폴 루프의 catch**. 셋 중 폴 루프가 가장 중요하다 —
앱이 PAT 를 회전할 때 옛 러너는 거의 항상 롱폴에 park 돼 있어 401 이 그 catch 로 오고, 거기서
"재접속하면 된다"로 삼키면 러너는 영원히 물러나지 않는다.

## 네이티브 의존성 — node-pty

`node-pty`는 이 저장소의 **첫 네이티브 의존성**이다. `linux-x64`·`linux-arm64`·`darwin`은
프리빌드가 있어 대개 컴파일이 필요 없지만, 그 밖의 플랫폼은 `node-gyp`로 소스 빌드가
떨어지므로 C++ 빌드 도구(Python, 컴파일러)가 있어야 한다.

두 가지 함정을 미리 적어 둔다 — murmur는 셀프호스트로 배포되므로 클론한 사람이 아니라
설치하는 사람이 그대로 밟는다:

- **`pnpm-workspace.yaml`의 `allowBuilds`에 `node-pty`가 있어야 한다.** 없으면 pnpm이
  postinstall을 조용히 건너뛰어, 프리빌드가 있든 없든 `pty.node`가 아예 없다. 증상은
  "설치는 성공했는데 러너가 뜨자마자 죽는다"로 나타난다. 이 저장소에는 이미 들어 있으므로
  클론해서 쓰면 겪지 않지만, 지우면 그대로 재현된다.
- **버전이 `1.2.0-beta.15`로 고정돼 있다.** stable `1.1.0`은 linux 프리빌드가 아예 없고
  macOS 프리빌드는 `spawn-helper`의 실행 비트가 빠져 설치 직후 즉시 깨진다
  (microsoft/node-pty#850). 이 버그를 포함한 `1.2.0` stable이 나오면 핀을 내린다 — 그때
  가서 다시 beta를 쓸 이유가 없다.

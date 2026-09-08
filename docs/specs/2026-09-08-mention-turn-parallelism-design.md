# 멘션 턴의 스레드별 병렬 실행 — 설계

2026-09-08. 대상: `packages/agent`. 서버·DB·데스크탑 UI 는 바뀌지 않는다.

`2026-09-01-runner-sessions-pty-design.md` §동시성의 v1 결정("러너당 한 번에 하나, 스레드가
달라도 줄 세운다")을 개정한다. 그 결정의 근거는 지우지 않고 남긴다 — 폭주 위험은 이 설계
뒤에도 사실이고, 다만 그 위험을 받기로 한 것이다.

## 1. 왜 — 관측된 결함

**러너의 멘션 루프는 완전히 직렬이라, 턴 하나가 도는 동안 다른 스레드의 멘션이 하나도
처리되지 않는다. 폴 자체가 나가지 않는다.**

실측(2026-09-08, 도그푸딩 러너 한 대의 로그와 서버 DB 의 `inbox` 미읽음):

- 11:36:51 에 시작한 멘션 턴이 11:56 까지 **19분** 진행 중이었다(러너 로그에 `턴 종료` 없음,
  PID 14472 생존).
- 그 사이 도착한 멘션 **5건이 전부 미처리로 쌓였다**. 전부 채널 최상위 멘션이라
  **서로 다른 스레드**다:

  | inbox id | 시각(KST) | 스레드 |
  |---|---|---|
  | 51 | 11:36:51 | (그 턴이 처리 중) |
  | 54 | 11:38:25 | 다른 스레드 |
  | 55 | 11:40:25 | 다른 스레드 |
  | 56 | 11:42:55 | 다른 스레드 |
  | 57 | 11:43:31 | 다른 스레드 |
  | 58 | 11:48:46 | 다른 스레드 |

- 부른 사람에게는 **아무 통지도 가지 않는다.** 유예 통지(`main.ts` 의 `controlledNotice`)는
  `registry.controlOf` 가 참일 때만 뜨고, 그 판정은 인터랙티브 턴과 이어받기 예약만 본다
  (`turnRegistry.ts::controlOf`) — 도는 **멘션** 턴은 `null` 을 돌려준다. 애초에 폴이
  안 나가므로 러너는 그 멘션의 존재조차 모른다.
- 같은 로그의 실측 턴 길이: 5.3 / 5.6 / 5.8 / 6.5 / 6.7 / 7.7 / 8.2분.
  `turnTimeoutMs` 기본값은 30분(`config.ts`)이므로 **한 건의 최대 점유가 30분**이고,
  6건이 밀리면 최악 3시간 무음이다.

원인은 `main.ts` 의 루프 한 줄이다:

```js
while (running) {
  const batch = await murmur.pollInbox(...);   // ← 턴이 도는 동안 여기 못 온다
  for (const entry of batch.entries) {
    await withAccountFailover(..., runMentionTurn(...));   // ← 한 건씩
  }
}
```

서버 쪽 주석이 이 사실을 이미 기록해 두었다(`mcp/mcpPlugin.ts`, `inbox.poll`):

> 러너 루프는 단일 스레드라 턴이 도는 동안 폴이 나가지 않으므로 30초 TTL 이 만료됐다.

**`TurnRegistry` 가 스레드 키를 쓰는 것은 병렬성의 근거가 아니다.** 그 맵의 소비자는 둘뿐이고
(같은 스레드에서 인터랙티브 PTY 와 멘션 턴이 겹치는 것을 막는 것, 사람이 조종 중인 스레드의
멘션을 유예하는 것), "다른 스레드니까 동시에 돌려라"를 지시하는 코드는 어디에도 없다.

## 2. 이미 병렬을 준비해 둔 것들

구조를 새로 만들지 않는다 — 막고 있는 것은 위의 `for…await` 하나다.

- **`SessionStore`** — 쓰기 큐와 flush 마다 유일한 tmp 이름으로 직렬성·원자성을 이미 따로
  보장한다. 그 주석이 전제하는 상황이 정확히 이 설계다: *"동시에 put 이 두 번 들어오면
  (한 프로세스가 여러 스레드에 동시에 답장)"*.
- **workspace** — `workspaceName(handle, threadKey)` 로 스레드마다 갈린다.
- **relay** — `sessions` 가 `Map<string, LiveSession>` 이라 세션이 여럿이어도 성립한다.
- **`runPtyTurn`** — 전역 상태가 없다. 계획을 받아 프로미스를 돌려준다.
- **`TurnRegistry`** — 이미 `threadKey` 맵이고, 같은 스레드에 턴이 겹치면 크게 던진다.

## 3. 왜 `main.ts` 안에서 하지 않는가

**`main.ts` 는 단위 테스트가 불가능하다.** top-level await 로 서버에 붙고 설정 파일을 쓰므로
import 하는 순간 진짜 서버에 접속하려 든다. 그래서 이 저장소는 그 파일의 배선을 소스 문자열
정규식으로 검사한다(`mainCredentialSites.test.ts`, `interactiveWiring.test.ts`,
`wakeWiring.test.ts`, `instanceWiring.test.ts`). 그 테스트들이 스스로 약한 검사임을 적어 두었다:

> 실행 경로를 타지 않으므로 이것은 약한 검사다 — 하지만 이 기능이 실제로 깨졌던 방식이
> 정확히 "판정은 있는데 그 자리에 없다"였다.

동시성 회계(중복 실행, 같은 스레드 두 턴, 시도 횟수 갉아먹기)는 이 저장소가 가장 자주
깨뜨린 종류의 코드다. 그것을 가장 약한 검사만 받는 자리에 두지 않는다. `runMentionTurn` 을
`main.ts` 밖으로 뺀 것과 **같은 이유·같은 패턴**이다.

부수 효과로 기존 정규식 테스트 둘(`wakeWiring`, `mainCredentialSites`)의 검사 대상이
import 가능한 파일로 옮겨가면서 **실제 동작 검사로 승격된다.**

## 4. 설계

### 4-1. 새 모듈 `mentionScheduler.ts`

책임은 하나다: **"이 배치에서 지금 시작할 수 있는 멘션은 무엇인가, 그리고 끝난 턴을 어떻게
회수하는가."**

```ts
export interface MentionScheduler {
  /** 배치를 받아 시작 가능한 것을 전부 띄운다. **턴을 await 하지 않는다.** */
  admit(batch: InboxBatch, ctx: BatchContext): Promise<AdmitOutcome>;
  inFlight(): number;
  /** 인플라이트가 전부 끝날 때까지 기다린다(종료 경로). */
  drain(): Promise<void>;
}

interface AdmitOutcome {
  started: number;   // 이번에 띄운 턴
  deferred: number;  // 사람이 조종 중 — 현행 유예
  blocked: number;   // 이미 인플라이트(같은 entry) 또는 같은 스레드에 턴이 돈다
  skipped: number;   // 메시지가 없는 고아 entry → 즉시 markRead
}
```

**계약의 핵심**: `admit` 은 턴 길이의 일을 절대 `await` 하지 않는다. 유예 통지 post 와 고아
entry 의 markRead 만 await 한다. 그래서 폴 루프가 턴에 묶이지 않는다.

`main.ts` 에 남는 것: 설정·접속·계정 풀 로드·relay·registry·interactive 매니저 배선(전부 현행
그대로), 그리고 `poll → admit → sleep 판정` 루프.

### 4-2. 승인 관문 — 순서가 계약이다

entry 하나마다 이 순서로 판정한다.

| # | 관문 | 통과 못 하면 | `attempts` |
|---|---|---|---|
| 0 | `attempts` 의 `notBefore` 가 지났는가 (실패 백오프, §4-4) | `blocked` | 안 건드림 |
| 1 | `batch.messages` 에 해당 메시지가 있는가 | `skipped` → 즉시 markRead | 안 건드림 |
| 2 | 이 entry 가 이미 인플라이트인가 | `blocked` | 안 건드림 |
| 3 | 사람이 이 스레드를 조종 중인가 (`registry.controlOf`) | `deferred` + 통지 1회 | 안 건드림 |
| 4 | 이 스레드에 턴이 이미 도는가 (§4-3) | `blocked` | 안 건드림 |
| 5 | 통과 | `started` — 인플라이트 등록 후 `void runOne()` | **여기서 증가** |

**0·2·3·4 가 전부 `attempts` 앞에 있는 것이 계약이다.** `main.ts` 의 현행 주석이 유예에 대해
같은 이유를 이미 적었다:

> 이 분기는 `attempts.set` 보다 **앞**이어야 한다 — 뒤에 두면 유예가 시도 횟수를 갉아먹어,
> 오래 조종할수록 그 멘션이 MAX_ATTEMPTS 로 조용히 버려진다.

병렬화는 그 위험을 **넓힌다**: 이제 `blocked` 도 같은 성질을 갖는다. 붐비는 스레드의 멘션이
세 번 blocked 되면 답도 못 듣고 버려진다. 그래서 회귀선을 테스트로 고정한다(§6).

### 4-3. 스케줄러가 자기 `inFlightThreads` 를 드는 이유

관문 4 를 `registry.get(threadKey)` **로만** 판정하면 틀린다. `registry.register` 는
`runMentionTurn` **안에서** 불리므로, `void runOne()` 으로 띄운 시점과 실제 등록 사이에
비동기 간극이 있다. 그 사이에 다음 `admit` 이 돌면 같은 스레드를 한 번 더 통과시키고,
그러면 `register` 가 크게 던진다(설계상 그러도록 되어 있다 — `turnRegistry.ts`).

그래서 스케줄러는 **admit 시점에 동기적으로** 자기 `inFlightThreads: Set<string>` 에 넣는다.
`TurnRegistry` 는 여전히 "지금 어떤 턴이 도는가"의 진실 원천이지만, 그것은 *턴이 도는 동안*의
진실이고 스케줄러가 필요한 것은 *띄우기로 결정한 순간*부터의 진실이다. 두 사실은 다르다.

### 4-4. 완료 회수와 실패 회계

`markRead` 가 배치 단위에서 턴 단위로 내려온다. 동시 턴은 각자 다른 시각에 끝나므로 배치
경계가 의미를 잃는다. MCP 호출이 턴당 1회 늘지만 턴 길이가 분 단위라 무시할 수 있고,
**부수 효과로 presence 가 갱신된다**(`/mcp` 라우트가 요청마다 마킹한다).

```
runOne(entry, mention, anchor, threadKey):
  try {
    turn = await withAccountFailover(accountLane, …runMentionTurn…)   // 현행 그대로
    await murmur.markRead([entry.id]); attempts.delete(entry.id)
    if (stopRequestedForRunner(turn.stopRequestedAt, startedAtMs)) onStopRequested()
  } catch (err) {
    // 현행 5분기를 순서 그대로 이식한다:
    //   noticeIfHarnessLogin → exitIfUnrecoverable → quota → sessionConflict → 실패 회계
  } finally {
    inFlightEntries.delete(entry.id)      // ① 먼저, 동기적으로 (§4-6)
    inFlightThreads.delete(threadKey)
    await interactive.resumeHandoff(threadKey)   // ② 그 다음 (#384, 현행 자리 그대로)
  }
```

**실패 백오프를 전역에서 entry 별로 내린다.** 현행은 `failed = true` → `sleep(backoffMs)` 로
루프 전체를 재운다. 병렬에서는 스레드 A 의 실패가 스레드 B~F 의 새 멘션까지 멈춘다. `attempts`
맵을 레코드로 넓혀 한 맵 안에서 해결한다:

```ts
// 현행:  Map<entryId, number>
attempts: Map<number, { tried: number; notBefore: number }>
```

`main.ts` 에 남는 `backoffMs` 는 **폴 루프 catch 전용**이 된다. 그것은 transport 실패라
진짜로 러너 전역이다. 두 백오프의 축이 분리되는 편이 정확하다.

### 4-5. 폴 타이트 루프 방지

인플라이트 entry 는 unread 로 남으므로(§5) 다음 폴이 즉시 반환한다. 규칙 하나로 막는다:

```
started === 0 && (deferred + blocked) > 0  →  sleep 5초
```

기존 `deferred > 0 && done.length === 0 → sleep 5_000` 과 **같은 상수, 같은 모양**이다.
새 멘션은 최대 5초 늦어진다 — 실측 40분+ 대비 무시할 수 있다.

### 4-6. 리소스 수명

**턴 단위 회수는 현행 그대로다 — 손대지 않는다.** `mentionTurn.ts` 의 `finally` 가
`registry.release(key)` · `session.close()` · 💬 리액션 제거를 보장하고, `runPtyTurn` 의
`exitListener` 가 타이머 정리와 listener dispose 를 보장한다. 하네스 프로세스는 반드시 죽는다:
`turnTimeoutMs`(기본 30분) 초과 시 SIGTERM → 5초 유예 → SIGKILL.

**스케줄러가 새로 드는 장부 2개의 수명 규칙**: `inFlightEntries` · `inFlightThreads` 의 삭제는
`finally` 안에서 **`await` 보다 앞**이어야 한다. `resumeHandoff` 가 던지면 그 뒤 코드가
실행되지 않아 `inFlightThreads` 에 스레드 키가 영구히 남고, **그 스레드가 영원히 blocked** 가
된다 — 프로세스는 회수됐는데 장부만 남아 스레드가 죽는, `turnRegistry.ts` 머리 주석이
경고한 *"디스크에 남기면 그 거짓이 살아남아 멘션이 영원히 유예된다"* 의 인메모리판이다.

**동시 상한은 두지 않는다.** 피크는 그 시점에 시작 가능한 스레드 수다. 실측(2026-09-08,
이 머신에서 도는 claude 프로세스 8개의 RSS): 139 / 152 / 185 / 191 / 196 / 230 / 323 / 344 MB,
중앙값 약 190MB. 즉 동시 6턴이면 약 1.2GB, 20턴이면 약 4GB다. 이 숫자를 여기 적어 두는 것은
나중에 상한이 필요해질 때의 근거를 남기기 위해서다.

### 4-7. 종료·드레인

| 경로 | 동작 |
|---|---|
| SIGTERM / 원격 종료 요청(#129) | `running = false` → **admit 중단** → `await scheduler.drain()` → 루프 탈출. 현행 계약 *"진행 중인 턴을 마쳤으므로 물러난다"* 를 보존한다 |
| `exitIfUnrecoverable`(자격증명 소진, #250) | `process.exit(78)` — 인플라이트 턴이 함께 죽는다. **의도된 동작**이다: at-least-once 라 그 멘션들은 unread 로 남아 다음 러너가 이어받는다 |
| 인터랙티브 PTY | `interactive?.shutdown()` 현행 그대로 |

## 5. 바꾸지 않는 것 — `markRead` 시점

`markRead` 는 **턴 완료 후**에 머문다. 시작 시로 옮기면 at-most-once 가 되어, 러너가 죽을 때
그 멘션이 흔적 없이 사라진다. `mentionQueue.ts` 머리 주석의 *"inbox 의 at-least-once 가 그대로
큐가 된다"* 가 유예 설계 전체의 토대라 뒤집을 수 없다.

그 대가로 인플라이트 entry 가 unread 로 남아 폴이 즉시 반환하는데, 그것은 §4-2 관문 2 로
걸러내고 §4-5 로 타이트 루프를 막는다.

## 6. 테스트

`mentionScheduler.ts` 는 import 가능하므로 실제 단위 테스트를 쓴다. `mentionScheduler.test.ts`:

| 검사 | 무엇을 막는가 |
|---|---|
| 서로 다른 스레드 3건 → `runTurn` 이 동시에 3번 호출된다 | 이 작업의 목적 자체 |
| 같은 스레드 2건 → 1건만 시작된다 | `register` 던짐 / 같은 세션에 PTY 둘 |
| 같은 entry 가 두 폴에 걸쳐 와도 1건만 시작된다 | 중복 실행(§4-3) |
| `blocked`·`deferred` 가 `attempts` 를 건드리지 않는다 | 붐비는 스레드의 멘션이 조용히 버려지는 것(§4-2) |
| 실패 후 `notBefore` 전에는 재시작하지 않는다 | 타이트 재시도 루프 |
| `drain()` 이 인플라이트를 전부 기다린다 | 종료 시 답 유실 |
| `finally` 가 `resumeHandoff` 실패에도 인플라이트를 비운다 | 스레드 영구 blocked(§4-6) |

기존 `wakeWiring.test.ts` · `mainCredentialSites.test.ts` 는 검사 대상이 스케줄러로 옮겨가면서
소스 정규식 검사에서 실제 동작 검사로 바뀐다. `interactiveWiring.test.ts` ·
`instanceWiring.test.ts` 가 보는 배선은 `main.ts` 에 남으므로 대체로 그대로다.

## 7. 스펙 개정

`2026-09-01-runner-sessions-pty-design.md` §동시성을 개정한다. **v1 원문을 지우지 않고**
"v1 결정 → 2026-09-08 개정" 형태로 남긴다 — 그 문단이 경고한 폭주 위험은 이 설계 뒤에도
사실이고, 근거를 지우면 나중에 상한을 다시 논의할 때 재료가 없다.

개정 요지:

- 멘션 턴은 **스레드마다 하나, 스레드 간에는 무제한 병렬**.
- 같은 스레드는 여전히 직렬이다(`TurnRegistry` + 스케줄러 인플라이트).
- 계정 축은 **변경 없다** — 모든 턴이 lane 첫 계정부터 시작하고 한도·자격증명 실패에서만
  다음 계정으로 넘어간다. 따라서 *"병렬의 실제 상한은 계정 한도"* 라는 v1 의 관찰은 그대로
  유효하다.

## 8. 범위 밖

- **도는 턴에 새 메시지 전달.** 지금은 불가능하다. 프롬프트는 턴 시작 시 `readThread` 로 한 번
  동결되고(`mentionTurn.ts`), PTY 로 밀어 넣을 수도 없다 — 멘션 턴은 항상 `stdinFile` 을 쓰므로
  `acceptsPtyInput` 이 거짓이다(#369: stdin 이 일반 파일로 리다이렉트되면 PTY master 에 쓴
  바이트는 자식에게 도달하지 않는다). 같은 스레드의 후속 멘션은 현행대로 **다음 턴**이
  `lastFedSeq` 경계로 함께 본다 — 답을 잃지는 않는다.
- **workspace 디렉터리·claude 세션 파일·`sessions.json` 레코드의 영구 증가.** 스레드 수에
  비례해 늘지만 병렬화와 무관하다(병렬화는 스레드를 더 만들지 않고 더 빨리 처리할 뿐이다).
  v1 스펙이 이미 "workspace 정리는 v1 수동"으로 명시했다.
- **presence "막힘" 오표기.** 이 설계로 상당 부분 낫는다(턴 중에도 폴이 나가 30초 TTL 이
  만료되지 않는다) — 부수 효과이지 목표가 아니다.
- **동시 상한.** 두지 않기로 했다(§4-6). 필요해지면 그 절의 실측 숫자가 근거다.
- **대기 중 통지.** 스레드 간 병렬화로 대기 자체가 대부분 사라지므로 이번에는 다루지 않는다.
  같은 스레드의 후속 멘션은 여전히 무음이다.

# murmur 가 허브 자리에 선다 — 제안 · 승인 · 배달

> 상태: 설계 (2026-09-10, jaebin 승인 — "제안한 방식으로 진행하자")
> 그림 정본: [`hub-seat.html`](hub-seat.html) — 구조 비교도 · 승인 흐름도 · 협업 탭 목업이 붙은 판
> 선행 문서: [`desktop-collab.html`](desktop-collab.html) — 협업 탭(읽는 자리)
> 이 문서가 채우는 칸: 그 문서가 *"murmur 에서 제안을 만들고 결정하는 것은 범위 밖"* 이라고
> 적어 둔 바로 그 자리.

## 1. 지금과 무엇이 다른가

지금 murmur 는 avcs 를 **읽기만** 한다(`avcs/client.ts` 의 `fetchSince`·`waitForChange`),
투영해 남기는 것은 `lease` 하나다(#534). 저장소에 걸 수 있는 것은 **전역 avcs URL 한 칸**
(`projection_config`, 041·042) 과 채널의 `repo` 이름뿐이다. 그래서 제안을 보는 일은 avcshub
웹에서, 코드가 실제로 나가는 일은 GitHub 에서 일어난다 — 사람은 화면을 셋 연다.

```
지금    에이전트 ──push──▶ avcs-server ──sync──▶ avcshub ──승인→PR──▶ GitHub
                              │
                              └╌읽기만·lease╌▶ murmur ╌링크 열기╌▶ (avcshub 웹)

앞으로  에이전트 ──push──▶ ┌ murmur ─────────────────────────┐ ──PR 열기──▶ GitHub
                          │ avcs-server 내장 → 협업 탭 승인  │
                          │              → 배달 큐          │ ──objects+/integrate──▶ avcshub
                          └─────────────────────────────────┘
```

바뀌는 화살표는 둘이다. **avcshub 로 나가던 `sync` 가 murmur 안으로 들어오고, 사람이 웹으로
열던 링크가 협업 탭의 승인 버튼이 된다.** 에이전트가 `push` 하는 방식은 그대로다(같은 프로토콜) —
바뀌는 것은 그 push 를 누가 받느냐이고, 밖으로 나가는 길이 하나가 아니라 **저장소마다 붙이는
배달 대상 N개**가 된다는 것이다.

## 2. 빠진 것은 한 덩어리가 아니라 세 층

한 기능으로 묶으면 첫 릴리스가 나오지 않는다. 셋은 서로 다른 시점에 켤 수 있고 각각 따로 쓸모가 있다.

### 층 1 — 쓰기: 저장소를 가리키지 않고 갖는다

전역 URL 한 칸을 **`repo` 레코드**로 올린다(`id, slug, mode, base_url, …`). 채널은 그 id 를 가리킨다.

| 모드 | 뜻 |
|---|---|
| `linked` | 지금 그대로. 외부 avcs-server/avcshub 를 읽고 링크로 나간다 |
| `hosted` | murmur 안에서 `@izagood/avcs-server` 를 띄운다. 에이전트의 `origin` 이 murmur 가 된다 |

두 모드에서 **같은 화면·같은 제안 목록**이 선다. 다른 것은 쓰기가 되느냐뿐이다.
"링크를 걸지 않은 경우" 가 곧 `hosted` 다. 이 성질이 마이그레이션 계획을 대신한다 —
저장소를 하나씩 옮겨도 팀이 보는 자리는 바뀌지 않는다.

### 층 2 — 판정: 승인은 서명이다

승인 버튼을 누르면 **데스크탑이 리뷰어 키로 정규 문자열에 서명한다**:
`decision:<verdict>:<view>:<intentId>:<head>` (avcshub `packages/shared/src/proposal.ts` 의
`decisionMessage`). 다른 intent 나 다른 head 로 재생할 수 없다. 서버가 대신 서명하면
"승인했다" 가 사람에게 귀속되지 않는다.

그 다음은 프로토콜 그대로 `POST /integrate` 다(avcs `docs/26-hub-protocol.md` §6-2).
**판정 다섯 종은 이미 정해져 있다 — 새 상태 축을 만들지 않는다.**

| 판정 | 코드 | 뜻 | murmur 화면 |
|---|---|---|---|
| `advanced` | 200 | 랜딩했다. head 가 전진한다 | 배달 큐로 · 줄에 배달 칩 |
| `queued` | 202 | 다른 티켓 진행 중 — **같은 티켓으로 재시도** | "대기 중" · murmur 가 알아서 재시도 |
| `conflict` | 409 | 충돌. 수리 패킷을 함께 준다 | **결정 필요** — 목록 맨 위 · 인박스 배지 |
| `needs_evidence` | 428 | 요구된 검사의 증거가 없다 | "검증 대기" · 트리 해시를 그대로 |
| `rejected` | 422 | 정책이 거부했다 | 거부 사유를 제안 줄에 |

`ticketId` 가 멱등 키다 — 네트워크 재시도·에이전트 재시도·잡 재실행이 전부 같은 길로 온다.

- `hosted` 면 murmur 가 **그 큐를 직접 돈다**. 프로토콜상 `integration` 객체는 허브만 쓸 수 있고,
  그것이 곧 "허브 자리" 의 정의다.
- `linked` 면 murmur 는 판정하지 않고 **원격에 릴레이**한다.
- **승인 권한의 정본은 murmur 의 role 이 아니라 avcs 의 view 정책**(보호·required checks)이다.
  murmur 는 그것을 읽어 버튼을 흐리게 할 뿐이다 — 권한을 두 곳에 두면 반드시 갈라진다.

### 층 3 — 배달: 밖으로 나가는 것은 승인의 부작용이다

저장소마다 **배달 대상 N개**를 붙인다. 어댑터는 계약 하나를 지킨다:
*랜딩된 체크포인트 하나를 받아 바깥에 산출물 하나를 만든다.*

| 대상 | 하는 일 | 안전장치 |
|---|---|---|
| `github-pr` | 체크포인트 트리 materialize → git plumbing 으로 커밋 → 브랜치 push → PR | push 전 `ls-remote` 로 기준 tip 확인 · 평범한 refspec(`--force` 없음) |
| `git-push` | 같은 경로에서 PR 없이 브랜치로 | fast-forward 만 · 비-FF 는 git 이 거절하게 둔다 |
| `avcs-remote` | avcshub·다른 avcs-server 로 objects push + `/integrate` | 프로토콜 그대로 · 판정 5종을 다시 받는다 |

규율 셋:

1. **멱등키는 `(repo, checkpoint, target)`** — 몇 번을 재시도해도 PR 은 하나다.
2. **배달 실패가 승인을 되돌리지 않는다.** 승인은 남고 배달만 재시도 큐에 남는다.
   되돌리면 같은 사람이 같은 것을 두 번 승인하게 된다.
3. 결과는 제안 줄의 칩으로(`PR #124 열림` · `배달 실패 · 재시도 3회`). 알림은 이미 있는
   실패 통지(`message.fail`)와 인박스 배지를 쓴다.

`github-pr` 은 처음부터 짜지 않아도 된다 — avcshub `packages/api/src/integration/gitPort.ts` 에
이 경로가 이미 있고, `--force` 류 인자를 금지하는 테스트(`FORBIDDEN_GIT_ARGS`)까지 붙어 있다.

## 3. 도그푸딩 — murmur 는 네 서비스의 계측기다

`avcs` · `avcs-server` · `avcshub` · `murmur` 를 한 사람이 만든다. 그러면 murmur 를 쓰는 모든
순간이 나머지 셋의 테스트다. 그런데 **그 테스트 결과가 지금 아무 데도 안 남는다.**

병목은 발견이 아니라 **기록**이다. 오류는 매일 나온다 — avcs 훅이 느려서
`core.hooksPath=/dev/null` 로 우회하고, 기본 heap 으로 OOM 이 나서 `--max-old-space-size` 를
붙이고, `avcs commit` 이 트리 전체 드리프트를 잡는다. 셋 다 avcs 의 결함 후보인데 어느
저장소에도 없다. 에이전트 메모리와 스레드 스크롤에만 있다.

그러니 만들 것은 "버그를 더 잘 찾는 법" 이 아니라 **발견을 한 동작으로 저장소에 넣는 길**이다.

| # | 장치 | 왜 그 모양인가 |
|---|---|---|
| 1 | 결함은 **대상 저장소의 intent** (`defect.file(repo, …)`) | 이슈 트래커를 새로 만들면 축이 둘이 되고, 고치는 operation 이 붙을 자리가 없어진다. intent 로 열면 고침·승인·배달이 이미 있는 길을 탄다 |
| 2 | 증거는 사람이 다시 쓰지 않는다 | 턴에 이미 명령·종료 코드·스택·도구 인자가 있다. 실패 카드에 `[avcs 에 결함 열기]`, 누르면 그 재료가 `evidence` 로 따라간다. 재현 절차를 손으로 쓰게 하면 아무도 안 연다 |
| 3 | 버전 네 쌍을 결함에 박는다 | 넷이 동시에 움직이므로 "어느 조합에서 났나" 가 결함의 절반이다. `GET /version`(능력 협상)은 프로토콜에 이미 있다 |
| 4 | 저장소 라우팅은 러너가 제안한다 | MCP 호출 실패→`avcs`, `/sync`·`/integrate` 4xx·5xx→`avcs-server`, 대시보드→`avcshub`, 화면·턴→`murmur`. 매번 "어느 저장소지" 를 묻게 하면 아무도 안 연다 |
| 5 | 적합성 스위트를 murmur CI 가 돈다 | `hosted` 가 avcs-server 를 내장하는 순간, avcs 의 `npm run conformance` 를 그 내장 서버에 물릴 수 있다. avcs-server 는 "스위트 통과가 곧 지원의 정의" 라고 선언해 뒀으니 판정 기준이 이미 있다 — murmur 가 avcs-server 의 회귀 탐지기가 된다 |
| 6 | 버전을 고정하지 말고 따라간다 | 개발 인스턴스는 avcs·avcs-server 의 최신을 물고, 배포 인스턴스는 고정 버전을 문다. 벌어지면 도그푸딩은 몇 달 전 소프트웨어로 이미 고쳐진 버그를 찾는 일이 된다 |

**루프는 배달이 아니라 알림에서 닫힌다.** 결함 intent → 고침 제안 → 승인 → 배달 → 릴리스 →
**"v0.1.128 에 들어갔다" 한 줄이 결함을 연 그 스레드로 돌아온다**(`turn.wake` 로 이미 가능).
이 한 칸이 없으면 사람이 기억하고 있어야 하는데, 기억하지 않는다.

지표는 하나만 본다: **발견된 시각 → 그 고침이 내 손에 도착한 시각**. 대시보드는 만들지 않는다.

### 자기를 고치는 저장소의 조심 둘

- **murmur 의 배달은 자동 머지 금지.** main 머지가 곧 릴리스라(6~12분) 지금 쓰고 있는 앱이 바뀐다.
  되돌릴 수 없는 것은 권한이 있어도 사람 판단으로 남긴다.
- **murmur 저장소는 두 곳에 둔다.** `hosted` 로 자기 소스를 담으면 murmur 가 죽었을 때 그 소스에
  갈 수 없다. `hosted` + GitHub 미러를 항상 함께 건다 — 배달 대상이 N개라는 설계가 여기서 값을 한다.

## 4. 순서

| # | 무엇 | 선행 |
|---|---|---|
| **00** | **의존성 따라잡기** — `@izagood/avcs` 0.45→0.51, `@izagood/avcs-server` 0.3→0.7. 0단계가 요구하는 `GET /reduced` 가 0.7.0 에 있다. 올리다 나오는 깨짐이 첫 도그푸딩 수확이다 | — |
| 0 | **협업 탭 읽기 자리** — [`desktop-collab.html`](desktop-collab.html) 1~2단계(제안 트리 + `GET /reduced`). 승인 버튼을 붙일 자리가 없으면 아무것도 시작되지 않는다 | 00 |
| 1 | **`repo` 레코드 + `hosted` 모드** — 전역 URL 을 테이블로, `@izagood/avcs-server` 를 서버 안에서. `linked` 는 손대지 않는다 | 00 |
| 2 | **승인 = 서명된 decision → `/integrate`** — hosted 직접 / linked 릴레이 + 판정 5종 화면 | 0, 1 |
| 3 | **배달 어댑터 `github-pr`** + 큐·재시도·멱등 | 2 |
| 4 | 나머지 어댑터(`git-push`·`avcs-remote`) · 릴리스 연동 | 3 |
| D | **도그푸딩 장치** — 1·2·3(결함 intent·증거·버전)은 1단계 뒤 바로, 5(적합성 CI)는 1과 함께, 루프 닫기 알림은 3 뒤 | 위 표 참조 |

1~3 이 끝나면 한 바퀴가 돈다: **murmur 에서 작업 → 제안이 뜸 → 승인 → GitHub PR.**

## 5. 아직 사람이 정하지 않은 셋

1. **개인키 자리** — 데스크탑에서 사람 키로 서명(권장, "push 는 서명으로만 간다") vs 서버
   서비스 키로 대리 서명(쉬운 대신 "누가 승인했나" 가 murmur DB 의 주장으로만 남는다).
2. **`hosted` 의 무게** — murmur 서버 디스크가 코드 정본을 담는다(백업·gc·용량이 murmur 책임).
   감당할지, 아니면 `hosted` 를 내부 팀 저장소로만 좁힐지.
3. **GitHub 인증 주체** — GitHub App(작성자가 앱, 권한이 저장소 단위로 명확) vs PAT(지금 방식,
   작성자가 토큰 주인이라 "누가 냈나" 가 흐려진다).

2·3 단계에 걸리는 판단이므로 00~1 단계는 이것 없이 진행한다.

## 6. 근거

- **murmur** — `packages/server/src/avcs/{client,projection,supervisor}.ts`(읽기 전용, `lease` 만
  투영), `projection_config`(041·042), `settings/ProjectionUrl.tsx`.
  `packages/server` 는 이미 `@izagood/avcs`·`@izagood/avcs-server` 를 의존성으로 갖고 있다.
- **협업 탭** — [`desktop-collab.html`](desktop-collab.html): 레일 다섯째 칸 · 줄이 말하는 넷 ·
  막는 순 정렬 · "잠금은 그리지 않는다".
- **avcs 프로토콜** — `docs/26-hub-protocol.md` §6: `POST /finalize`(head CAS),
  `POST /integrate`(판정 5종, `ticketId` 멱등), `GET /events`. `integration` 객체는 허브만 쓴다.
- **avcshub** — `packages/api/src/integration/gitPort.ts`·`gitProjection.ts`(승인→git push),
  `packages/shared/src/proposal.ts`(`decisionMessage`, 제안 트리 조립).

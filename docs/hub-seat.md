# harkroom 가 허브 자리에 선다 — 제안 · 승인 · 배달

> 상태: 설계 (2026-09-10, jaebin 승인 — "제안한 방식으로 진행하자")
> 그림 정본: [`hub-seat.html`](hub-seat.html) — 구조 비교도 · 승인 흐름도 · 협업 탭 목업이 붙은 판
> 선행 문서: [`desktop-collab.html`](desktop-collab.html) — 협업 탭(읽는 자리)
> 이 문서가 채우는 칸: 그 문서가 *"harkroom 에서 제안을 만들고 결정하는 것은 범위 밖"* 이라고
> 적어 둔 바로 그 자리.

## 0. 무엇을 없애려는 것인가 (2026-09-10, jaebin)

**harkroom 를 파일 보관소로 만들려는 것이 아니다.** 목표는 하나다 —
**여러 작업이 동시에 돌 때 생기는 라인 충돌의 낭비를 없애는 것.**

지금 모양에서 그 낭비가 어디서 나는지는 분명하다: 에이전트 넷이 동시에 일하면 브랜치가 넷
생기고, 넷이 각자 rebase 하고, 같은 줄을 만진 둘은 사람이 텍스트로 푼다. 그 텍스트 충돌은
**정보가 없는 충돌**이다 — 무엇을 하려던 두 변경인지는 diff 에 안 적혀 있고, 그래서 매번
사람이 다시 읽어 추론한다.

avcs 는 그 자리를 op 그래프로 바꾼다. 무엇을 하려 했는지(`intent`·`declaredPurpose`)와 무엇을
건드리는지(`effects`·`target`)가 객체에 있으므로, 겹침은 **줄이 아니라 대상(entity)** 에서
판정되고 결정은 `decision` 으로 **남아 다음 번에 재사용된다**. harkroom 가 하는 일은 그 판정을
사람이 보고 고르는 자리를 주는 것이다 — 그것이 이 문서 전체의 목적이고, 아래 설계는 전부
그 목적의 수단이다.

따라서 **성공의 기준도 PR 개수가 아니다**: 같은 기간에 사람이 텍스트 충돌을 손으로 푼 횟수가
줄어야 한다.

## 1. 지금과 무엇이 다른가

지금 harkroom 는 avcs 를 **읽기만** 한다(`avcs/client.ts` 의 `fetchSince`·`waitForChange`),
투영해 남기는 것은 `lease` 하나다(#534). 저장소에 걸 수 있는 것은 **전역 avcs URL 한 칸**
(`projection_config`, 041·042) 과 채널의 `repo` 이름뿐이다. 그래서 제안을 보는 일은 avcshub
웹에서, 코드가 실제로 나가는 일은 GitHub 에서 일어난다 — 사람은 화면을 셋 연다.

```
지금    에이전트 ──push──▶ avcs-server ──sync──▶ avcshub ──승인→PR──▶ GitHub
                              │
                              └╌읽기만·lease╌▶ harkroom ╌링크 열기╌▶ (avcshub 웹)

앞으로  에이전트 ──push──▶ ┌ harkroom ───────────────────────┐ ──PR 열기──▶ GitHub
                          │ avcs-server 내장 → 협업 탭 승인  │
                          │              → 배달 큐          │ ──objects+/integrate──▶ avcshub
                          └─────────────────────────────────┘
```

바뀌는 화살표는 둘이다. **avcshub 로 나가던 `sync` 가 harkroom 안으로 들어오고, 사람이 웹으로
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
| `hosted` | harkroom 안에서 `@izagood/avcs-server` 를 띄운다. 에이전트의 `origin` 이 harkroom 가 된다 |

두 모드에서 **같은 화면·같은 제안 목록**이 선다. 다른 것은 쓰기가 되느냐뿐이다.
"링크를 걸지 않은 경우" 가 곧 `hosted` 다. 이 성질이 마이그레이션 계획을 대신한다 —
저장소를 하나씩 옮겨도 팀이 보는 자리는 바뀌지 않는다.

### 층 2 — 판정: 승인은 서명이다

승인 버튼을 누르면 **harkroom 서버가 자기 키로** 정규 문자열에 서명한다:
`decision:<verdict>:<view>:<intentId>:<head>` (avcshub `packages/shared/src/proposal.ts` 의
`decisionMessage`). 다른 intent 나 다른 head 로 재생할 수 없다.

**왜 사람 키가 아니라 서버 키인가**(2026-09-10 결정, jaebin). 사람 키로 서명하면 개인키를 쥔
클라이언트에서만 승인이 된다 — 데스크탑은 되지만 **모바일·웹 앱에서는 영영 안 된다.** 승인은
"어디서든 할 수 있어야 하는 일" 이므로, 확장을 막는 쪽을 버렸다.

**그래서 무엇을 잃고 무엇으로 대신하나.** 잃는 것은 *암호학적 귀속* 하나다 — 서명은 "harkroom 가
보냈다" 까지만 증명하고 "jaebin 이 눌렀다" 는 증명하지 않는다. 대신 셋으로 받친다:
`decision.decidedBy` 에 **사람 actor 를 그대로 적고**(avcs `Decision` 의 필드다, 전송 서명과 별개다),
harkroom 의 감사 기록(`recordAudit`)에 누가 눌렀는지 남기고, 승인 버튼은 harkroom 로그인 뒤에만 선다.
즉 **신뢰의 뿌리가 개인키에서 harkroom 인증으로 옮겨간다** — harkroom 서버를 장악한 자는 아무 이름으로나
승인할 수 있다는 뜻이고, 그것이 이 선택의 값이다. 서버 키는 avcs 멤버십의 한 키로 등록한다
(`AVCS_SERVER_GATED=1` 의 `member:<keyId>`).

그 다음은 프로토콜 그대로 `POST /integrate` 다(avcs `docs/26-hub-protocol.md` §6-2).
**판정 다섯 종은 이미 정해져 있다 — 새 상태 축을 만들지 않는다.**

| 판정 | 코드 | 뜻 | harkroom 화면 |
|---|---|---|---|
| `advanced` | 200 | 랜딩했다. head 가 전진한다 | 배달 큐로 · 줄에 배달 칩 |
| `queued` | 202 | 다른 티켓 진행 중 — **같은 티켓으로 재시도** | "대기 중" · harkroom 가 알아서 재시도 |
| `conflict` | 409 | 충돌. 수리 패킷을 함께 준다 | **결정 필요** — 목록 맨 위 · 인박스 배지 |
| `needs_evidence` | 428 | 요구된 검사의 증거가 없다 | "검증 대기" · 트리 해시를 그대로 |
| `rejected` | 422 | 정책이 거부했다 | 거부 사유를 제안 줄에 |

`ticketId` 가 멱등 키다 — 네트워크 재시도·에이전트 재시도·잡 재실행이 전부 같은 길로 온다.

- `hosted` 면 harkroom 가 **그 큐를 직접 돈다**. 프로토콜상 `integration` 객체는 허브만 쓸 수 있고,
  그것이 곧 "허브 자리" 의 정의다.
- `linked` 면 harkroom 는 판정하지 않고 **원격에 릴레이**한다.
- **승인 권한의 정본은 harkroom 의 role 이 아니라 avcs 의 view 정책**(보호·required checks)이다.
  harkroom 는 그것을 읽어 버튼을 흐리게 할 뿐이다 — 권한을 두 곳에 두면 반드시 갈라진다.

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

**미러는 원격지면 무엇이든 되고, 동시에 여럿이어도 된다.** 대상이 목록이라는 것이 그 뜻이다 —
GitHub 와 avcshub 를 함께 걸면 같은 체크포인트가 양쪽으로 나간다(멱등키가 대상별이므로 서로
간섭하지 않는다). `hosted` 저장소에는 **미러를 최소 하나 상시로** 건다: harkroom 디스크가 사라져도
파일은 남고, 잃는 것이 제안 그래프로 한정된다.

### 미러는 한 방향이다 — 이것을 어기면 §0 이 무너진다

되돌아오는 길을 열면(사람이 GitHub 에 직접 커밋하고 그것을 다시 받아오면) **라인 충돌이 그
경계에서 되살아난다.** avcs 가 없앤 것은 "줄로 판정하는 일" 인데, git 쪽에서 만들어진 변경은
op 이 아니라 diff 로 도착하므로 그 판정을 다시 텍스트로 해야 한다.

그래서 규율은 하나다: **`hosted` 저장소의 쓰기는 avcs 를 통해서만 들어온다.** 바깥에서 들어온
변경이 있으면 `avcs import`(git 히스토리 → op) 를 **한 번** 거쳐 op 으로 바꾼 뒤에 다루고,
그 경로를 상시로 열어 두지 않는다. 미러 쪽 저장소는 사람이 직접 커밋하지 않는 곳으로 둔다.

## 3. 도그푸딩 — harkroom 는 네 서비스의 계측기다

`avcs` · `avcs-server` · `avcshub` · `harkroom` 을 한 사람이 만든다. 그러면 harkroom 를 쓰는 모든
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
| 4 | 저장소 라우팅은 러너가 제안한다 | MCP 호출 실패→`avcs`, `/sync`·`/integrate` 4xx·5xx→`avcs-server`, 대시보드→`avcshub`, 화면·턴→`harkroom`. 매번 "어느 저장소지" 를 묻게 하면 아무도 안 연다 |
| 5 | 적합성 스위트를 harkroom CI 가 돈다 | `hosted` 가 avcs-server 를 내장하는 순간, avcs 의 `npm run conformance` 를 그 내장 서버에 물릴 수 있다. avcs-server 는 "스위트 통과가 곧 지원의 정의" 라고 선언해 뒀으니 판정 기준이 이미 있다 — harkroom 가 avcs-server 의 회귀 탐지기가 된다 |
| 6 | 버전을 고정하지 말고 따라간다 | 개발 인스턴스는 avcs·avcs-server 의 최신을 물고, 배포 인스턴스는 고정 버전을 문다. 벌어지면 도그푸딩은 몇 달 전 소프트웨어로 이미 고쳐진 버그를 찾는 일이 된다 |

**루프는 배달이 아니라 알림에서 닫힌다.** 결함 intent → 고침 제안 → 승인 → 배달 → 릴리스 →
**"v0.1.128 에 들어갔다" 한 줄이 결함을 연 그 스레드로 돌아온다**(`turn.wake` 로 이미 가능).
이 한 칸이 없으면 사람이 기억하고 있어야 하는데, 기억하지 않는다.

지표는 하나만 본다: **발견된 시각 → 그 고침이 내 손에 도착한 시각**. 대시보드는 만들지 않는다.

### 자기를 고치는 저장소의 조심 둘

- **harkroom 의 배달은 자동 머지 금지.** main 머지가 곧 릴리스라(6~12분) 지금 쓰고 있는 앱이 바뀐다.
  되돌릴 수 없는 것은 권한이 있어도 사람 판단으로 남긴다.
- **harkroom 저장소는 두 곳에 둔다.** `hosted` 로 자기 소스를 담으면 harkroom 가 죽었을 때 그 소스에
  갈 수 없다. `hosted` + GitHub 미러를 항상 함께 건다 — 배달 대상이 N개라는 설계가 여기서 값을 한다.

## 4. 순서

| # | 무엇 | 선행 |
|---|---|---|
| **00** | **의존성 따라잡기** — `@izagood/avcs` 0.45→0.51, `@izagood/avcs-server` 0.3→0.7. 0단계가 요구하는 `GET /reduced` 가 0.7.0 에 있다. 올리다 나오는 깨짐이 첫 도그푸딩 수확이다 | — |
| 0 | **협업 탭 읽기 자리** — [`desktop-collab.html`](desktop-collab.html) 1~2단계(제안 트리 + `GET /reduced`). 승인 버튼을 붙일 자리가 없으면 아무것도 시작되지 않는다 | 00 |
| 1 | **`repo` 레코드 + `hosted` 모드** — 전역 URL 을 테이블로, `@izagood/avcs-server` 를 서버 안에서. `linked` 는 손대지 않는다 | 00 |
| 2 | **승인 = 서명된 decision → `/integrate`** — hosted 직접 / linked 릴레이 + 판정 5종 화면 | 0, 1 |
| 3 | **배달 어댑터 `github-pr`** + 큐·재시도·멱등. **GitHub App 등록·private key 보관이 이 단계의 선행이다**(§5 결정 3) | 2 |
| 4 | 나머지 어댑터(`git-push`·`avcs-remote`) · 릴리스 연동 | 3 |
| D | **도그푸딩 장치** — 1·2·3(결함 intent·증거·버전)은 1단계 뒤 바로, 5(적합성 CI)는 1과 함께, 루프 닫기 알림은 3 뒤 | 위 표 참조 |

1~3 이 끝나면 한 바퀴가 돈다: **harkroom 에서 작업 → 제안이 뜸 → 승인 → GitHub PR.**

## 5. 정해진 셋 (2026-09-10, jaebin)

| # | 결정 | 왜 |
|---|---|---|
| 1 | **서버 키로 서명한다** | 사람 키는 개인키를 쥔 클라이언트에서만 승인이 되어 **모바일·웹 앱으로 확장할 길이 막힌다.** 잃는 암호학적 귀속은 `decision.decidedBy` + 감사 기록 + harkroom 로그인으로 받친다(§2 층 2) |
| 2 | **`hosted` + 미러 상시** | harkroom 는 파일 보관소가 아니다(§0). 디스크가 사라져도 파일은 미러에 남고, 잃는 것이 제안 그래프로 한정된다. 미러는 GitHub·avcshub 어디든 되고 여럿이어도 된다 |
| 3 | **GitHub App** | PR 작성자가 `murmur[bot]` 이라 "봇이 냈다" 가 분명하고, 권한이 저장소 단위이며 사람의 재직·비밀번호와 수명이 분리된다. 지금처럼 사람 PAT 로 내면 작성자가 사람으로 보여 누가 냈는지가 흐려진다 |

**남은 값**: 3번은 앱 등록·private key 보관·installation 토큰 교환이 필요하다(반나절). 배달
어댑터에서 인증은 "토큰 하나 얻기" 함수 하나이므로, 그 구현이 늦어지면 그 함수만 임시로
fine-grained PAT 를 물려 두고 나머지를 먼저 굴릴 수 있다.

## 6. 근거

- **harkroom** — `packages/server/src/avcs/{client,projection,supervisor}.ts`(읽기 전용, `lease` 만
  투영), `projection_config`(041·042), `settings/ProjectionUrl.tsx`.
  `packages/server` 는 이미 `@izagood/avcs`·`@izagood/avcs-server` 를 의존성으로 갖고 있다.
- **협업 탭** — [`desktop-collab.html`](desktop-collab.html): 레일 다섯째 칸 · 줄이 말하는 넷 ·
  막는 순 정렬 · "잠금은 그리지 않는다".
- **avcs 프로토콜** — `docs/26-hub-protocol.md` §6: `POST /finalize`(head CAS),
  `POST /integrate`(판정 5종, `ticketId` 멱등), `GET /events`. `integration` 객체는 허브만 쓴다.
- **avcshub** — `packages/api/src/integration/gitPort.ts`·`gitProjection.ts`(승인→git push),
  `packages/shared/src/proposal.ts`(`decisionMessage`, 제안 트리 조립).

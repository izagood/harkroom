# murmur — 설계 문서

- 날짜: 2026-08-31
- 상태: 초안
- 관련: avcs self-hosted 프로토콜 스펙 (별도 공개 예정, 이 설계의 외부 계약)

## 1. 정의

**murmur**는 사람과 에이전트가 채널에서 함께 일하는 오픈소스 워크스페이스다.
코드 협업 기층이 git이 아니라 **avcs**이며, 셀프호스트 시 docker compose 하나로 뜬다.

- MVP 핵심 경험: **채팅 워크스페이스** — 채널/스레드/DM이 1차 표면이고, avcs
  이벤트(작업)가 그 안으로 흘러든다
- 에이전트 참여: **외부 접속형** — 서버는 에이전트 런타임을 모르고, 에이전트는
  프로토콜(MCP/REST)로 접속한다. 상주형은 v2 검토
- 존재 이유: 동시 다중 에이전트 협업에서 git이 주지 못하는 것 — 실시간 작업
  점유(lease), 구조화된 의도(intent), 충돌 해결 기록(decision) — 을 avcs가 주고,
  murmur는 그것을 대화 UI로 드러낸다

## 2. 아키텍처

프로세스 3개, 계약으로 결합:

```
┌─ desktop app (Tauri 2 + React) ─────────────┐
│  채널/스레드/DM UI · WS 실시간 · 작업 현황판 │
└──────────────┬───────────────────────────────┘
               │ REST + WebSocket
┌─ workspace-server (Node, Fastify) ───────────┐
│  REST(채널·스레드·메시지·멤버십)             │
│  WebSocket(알림 푸시) · MCP(에이전트 표면)   │
│  avcs 이벤트 구독 → 채널 시스템 메시지 투영  │
│  PostgreSQL(채팅·멤버십·투영 커서)           │
└──────────────┬───────────────────────────────┘
               │ avcs self-hosted 프로토콜 (HTTP)
┌─ avcs server (별도 프로세스) ────────────────┐
│  공개 프로토콜 스펙 구현체 · 멀티 repo        │
└───────────────────────────────────────────────┘
```

핵심 결정:

1. **avcs 서버를 임베딩하지 않는다.** workspace-server는 공개 프로토콜 스펙을
   구현한 avcs 서버의 **클라이언트**다. 이벤트 구독과 메타 조회만 하고 오브젝트
   쓰기 경로에 끼지 않는다("관찰자 서버"). avcs 서버가 재시작·교체되어도 채팅
   층은 영향받지 않는다.
2. **프로토콜 스펙 버전을 명시적으로 핀**한다. 계약 어긋남은 버전 핀 +
   contract test로 막는다.
3. **DB = PostgreSQL.** 채팅·멤버십·투영 커서·inbox.
4. **클라이언트 = 데스크탑 앱 (Tauri 2 + React).** 웹 UI는 MVP 제외.
5. 스펙 구현 서버가 준비되기 전 개발 대역으로 `avcs serve`를 사용하고, 스펙이
   확정되면 교체한다.

### monorepo 구성 (pnpm, Apache-2.0)

```
murmur/
  packages/server     # Fastify: REST + WS + MCP + avcs 이벤트 투영
  packages/desktop    # Tauri 2 + React
  packages/shared     # 프로토콜 타입·스키마 (server/desktop 공유)
```

MVP 제외: cli, 모바일, 웹 UI, 상주 에이전트 러너.

## 3. 데이터 모델과 avcs 투영

**전제: 서버 인스턴스 1개 = 워크스페이스 1개.**

### PostgreSQL 스키마 (핵심 6테이블)

| 테이블 | 핵심 컬럼 | 비고 |
|---|---|---|
| `account` | handle, display_name, `kind: human\|agent` | 사람과 에이전트가 같은 테이블 |
| `account_key` | account_id, ed25519 public key (SPKI PEM) | 주 용도는 인증이 아니라 **actor 매핑**(아래) |
| `channel` | name, topic, `kind: standard\|dm`, `repo`(nullable) | `repo` 설정 시 avcs repo 바인딩 채널 |
| `message` | channel_id, thread_root_id(자기참조), author_id, body, `kind: user\|system`, meta(jsonb), signature(nullable), created_at | 스레드 = 루트 메시지 앵커 방식 |
| `work_thread` | (repo, intent_oid) → thread_root_message_id, UNIQUE | intent 하나 = 작업 스레드 하나 |
| `inbox` | account_id, message_id, `reason: mention\|thread_reply\|dm`, read_at | 사람은 WS 배지, 에이전트는 MCP poll |

보조 테이블: `projection_cursor(repo, last_log_index)`,
`active_lease(repo, path, actor, expires_at)`.

메시지 저자성: 인증된 identity(세션/PAT) 귀속이 기본. `signature`(ed25519)는
**선택** — MCP 도구 호출로 발화하는 에이전트에게 메시지별 클라이언트 서명은 진입
마찰이 커서 MVP에서 필수화하지 않는다. v2에서 서명 헬퍼와 함께 재검토.

### avcs 이벤트 투영 규칙

repo 바인딩 채널마다 투영 워커가 avcs 서버의 object-log를 커서 기반으로
구독(`/events` long-poll로 깨어나 `/sync?since=`로 당김)한다.

| avcs 오브젝트 | 투영 결과 |
|---|---|
| `intent` 생성 | 채널 시스템 메시지 + 작업 스레드 자동 개설 (`work_thread` 등록) — 단 `work.link` 선점 시 생략 |
| `operation` push | 해당 intent의 작업 스레드에 요약 시스템 메시지 — **sync 배치 단위 병합** (op당 메시지 금지) |
| `decision` / `evidence` | 해당 intent의 작업 스레드에 기록 |
| `integration` / `checkpoint` / `release` / finalize | 채널 레벨 공지 |
| `lease` | 메시지가 아니라 **상태** — `active_lease` 갱신 → "지금 누가 어디 작업 중" 실시간 현황판 |

- **멱등성**: at-least-once + dedupe. 시스템 메시지에 `(repo, oid)` UNIQUE 제약,
  커서 전진은 메시지 삽입과 같은 트랜잭션.
- **actor 매핑**: avcs 오브젝트의 서명 키를 `account_key`로 역참조해 시스템
  메시지에 워크스페이스 계정을 저자로 붙인다. 미등록 키는 "외부 작업자"로 표시.
- **사람→avcs 방향은 MVP에 없음**: 작업 스레드의 사람 댓글은 채팅 DB에만 남는다.
  채팅은 논의 층, avcs는 작업 층.

### avcs 사용 경계 (원칙: avcs 오브젝트는 작업의 산물이지 대화의 기록이 아니다)

| 요청 유형 | 기록 위치 |
|---|---|
| 읽기 전용 (요약·질문 답변·설명·리뷰 의견) | 채팅에만. avcs 오브젝트 생성 없음 |
| 저장소 상태 변경 (코드 수정·파일 추가/삭제·통합·릴리스) | avcs 필수 (intent → session → operations) |
| 회색지대 (조사·분석) | 산출물이 repo에 들어가면 avcs, 채팅 답변으로 끝나면 채팅만 |

강제는 avcs 스스로 한다(intent/session 없이 operation push 불가). murmur의 역할은
반대쪽 — MCP `workspace.guide`에 이 규칙을 명시해 읽기 전용 요청에 intent를
만드는 과잉을 막는다.

### 스레드 분열 방지 — `work.link`

채팅 스레드에서 촉발된 작업은 에이전트가 intent 생성 직후 MCP 도구
`work.link(intent_oid, thread)`를 호출해 **기존 대화 스레드를 작업 스레드로
승격**시킨다(`work_thread`가 기존 스레드 루트를 가리킴). `work.link`가 안 불린
intent(자발·외부 작업)만 투영 규칙대로 새 작업 스레드를 자동 개설한다(fallback).

## 4. 실시간 층·에이전트 표면·인증

### 데스크탑 ↔ 서버: "REST로 쓰고, WS로 깨어나고, REST로 따라잡기"

- 쓰기는 전부 REST (`POST /channels/:id/messages`, idempotency-key 헤더). WS로 쓰지 않는다.
- WebSocket(`/ws`)은 알림 전용 푸시: `message.created/updated/deleted`,
  `inbox.updated`, `lease.changed`, `presence.changed`, `presence.snapshot`.
- 수정·삭제 권한은 비대칭이다. **수정은 작성자 본인만** — 남의 말을 고치는 것은 되돌릴 수 없는
  왜곡이라 admin 에게도 열지 않는다. **삭제는 작성자 또는 admin** — 원문을 왜곡하지 않고 가리는
  일이라 운영에 필요하다. `kind='system'` 메시지는 avcs 투영의 산물이므로 사람이 고칠 수 없다.
  삭제는 `deleted_at` 소프트 삭제이고 `listMessages` 가 걸러낸다.
- 재연결 시 `GET .../messages?since=`로 리컨실. WS는 진실의 원천이 아니다.
- 히스토리 커서는 양방향이다. `since=`(전방)는 리컨실용이고, `before=`(역방향)는 최신 창 밖으로
  밀려난 과거로 돌아가는 경로다. 둘은 반대 방향이라 **함께 보내면 400**이다. 응답의 `hasMore` 는
  "이 페이지보다 오래된 것이 남았는가"이며, 클라이언트의 추가 로드 표시가 이 값만 본다.
- 멘션·DM·답글은 **창이 포커스를 잃은 동안에만** OS 알림으로 알린다(보고 있는 창에는 배지가
  이미 그 일을 한다). 항목당 한 번만 알리고, 앱을 열 때 쌓여 있던 미읽음은 지난 일로 보고
  알리지 않는다. 전송은 `Notifier` 인터페이스 뒤에 있고 Tauri 알림 플러그인이 없는 환경
  (브라우저 dev)에서는 조용히 넘어간다 — 판단 로직만 테스트 대상이다.
- 멘션은 한 번 부르면 그 대화에서 **고정**된다. 보낸 본문에 있던 handle 이 작성창 위 칩으로
  남고 다음 메시지부터 본문 앞에 자동으로 붙는다 — 사람이 매번 `@` 를 다시 치는 것을 잊으면
  에이전트는 깨어나지 않는다. 여러 명을 불러도 전부 유지되고, 칩의 `×` 로 하나씩 뗀다. 이미
  본문이 부르고 있는 handle 은 다시 붙이지 않으며, 계정이 사라지면 고정에서도 빠진다. 고정은
  **대화 단위**다(채널 / 스레드) — 앞 채널에서 부르던 에이전트가 따라가면 엉뚱한 곳에서
  깨어난다. 접두는 실제 본문에 들어간다: 별도 메타데이터로 보내면 서버의 알림 판정과 규칙이
  두 벌이 되어 갈라진다.
- presence: WS 연결 + 하트비트 기준 online/offline. 단일 워크스페이스라 구독
  스코핑 없이 브로드캐스트(MVP 규모 충분).

### 에이전트 MCP 표면 (Streamable HTTP `/mcp`) — 도구 9개

| 도구 | 역할 |
|---|---|
| `workspace.guide` | 규칙 문서(avcs 사용 경계 포함) |
| `channel.list` / `message.read` / `message.search` | 읽기(스레드·커서 기반) |
| `message.post` | 채널/스레드 발화 |
| `inbox.poll` | 멘션·DM·답글 커서 poll, **long-poll 지원** — 에이전트가 물고 대기하다 멘션에 깨어남 |
| `inbox.read` | inbox 항목 읽음 처리(자기 inbox 한정, entry id). **이것이 없으면 MCP 단독으로 에이전트 루프가 성립하지 않는다** — 미읽음을 소비할 수 없어 같은 멘션에 영원히 반복 응답한다 |
| `work.link` | intent ↔ 스레드 승격 |
| `account.me` | 자기 identity 확인 |

에이전트는 murmur MCP(대화) + avcs MCP(작업) 두 개를 물고 들어온다. murmur는
에이전트 런타임을 모른다.

**표면이 있다는 것과 에이전트가 온다는 것은 다르다.** MCP 서버로 등록하면(예:
`claude mcp add --transport http murmur .../mcp --header "Authorization: Bearer <PAT>"`)
에이전트가 murmur의 도구를 쓸 수 있지만, 그것은 **사람이 프롬프트할 때만** 움직인다.
`@handle` 을 불렀을 때 찾아오게 하려면 `inbox.poll` 을 물고 대기하는 프로세스가 필요하다 —
`packages/agent` 가 그 참조 구현이며, 사용자가 직접 실행하는 외부 프로세스다(§6의 "상주형
에이전트(서버 호스팅)" 제외와 모순되지 않는다: 서버는 여전히 에이전트 런타임을 모른다).

### 인증

- 사람: first-run admin 생성 → 초대 링크 가입. handle + 비밀번호(Argon2), 세션은
  불투명 토큰. 데스크탑 앱은 이 토큰을 `TokenStore` 인터페이스 뒤에 두고 현재는
  localStorage에 평문 보관한다 — Tauri 2에 공식 키체인 플러그인이 없어 MVP에서
  내린 결정이며, 셀프호스트 개인 기기를 전제로 한다. OS 키체인 구현은 이 인터페이스만
  갈아끼우면 되도록 격리해 두었다.
- WS(`/ws`)는 **단기 1회용 티켓**으로 인증한다. 브라우저 `WebSocket` 생성자가 헤더를 실을 수
  없어 자격증명이 URL 로 갈 수밖에 없고, URL 은 앞단 프록시의 액세스 로그에 남는다. 그래서
  URL 에는 장기 토큰 대신 `POST /ws-ticket`(Authorization 헤더로 인증)에서 받은 티켓을 싣는다 —
  TTL 30초, 1회용이라 로그에 남은 값은 재사용할 수 없다. 티켓 저장은 인메모리다(§3 의 "서버
  인스턴스 1개 = 워크스페이스 1개" 전제, 재시작 시 클라이언트가 다시 받으면 된다).
  클라이언트는 재연결 시도마다 티켓을 새로 받는다.
- **소켓 수명은 자격증명에 묶인다.** 티켓이 계정과 함께 발급 자격증명의 해시를 운반하고, 서버가
  60초마다 그 자격증명이 아직 사는지 확인해 죽었으면 소켓을 `4401` 로 닫는다. 연결 시점에만
  검증하면 만료 직전에 열린 소켓이 만료 후에도 이벤트를 계속 받는다.
- **Origin 허용 목록**(`CORS_ORIGINS`, 쉼표 구분)은 CORS 와 WS 핸드셰이크에 함께 적용된다.
  WebSocket 핸드셰이크는 CORS 의 보호를 받지 않으므로 별도 검사가 필요하다. 미설정이 기본이며
  그때는 모든 origin 을 반영한다 — 셀프호스트가 어떤 origin 으로 뜰지 서버가 알 수 없기 때문이다.
  좁힐 때 넣을 값은 실측했다: macOS 릴리스 빌드는 `tauri://localhost`, `tauri dev` 는 Vite dev
  서버 origin(`http://localhost:5173`).
  **Origin 헤더가 없는 요청은 허용한다** — Origin 은 브라우저만 보내고, 에이전트·CLI 는 보내지
  않는다. 부재를 거부하면 사람이 아닌 참여자가 전부 끊긴다.
- 에이전트: admin이 발급하는 Bearer PAT(account 귀속). `DELETE /accounts/:id/pats/:label`로
  폐기한다 — 라벨 단위이고, `pat.label`에 유일성이 없어 같은 라벨의 토큰이 여러 개면 전부
  폐기된다(폐기에서는 하나 남기는 것보다 하나 더 끊는 쪽이 안전하다).
- **폐기가 실제 폐기가 된다.** `POST /auth/logout`은 그 세션 행만 지운다(이 토큰만 — 다른
  기기는 유지). 이전에는 클라이언트가 로컬 토큰만 지웠고 서버 세션은 TTL을 그대로 살았다.
  열린 소켓은 재검증 sweep이 정리하는데, 판정은 살아 있는 자격증명 해시 전체에 대해 **한 번의
  질의**로 한다 — 소켓마다 왕복하면 같은 자격증명의 소켓들이 서로 다른 순간에 판정돼 "어떤
  탭은 끊기고 어떤 탭은 사는" 상태가 생긴다. 질의 실패 시 **fail-open**이다: 일시적 DB 장애가
  전원 강제 로그아웃이 되면 안 되고, sweep 루프 안에서 던지면 unhandled rejection으로
  프로세스가 죽는다.
- ed25519 전송 서명·OAuth는 MVP 제외.
- CORS는 요청 origin을 그대로 반영한다(`origin: true`). 데스크탑 앱의 origin이 실행 방식에
  따라 다르기 때문이다 — `tauri dev`는 Vite dev 서버(`http://localhost:5173`)에서, 빌드된
  앱은 웹뷰 스킴(`tauri://localhost` 계열)에서 뜬다. 인증은 Origin이 아니라 Bearer 토큰이
  담당하고, 셀프호스트 단일 워크스페이스를 전제로 한 결정이다. allowlist로 좁히려면 먼저
  `tauri build` 산출물의 실제 Origin 헤더를 측정해야 한다 — 추측으로 목록을 짜면 배포본에서
  REST가 전면 차단된다.
- idempotency key는 `(author, channel)` 범위다. 전역 유일성을 가정하면 남의 key를 맞힌
  요청이 그 메시지를 재생 응답으로 돌려받아, 채널 격리(DM 멤버십 포함)를 우회한다.

## 5. 에러 처리·테스트·배포

### 에러 처리

- **업데이트로 에이전트 세션이 끊기지 않는다**: 종료 신호(SIGTERM)를 받으면 소켓을 닫기
  **전에** in-flight `inbox.poll`을 정상 타임아웃과 같은 모양(빈 결과 200)으로 마감하고
  (`lifecycle.ts`), 그 응답들이 빠질 때까지 최대 2초 기다린 뒤 닫는다. `/mcp`는
  `reply.hijack()`으로 raw 소켓을 가져가 Fastify `close()`의 in-flight 대기 대상에서
  빠지므로, 이 drain이 없으면 종료가 곧 transport error 절단이었다.
- **avcs 서버 다운 = 채팅은 무사**: 투영 워커만 지수 백오프 재접속, 복구 시
  커서부터 따라잡기(멱등성이 안전망). `/readyz`는 Postgres만 필수, avcs 연결은
  degraded로 표시.
- **presence 는 하트비트를 따른다**: 서버가 30초(`wsHeartbeatMs`)마다 ping 을 보내고, 직전 ping 에
  pong 이 없던 소켓을 끊는다(`ws/heartbeat.ts`). 케이블이 뽑히거나 피어가 wedge 되면 **close
  이벤트가 오지 않아** 죽은 연결이 online 으로 남았고, 사람은 그걸 "저 에이전트가 살아 있다"로
  읽는다. 한 번 놓친 pong 은 용서하고 연속 미응답만 끊는다 — 순간 지연으로 정상 연결을
  흔들지 않기 위해서다. 정리는 close 핸들러가 하므로 presence 경로가 하나로 유지된다.
- **레이트 리밋은 인증 표면만 좁힌다**: `/auth/login`(5분 20회), `/auth/register`·`/bootstrap`
  (15분 10회), `/ws-ticket`(1분 120회). 주소별 고정 창이고 판정은 인증 훅보다 **앞**이다 —
  그래야 Argon2 검증에 도달하기 전에 막히고 응답이 계정 존재 여부를 드러내지 않는다.
  `login`이 가장 낮은 이유는 Argon2가 의도적으로 비싸서 무제한 요청이 브루트포스이면서
  동시에 CPU 소진 벡터이기 때문이다. `/ws-ticket`이 넉넉한 이유는 재연결 폭풍이 정상 동작이라
  여기서 막으면 네트워크가 불안한 클라이언트가 영구히 못 붙는다. 발화·조회는 건드리지 않는다
  (에이전트가 정상적으로 많이 부른다). 한계: **카운터는 인스턴스 로컬이고 재시작으로 리셋된다**
  (인스턴스 1개 전제). 앞단 프록시를 두면 Fastify `trustProxy`를 켜야 실제 클라이언트 주소로
  계수된다 — 안 켜면 전체가 한 키를 공유해 서로를 밀어낸다.
- **메트릭**: `GET /metrics`(인증 필요, Prometheus 텍스트 형식). 요청 수·지연 히스토그램·
  WS 연결 수, 그리고 **repo별 투영 커서**. 커서를 노출하는 이유는 §3-B의 사일런트 스킵이
  관측되지 않기 때문이다 — 채널에는 아무 일도 없어 보이므로 숫자로 보여야 한다. 라벨은 반드시
  **라우트 패턴**(`/channels/:id/messages`)을 쓴다: 구체 경로를 넣으면 채널·메시지 id마다
  시계열이 생겨 스크레이프가 곧 메모리 사고가 된다. 게이지 수집 실패는 그 지표만 생략한다
  (DB가 내려간 상황에서 에러율을 못 보는 것이 최악이다). `/metrics`는 자기 스크레이프를 세지
  않는다. admin이 아니라 인증된 계정이면 되는 이유: 스크레이퍼의 실용적 자격증명은 만료 없는
  에이전트 PAT이고 사람 세션 토큰은 14일에 만료된다.
- **자격증명 사망은 조용하지 않다**: WS가 끊긴 사유를 클라이언트가 구분한다 — close `4401`
  (자격증명 폐기·만료), `4403`(origin 거부), 그리고 `POST /ws-ticket`의 `401`. 앞의 것들은
  **재시도로 낫지 않으므로** 재연결을 멈추고 로컬 상태를 비운 뒤 로그인 화면이 사유를 말한다
  (부팅 실패와 같은 표면). 네트워크 끊김만 무한 백오프를 탄다 — 잠깐 끊겼다고 로그아웃시키면
  최악이다. 이 구분이 없으면 다른 기기에서 로그아웃하거나 PAT가 폐기된 사용자는 사이드바
  빨간 점과 영구 재연결만 보고 이유를 알 수 없다.
- **감사 추적**: `audit_log` 테이블(append-only, `003_audit_log.sql`). 인증·권한·되돌릴 수 없는
  행위만 남긴다 — 로그인 성공/실패, 로그아웃, 계정·에이전트 생성, 초대 발급, PAT 발급·폐기,
  admin 채널 변경, 메시지 삭제. **대화 내용은 넣지 않는다**(이미 `message` 테이블이고, 감사에
  본문을 복사하면 삭제가 삭제가 아니다). **비밀도 넣지 않는다** — 감사는 널리 읽히도록 만드는
  것이 목적이므로 거기 토큰이 있으면 열람 권한이 곧 계정 권한이 된다. `update`/`delete`는
  트리거가 거부한다: 지울 수 있는 기록은 증거가 못 된다(보존 정책을 넣으려면 트리거를 의도적으로
  내려야 한다). 삽입 실패는 **fail-open**이다 — `audit_log` 하나가 로그인을 막으면 감사 공백보다
  나쁘다. 실패는 요청 로그에 남는다. 조회는 admin 전용 `GET /audit`(id 커서 — 같은 밀리초에
  여러 건이 들어오면 시각 커서는 항목을 건너뛴다).
- **관측**: 요청 로깅은 pino(Fastify 기본)이고 레벨은 `LOG_LEVEL`(기본 `info`)이다. 로그로
  자격증명이 새지 않는 것이 이 층의 요구사항이다 — `authorization`·`cookie` 헤더는 redact하고,
  URL 쿼리의 `ticket`·`token`·`idempotency-key` 값은 `REDACTED`로 치환한다(`logging.ts`).
  WS 티켓은 URL에 실리므로(브라우저가 헤더를 못 붙인다) 이 치환이 없으면 "URL은 프록시 로그에
  남는다"는 티켓 도입 이유가 우리 로그에서 그대로 재현된다. 요청 **바디는 로깅하지 않는다**.
- REST 에러는 `{error: {code, message}}` 단일 규약. idempotency-key 중복은 기존
  결과 재반환.
- MCP `inbox.poll` 타임아웃은 빈 결과 반환(에러 아님).

### 테스트 전략

- Vitest, 프로젝트 test 스크립트 단일 진입.
- server: Fastify inject + 실제 Postgres(compose test DB) 라우트 통합 테스트.
- avcs 어댑터(`avcs/client.ts`): **실제 `@izagood/avcs-server`를 in-process로 띄워**
  검증한다. 아래 "contract test 승격"이 완료된 상태다 — fake 상대로 통과하는 테스트는
  wire 드리프트를 잡지 못한다는 것을 실제로 겪었다(fake는 `204`/`{entries}`를 가정했고
  실제 서버는 `200 {oids, cursor}`를 준다).
- 투영 워커: `AvcsServerClient`를 **인메모리로 주입**해 transport와 분리한 뒤 커서 전진,
  `(repo,oid)` dedupe, 리플레이, 다운 후 복구를 검증한다 — 손으로 심은 DB 상태로
  통과시키지 않고 반드시 클라이언트 경계를 경유한다. wire는 위 어댑터 테스트가 전담한다.
- 프로토콜 스펙 버전 핀은 어댑터 파일 상단에 둔다.
- desktop: 컴포넌트 테스트(jsdom, matchMedia 스텁), E2E는 MVP 이후.

### 배포·운영

- self-host: docker compose 3서비스(`server` + `postgres` + `avcs-server`).
- **백업·복구 절차는 [`operations.md`](operations.md)**. 요지: 필수 대상은 `pgdata` 하나이고
  (인메모리 상태는 재구성된다), 복구는 `server`를 멈춘 뒤 하고, **murmur만 되돌리는 것은
  안전하지만**(투영이 멱등) **avcs를 murmur 커서보다 뒤로 되돌리면 그 사이 객체가 조용히
  건너뛰어진다** — 그때는 커서를 함께 내린다. 두 성질 모두 `projection.test.ts`가 지킨다.
- 데스크탑: Tauri 릴리스 바이너리.

#### 업데이트 모델 — "업데이트해도 에이전트는 계속 일한다"

에이전트가 **외부 접속형**(§1)이라는 결정이 업데이트 내성의 근거다. 세 축이 서로 독립이다.

| 업데이트 축 | 에이전트 세션 | 이유 |
|---|---|---|
| 데스크탑 앱 | 무관 | 에이전트는 앱 안에 살지 않는다. 앱은 사람용 클라이언트일 뿐 |
| workspace-server | 끊기지 않음(재접속 필요) | MCP가 stateless + 상태가 전부 Postgres + 종료 시 drain |
| avcs 서버 | 끊기지 않음 | 투영 워커만 백오프 재접속, 커서부터 따라잡기 |

workspace-server 교체가 안전한 이유를 구체적으로:

1. **복원할 서버측 세션 상태가 0이다.** `/mcp`는 `sessionIdGenerator: undefined`로
   요청마다 `McpServer`를 새로 만들고 닫는다. 교체 후 에이전트가 복원할 세션 ID가 없다.
2. **진실의 원천이 전부 Postgres다.** inbox·메시지 seq·`projection_cursor`·`active_lease`·
   idempotency. 인메모리는 이벤트 버스와 presence 카운터뿐이고 둘 다 재연결로 재구성된다.
3. **재시도가 중복 발화를 만들지 않는다.** idempotency key가 `(author, channel)` 범위로
   DB에 남아, 교체를 가로지른 재시도도 같은 메시지를 재생 응답으로 돌려받는다.
4. **종료가 절단이 아니다.** 위 drain. 종료 중 도착한 poll도 park 없이 즉시 빈 결과다.
5. **재시도 책임은 계약으로 넘긴다.** 서버가 에이전트 런타임을 모르므로 재접속을 강제할 수
   없다. MCP `workspace.guide`의 "poll 루프 계약"이 빈 결과·재시작·절단 세 경우를 모두
   정상으로 규정하고 백오프 재시도를 지시한다.
6. **롤링 업데이트에서 부팅이 충돌하지 않는다.** `runMigrations`는 advisory lock으로
   직렬화된다. 잠금이 없으면 뒤늦게 뜬 인스턴스가 첫 DDL에서 죽었다(`create table if not
   exists`조차 카탈로그 유니크 인덱스에서 경합한다).

남은 한계(의도적): compose는 `server` 1개라 교체 창(수 초) 동안 REST는 거절된다 — 무중단이
아니라 **끊겨도 이어진다**가 보장 범위다. 데스크탑은 WS 백오프 재연결 + `since=` 리컨실로,
에이전트는 위 poll 계약으로 그 창을 건넌다.
- **개발 자체가 첫 도그푸딩**: murmur를 avcs로 버전관리하고, 첫 워크스페이스
  인스턴스가 murmur 개발 워크스페이스가 된다.

## 6. 스코프 제외 (v2 이후)

- 상주형 에이전트(서버 호스팅)
- 웹 UI, 모바일
- 멀티테넌시(워크스페이스 N개/인스턴스)
- 메시지 서명 필수화(서명 헬퍼 전제)
- private 채널·세분화된 채널 권한
- 외부 프로토콜 상호운용 어댑터
- 이메일 알림, OAuth 로그인

## 7. 외부 의존과 전제

| 의존 | 상태 | 리스크 완화 |
|---|---|---|
| avcs self-hosted 프로토콜 스펙 | 별도 공개 예정 | 스펙 버전 핀 + fake 서버 → contract test 승격 |
| avcs 프로토콜 스펙 구현 서버 | 별도 진행 | 준비 전에는 `avcs serve`를 개발 대역으로 |
| `@izagood/avcs` (npm, Apache-2.0, zero-dep) | 공개 배포 중 | 타입·identity 유틸만 소비 |

## 8. 성공 기준 (MVP 완료 정의)

murmur 개발 워크스페이스를 murmur 자신으로 운영할 수 있다:

1. 사람 1명 + 에이전트 2개 이상이 한 채널에 참여한다
2. 사람이 스레드에서 에이전트를 멘션해 작업을 요청하면, 에이전트가
   `inbox.poll`로 깨어나 응답한다
3. 코드 작업은 avcs로 진행되고, operation/decision이 해당 스레드에 투영된다
   (`work.link` 경유)
4. 읽기 전용 요청은 avcs 흔적 없이 채팅으로만 끝난다
5. 사이드바 현황판에서 에이전트들의 lease 점유가 실시간으로 보인다
6. avcs 서버를 재시작해도 채팅은 끊기지 않고, 투영은 커서부터 따라잡는다
7. **workspace-server를 업데이트(프로세스 교체)해도 에이전트 세션은 중단되지 않는다** —
   진행 중이던 `inbox.poll`은 빈 결과로 정상 마감되고, 교체된 인스턴스에서 같은 에이전트의
   다음 poll이 그동안 쌓인 inbox를 그대로 받으며, 교체를 가로지른 재시도는 메시지를
   중복 생성하지 않는다 (`packages/server/test/restart.test.ts`)

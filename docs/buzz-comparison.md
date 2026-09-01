# buzz 셀프호스트 실측과 murmur 비교

- 날짜: 2026-09-01
- 대상: [block/buzz](https://github.com/block/buzz) relay `0.2.1`, Desktop `0.5.20`
- 출처: [Run your own Buzz relay](https://engineering.block.xyz/blog/run-your-own-buzz-relay)
- 목적: murmur와 같은 문제("사람과 에이전트가 같은 방에서 일한다")를 푸는 다른 구현을
  직접 띄워보고, murmur 설계 결정을 대조 검증한다

buzz는 murmur의 직접적인 대조군이다. 정의가 거의 같고, 협업 기층만 다르다 —
murmur는 avcs, buzz는 Nostr다.

## 1. 실측 셋업 (재현 절차)

최초 실측은 로컬 맥에서, 이후 `jaebin-worker` VM으로 이전했다(§2.6). 아래 값은 최초 실측 기준이다.

| 항목 | 값 |
|---|---|
| 릴레이 이미지 | `ghcr.io/block/buzz@sha256:aa5180ce…69f5` (digest 핀) |
| 호스트 포트 | `3200` (3000=avcshub-web, 3100, 3400=murmur 점유 회피) |
| `RELAY_URL` | `ws://127.0.0.1:3200` |
| 서비스 | relay(Rust/Axum) + postgres:17 + redis:7 + minio + minio-init |
| 볼륨 | postgres / redis / minio / **git** |

```sh
git clone https://github.com/block/buzz && cd buzz/deploy/compose
cp .env.example .env
for name in $(grep 'CHANGE_ME_RANDOM' .env | cut -d= -f1); do
  sed -i.bak "s|^${name}=.*|${name}=$(openssl rand -hex 32)|" .env
done && rm .env.bak
# 수동 2종 + 로컬 평문화 4종 (아래 §2 함정 참조)
./run.sh start
curl -fsS http://127.0.0.1:3200/_liveness   # -> ok
```

검증 완료: `_liveness` ok → NIP-11 응답 → Desktop "Add a community" → 메시지 전송 →
릴레이 Postgres에 `kind:9`(STREAM_MESSAGE)로 저장 확인. 전 구간 왕복이 자체 호스팅으로 동작한다.

## 2. 블로그가 다루지 않은 함정 (실측)

1. **`sed` 루프만으로는 기동되지 않는다.** `run.sh`는 `.env`에 `CHANGE_ME` 대입이
   하나라도 남으면 시작을 거부하는데, 블로그의 루프는 `CHANGE_ME_RANDOM` 접두만 채운다.
   `RELAY_OWNER_PUBKEY`와 `BUZZ_RELAY_PRIVATE_KEY`는 손으로 넣어야 한다.
2. **`.env.example`은 `wss://` 도메인을 전제한다.** 로컬 평문으로 띄우려면
   `RELAY_URL`·`BUZZ_MEDIA_BASE_URL`·`BUZZ_MEDIA_SERVER_DOMAIN`·`BUZZ_CORS_ORIGINS`
   네 개를 `127.0.0.1:3200` 기준으로 함께 고쳐야 한다. `RELAY_URL`만 고치면 미디어와
   CORS가 어긋난다.
3. **의존 서비스는 호스트 포트를 열지 않는다.** Postgres/Redis/MinIO 포트 노출은
   `compose.dev.yml`(`BUZZ_COMPOSE_DEV=true`)에서만 일어난다. 조정할 포트는
   `BUZZ_HTTP_PORT` 하나뿐이다.
4. **NIP-11의 `pubkey`가 `null`이다.** 릴레이 공개키는 비표준 `self` 필드로 나간다
   (`crates/buzz-relay/src/nip11.rs:206`에 `pubkey: None` 하드코딩). 블로그 설명과 다르다.
5. **릴레이가 서빙하는 웹 UI는 채팅 클라이언트가 아니다.** `should_serve_spa()`가
   허용하는 경로는 `/invite/<code>`와, `BUZZ_SERVE_GIT_WEB_GUI=true`일 때의 `/repos/**`뿐이다.
   `/`는 API 라우터가 선점해 NIP-11 JSON을 반환한다.

6. **URL 이전은 가능하다 — 단 순서가 전부다.** `RELAY_URL`을 바꿔 옮길 때
   릴레이를 먼저 띄우면 빈 커뮤니티가 새로 생겨버린다. 순서는 이렇다:

   ```sh
   # 1) 옛 호스트에서 덤프
   docker exec <pg> pg_dump -U buzz -Fc buzz > buzz.dump
   # 2) 새 호스트: postgres만 먼저 올리고 복원
   docker compose up -d --wait postgres
   docker exec -i <pg> psql -U buzz -d postgres -c 'create database buzz owner buzz'
   docker exec -i <pg> pg_restore -U buzz -d buzz --no-owner < buzz.dump
   # 3) host 갱신 — 릴레이 기동 전에
   docker exec <pg> psql -U buzz -d buzz \
     -c "update communities set host='new.example.com:3200'"
   # 4) 이제 전체 기동
   ./run.sh start
   ```

   부팅 로그의 `community=<uuid>`가 옛 UUID 그대로면 성공이다. 이 절차로 이벤트
   117건·메시지 18건·멤버 2명을 UUID 유지한 채 옮겼다. 미디어·git 저장소가 있으면
   MinIO 버킷과 git 볼륨도 같은 정비 창에서 함께 옮겨야 한다.

## 3. 정면 대조

### 3.1 코드 협업 층 — 임베딩 vs 관찰

가장 큰 차이다. buzz 릴레이는 **워크스페이스 안에 완전한 git 서버를 내장**한다:
`BUZZ_GIT_REPO_PATH`, `BUZZ_GIT_MAX_REPOS_PER_PUBKEY`, `BUZZ_GIT_MAX_PACK_BYTES`,
`BUZZ_GIT_PACK_CACHE_PATH`, `BUZZ_GIT_HOOK_HMAC_SECRET`, 전용 `buzz-git-data` 볼륨.
PR·이슈·상태까지 Nostr 이벤트다 (NIP-34: `1617` patch, `1618` PR, `1621` issue,
`1630~1633` status open/merged/closed/draft).

murmur는 `design.md` 핵심 결정 1번에서 정확히 반대를 택했다 — avcs 서버를 임베딩하지 않고
이벤트 구독·메타 조회만 하는 **관찰자 서버**다.

| | buzz | murmur |
|---|---|---|
| 코드 호스트 | 릴레이에 내장 | 외부 프로세스(avcs), 관찰만 |
| 업그레이드 결합 | 채팅과 코드가 한 바이너리 | 세 축 독립(§5 업데이트 모델) |
| 저장소 쿼터 | pubkey당 개수·바이트 상한 필요 | 해당 없음 |
| 장애 반경 | git pack 캐시 경합이 채팅에 영향 | 투영 워커만 백오프 |

murmur의 선택이 운영상 유리하다는 근거가 실물로 확인됐다. 다만 buzz는 그 대가로
**저장소 브라우저를 워크스페이스 안에서 바로 준다** — murmur에는 없는 표면이다.

### 3.2 신원 — 키가 원천 vs 서버가 원천

buzz는 ed25519 키페어가 신원의 원천이다. `RELAY_OWNER_PUBKEY`가 유일한 삭제 불가 계정이고,
멤버십은 `add-member`로 pubkey를 명시 등록하는 폐쇄형이다(`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`).
murmur는 `/bootstrap`으로 만든 서버 계정이 원천이고 handle+Argon2 비밀번호로 인증한다.

실측에서 드러난 차이:

- **키 표현이 두 가지다.** `generate-key`는 raw hex 64자를 내는데, 블로그의 멤버 추가
  예시는 `npub1…` bech32다. `add-member`는 둘 다 받지만 사용자는 두 표현을 오가야 한다.
  murmur는 `account_key`를 SPKI PEM 하나로 고정해 이 문제가 없다.
- **멤버십이 서명 이벤트다.** 로스터는 `kind:13534` 이벤트이고 초 단위 타임스탬프로
  버전이 매겨진다. 그래서 `run.sh` 도움말이 *"루프로 여러 명 추가할 때 `sleep 1`을 넣어라,
  병렬 추가 금지"* 라고 경고한다. 이벤트 소싱을 신원 층까지 밀어붙인 비용이다.
  murmur의 멤버십은 테이블 행이라 이 제약이 없다.

### 3.3 워크스페이스 조회가 URL에 묶인다

부팅 로그가 명시한다: `Deployment community ensured host=127.0.0.1:3200 community=<uuid>`.
블로그는 `RELAY_URL`을 바꾸면 새 커뮤니티가 생긴다고 경고한다 — 사실이지만, **이유는
파생이 아니라 조회다.**

`communities` 테이블을 실제로 보면 `id uuid DEFAULT gen_random_uuid()`에 `host`의
`lower()` 유니크 인덱스가 걸려 있고, 릴레이는 `ensure_configured_community(&host)`로
**host를 열쇠 삼아 조회할 뿐 id를 host에서 계산하지 않는다.** 즉 URL 변경이 데이터를
끊는 게 아니라, 새 host로는 기존 행이 안 잡혀 빈 커뮤니티가 하나 더 생기는 것이다.

그래서 이전은 가능하다(§2.6). 다만 buzz가 문서화한 경로가 아니고 DB를 직접 만져야 한다.

murmur는 "서버 인스턴스 1개 = 워크스페이스 1개"일 뿐 URL이 조회 열쇠가 아니다 —
데스크탑이 로그인 시 서버 URL을 자유롭게 받는다. 이전 난이도에서 murmur가 유리하지만,
buzz도 막힌 건 아니라는 점에서 **처음 이 문서가 적은 것보다 격차는 작다.**
murmur의 이 이점은 현재 `design.md`에 명시돼 있지 않다.

### 3.4 온보딩과 에이전트

buzz 온보딩 3번째 화면이 "Meet your starter team" — Fizz/Honey/Pollen 세 에이전트가
계정 생성 흐름 안에서 기본 제공된다.

murmur는 에이전트 **정의**를 등록·수정하는 표면은 갖췄지만(`AgentManager.tsx`,
`agent_config` 마이그레이션), 러너는 여전히 `MURMUR_PAT` + `ANTHROPIC_API_KEY`를
환경변수로 받아 별도 기동해야 한다(README "에이전트 붙이기"). 즉 설정 UI는 있고
**기동은 수동**이다.

"에이전트가 있어야 제 기능을 한다"는 같은 전제에서 buzz는 이를 **온보딩 기본값**으로,
murmur는 **사후 설정**으로 뒀다. murmur의 선택에는 근거가 있다 — 에이전트가
외부 접속형이라 서버가 런타임을 모르고(`design.md` §1), 그래서 API 키를 서버가
쥐지 않는다. buzz의 기본 제공은 그 반대 대가를 치른다.

### 3.5 운영 표면

buzz는 `run.sh` 하나로 `start/stop/restart/status/config/pull/upgrade/logs/backup-hint/
add-member/remove-member/list-members`를 준다. `backup-hint`는 백업 대상을 나열한다:
`.env`의 안정 시크릿, Postgres, MinIO 버킷, git 볼륨, Caddy 볼륨 — 그리고 *"Postgres와
객체/git 상태 스냅샷은 같은 정비 창에서 뜨라"* 는 일관성 조건까지 명시한다.

murmur에는 `docs/operations.md`가 있고, 백업·복구 서술은 오히려 buzz보다 앞선다 —
`pg_dump -Fc`가 단일 트랜잭션 스냅샷이라 메시지와 투영 커서가 어긋나지 않는다는 **정합성의
근거**, avcs를 murmur 커서보다 오래된 상태로 되돌렸을 때의 위험(§3-B), 복구 리허설
체크리스트, 그리고 "아직 없는 것"(자동화·오프사이트·PITR·보존 정책)까지 적혀 있다.
buzz의 `backup-hint`는 대상 나열에서 멈춘다.

차이는 **전달 방식**이다. buzz는 그것을 명령(`./run.sh backup-hint`)으로 노출하고
murmur는 문서로만 둔다. 운영자가 셸에 있을 때 문서를 찾아가야 한다.

### 3.6 규모 대비

buzz의 `events`·`delivery_log` 테이블은 **월 단위 파티션**이다
(`events_p2026_09`, `delivery_log_p2026_10` …). 부팅 시 향후 파티션을 미리 만든다.
murmur의 `message`는 단일 테이블이다.

## 4. murmur 후속 항목

실측에서 도출된, 실행 가능한 항목만 적는다.

| # | 항목 | 근거 |
|---|---|---|
| 1 | 운영 래퍼 스크립트(`status`/`upgrade`/`logs`/`backup`) | §3.5 — `operations.md`의 절차를 명령으로 노출. 운영자가 셸을 떠나지 않게 |
| 2 | 워크스페이스 정체성이 URL에 묶이지 않음을 `design.md`에 명시 | §3.3 — 이미 가진 이점이 문서화돼 있지 않다 |
| 3 | 인증 거부의 클라이언트 가시성 점검 | §5 — buzz는 403을 조용히 삼켰다. murmur도 PAT 만료·세션 폐기 시 같은 침묵이 없는지 확인 |
| 4 | 첨부/미디어 층 설계 착수 | `operations.md` §4가 백업 순서 위험을 이미 예견해 뒀다. 남은 건 설계·구현. buzz는 MinIO를 필수 의존으로 둔다 |
| 5 | `message` 테이블 파티셔닝 시점 판단 | §3.6 |
| 6 | 러너 기동의 온보딩 편입 검토 | §3.4 — 정의 UI는 있고 기동은 수동이다. 외부 접속형 결정을 깨지 않는 선에서 무엇이 가능한지 |
| 7 | `operations.md`의 깨진 `roadmap.md` 링크 정리 | 부수 발견 — 해당 파일이 저장소에 없다 |

## 5. 부수 관찰

- **폐쇄형 릴레이의 거부가 사용자에게 보이지 않는다.** Desktop이 기기 신원으로 가입을
  시도했고 릴레이는 `403`을 반복 반환했는데(`/query`, `/events`), 앱은 아무 안내 없이
  조용히 재시도만 했다. `add-member`로 등록하자 즉시 진행됐다. 폐쇄형 멤버십의 UX 공백이다.
- **Desktop은 커뮤니티를 다중 등록한다.** 기존 호스티드(`wss://jaebin.communities.buzz.xyz`)를
  유지한 채 로컬 릴레이가 별도 커뮤니티로 추가됐다. murmur 데스크탑은 서버 하나에 붙는다.
- 지원 NIP: `1,2,10,11,16,17,23,25,29,33,38,42,50,56,43` + 확장 `nip-er`.
- 릴레이 내부 포트: HTTP 3000, health 8080, Prometheus metrics 9102 (호스트 미노출).

# 운영 절차 — 백업과 복구

- 기준일: 2026-09-01
- 대상: self-host 운영자(docker compose 기준)
- 성격: [`design.md`](design.md)가 설계, [`roadmap.md`](roadmap.md)가 현황이라면 이 문서는 **손으로 밟는 절차**다.

## 1. 무엇이 어디에 사는가

백업 계획은 상태의 위치에서 시작한다. murmur의 상태는 세 곳에 있고, **성격이 다르다.**

| 상태 | 어디에 | 백업 대상인가 |
|---|---|---|
| 채팅·멤버십·inbox·투영 커서·idempotency·세션/PAT 해시 | Postgres 볼륨 `pgdata` | **필수.** 이것만 잃으면 워크스페이스가 사라진다 |
| avcs 오브젝트(intent·operation·decision·lease) | **avcs 서버의 저장소** (별도 프로세스) | 필수지만 **murmur의 책임이 아니다.** murmur는 그 로그의 관찰자다(§3 참조) |
| 첨부 파일 *(계획)* | 로컬 볼륨 `attachments` | 도입되면 필수. `pgdata`와 **함께** 떠야 한다(§4) |

백업하지 **않는** 것 — 잃어도 재구성되기 때문이다:

- WS 티켓, presence 카운터, 레이트 리밋 카운터: 전부 인메모리다. 재시작하면 리셋되고, 클라이언트 재연결이 presence를 다시 세운다.
- 데스크탑의 토큰(`localStorage`): 재로그인으로 복구된다.
- 투영된 시스템 메시지: `pgdata`에 있지만 **원본은 avcs 로그다.** 커서를 되돌리면 다시 만들어진다(§3-A).

## 2. 백업 절차

Postgres는 논리 덤프로 뜬다. `-Fc`(custom format)는 **단일 트랜잭션 스냅샷**이므로 메시지와
투영 커서가 서로 어긋난 시점으로 잡히지 않는다 — 이 정합성이 §3의 복구 안전성의 전제다.

```bash
# 서비스를 멈추지 않고 뜬다(pg_dump는 읽기 일관 스냅샷을 잡는다)
docker compose exec -T postgres \
  pg_dump -U murmur -Fc murmur > "murmur-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

첨부 볼륨이 도입되면 **두 대상을 가깝게** 뜬다(순서 위험은 §4):

```bash
docker compose stop server                      # 쓰기를 멈춘다
docker compose exec -T postgres pg_dump -U murmur -Fc murmur > murmur.dump
docker run --rm -v murmur_attachments:/data -v "$PWD":/backup alpine \
  tar czf /backup/attachments.tgz -C /data .
docker compose start server
```

avcs 서버는 자기 절차를 따른다. murmur 덤프만 있으면 채팅은 온전하지만, **작업 층(avcs)은
복구되지 않는다** — 투영된 시스템 메시지는 남고 그것이 가리키는 오브젝트는 사라진 상태가 된다.

## 3. 복구 절차

`server`를 **먼저 멈춘다.** 살아 있으면 복구 중에 쓰기가 들어가고, 부팅 시 마이그레이션이
돌아 스키마가 덤프와 어긋난다.

```bash
docker compose stop server
docker compose exec -T postgres dropdb -U murmur --if-exists murmur
docker compose exec -T postgres createdb -U murmur murmur
docker compose exec -T postgres pg_restore -U murmur -d murmur --no-owner < murmur.dump
docker compose start server        # 부팅 시 누락 마이그레이션이 적용된다
```

마지막 줄에 기댈 수 있는 이유: `runMigrations`가 advisory lock으로 직렬화되고 적용 여부를
`schema_migrations`로 판정한다. **오래된 스키마의 덤프를 새 서버로 복구해도 부팅이 그 차이를
메운다.** 반대 방향(새 스키마 덤프 → 오래된 서버)은 지원하지 않는다.

### 3-A. murmur만 되돌린 경우 — 안전하다

투영 커서가 과거로 가고, 워커가 이미 투영했던 구간을 다시 읽는다. 시스템 메시지는
`(repo, oid)` UNIQUE로 중복되지 않고, 커서 전진이 메시지 삽입과 같은 트랜잭션에 있다.
→ 워커가 조용히 따라잡고 끝난다.

근거(테스트): `projection.test.ts` → *"is idempotent: rerun from cursor 0 does not duplicate"*.

사람이 쓴 메시지는 avcs에 없으므로 **덤프 시점 이후의 대화는 돌아오지 않는다.** 그건 복구의
성질이고 결함이 아니다.

### 3-B. avcs를 murmur 커서보다 오래된 상태로 되돌린 경우 — 위험하다

커서가 로그보다 앞서면 `fetchSince`가 줄 것이 없고, 커서는 후퇴하지 않는다. 크래시는 없지만
**avcs 로그가 커서를 다시 넘어설 때까지 그 사이의 객체가 조용히 건너뛰어진다.** 채널에는
아무 일도 없어 보이므로 알아차리기 어렵다.

근거(테스트): `projection.test.ts` → *"stalls without crashing when the cursor is ahead of the avcs log"*.

**대처**: avcs를 되돌렸다면 해당 repo의 커서를 그 지점 이하로 맞춘다. 재투영은 멱등이므로
0으로 내려도 안전하다.

```sql
update projection_cursor set last_log_index = 0 where repo = 'org/repo';
```

원칙: **avcs와 murmur를 되돌릴 때는 avcs를 murmur보다 뒤로 두지 않는다.** 어쩔 수 없다면
커서를 함께 내린다.

## 4. 첨부 볼륨의 순서 위험 (도입 시)

`pgdata`와 `attachments`는 **다른 시점으로 뜰 수 있다.** DB가 더 새로우면 메시지가 존재하지
않는 파일을 가리키고(다운로드 404), 볼륨이 더 새로우면 아무도 참조하지 않는 파일이 남는다.
둘 중 **후자가 안전하다** — 그래서 순서는 `볼륨 → DB`가 아니라 `server 정지 → 둘 다 → 시작`이다.
정지 없이 뜬다면 볼륨을 먼저 뜬다.

## 5. 복구 리허설 체크리스트

복구는 **해 본 적 있을 때만** 절차다. 다음을 실제로 밟아 확인한다.

- [ ] 덤프를 **다른 데이터베이스 이름**으로 복구해 본다(운영 DB를 건드리지 않고 검증)
- [ ] 복구본으로 서버를 띄우고 `GET /readyz` 200, `GET /healthz`의 `avcs.connected` 확인
- [ ] 로그인 → 채널 목록 → 메시지 히스토리가 보이는지
- [ ] 에이전트 PAT로 `inbox.poll` 1회가 정상 응답하는지
- [ ] repo 바인딩 채널에서 새 avcs 객체가 투영되는지(커서가 전진하는지)

## 6. 아직 없는 것

- **자동화**: cron/타이머가 없다. 위 명령을 손으로 돌린다.
- **오프사이트 사본**: 덤프가 같은 호스트에 남는다. 호스트를 잃으면 백업도 잃는다.
- **PITR**: WAL 아카이빙이 없다. 복구 지점은 마지막 덤프뿐이다.
- **보존 정책**: 오래된 덤프를 지우는 규칙이 없다.

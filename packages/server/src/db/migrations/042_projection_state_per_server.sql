-- 투영 상태(커서·리스)를 (repo, avcs 서버)로 키를 넓힌다.
--
-- `last_log_index` 는 **그 avcs 서버의** append-only 로그 안 위치다. `repo` 는
-- `"org/repo"` 두 조각짜리 이름일 뿐이고, 같은 이름이 avcs 서버마다 따로 있을 수
-- 있다(로컬에도 izagood/murmur, VM 에도 izagood/murmur). repo 하나만으로 행을 잡으면
-- 서버 A(커서 5000)에서 서버 B(로그 120건)로 URL 을 바꿨을 때 새 워커가 B 에게
-- `waitForChange(repo, 5000)` 을 묻고 B 는 영원히 "5000 이후엔 없다"를 답한다 — 커서는
-- 얼어붙는데 `lastPolledAt` 은 계속 갱신되어 상태는 `ok` 로 남고, A 의 낡은 리스가
-- 현재 활성 작업으로 보인다.
--
-- 대안(URL 이 바뀔 때 상태를 지운다)은 고르지 않았다: 지우기와 빠지는 중인 옛 워커의
-- 쓰기가 경쟁하려면 `ProjectionWorker` 에 epoch 번호를 넣어야 하고, "워커는 손대지
-- 않는다"는 이 변경의 전제가 깨진다. 키를 넓히면 옛 워커와 새 워커가 서로 다른 행에
-- 쓰므로 경쟁 자체가 없다. 부수 효과도 낫다: 서버를 되돌아가면 이어서 따라간다
-- (지웠다면 전재스캔이 매번 일어난다).
alter table projection_cursor add column avcs_base_url text not null default '';
alter table projection_cursor drop constraint projection_cursor_pkey;
alter table projection_cursor add primary key (repo, avcs_base_url);

alter table active_lease add column avcs_base_url text not null default '';
alter table active_lease drop constraint active_lease_pkey;
alter table active_lease add primary key (repo, avcs_base_url, path, actor_key_id);

-- `default ''` 를 남기는 이유는 두 가지다:
-- 1. 기존 행(어느 서버에서 왔는지 이 마이그레이션이 알 수 없다)을 지우지 않는다.
--    지우는 것은 기록을 지우는 별개의 결정이다.
-- 2. `packages/server/test/directory.test.ts` 처럼 이 컬럼 없이 insert 하는 기존
--    테스트가 있다. not null 인데 default 가 없으면 그 insert 가 깨지고, 그것은 이
--    변경과 무관한 실패가 된다.
--
-- `''` 인 행은 실제 avcs URL 과 결코 일치하지 않으므로(URL 은 항상 비어 있지 않은
-- http(s) 문자열이다), 업그레이드 뒤 실제 서버에 대한 첫 폴링은 그 서버 행이 없어
-- since=0 부터 다시 읽는다 — 업그레이드 직후 한 번의 전재스캔이고, 로그 재읽기는
-- idempotent(리스 upsert·커서 전진)라 안전하다.

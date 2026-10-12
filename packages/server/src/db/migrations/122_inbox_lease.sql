-- 러너가 **쥐고 있는** inbox 항목의 임대(2026-10-12 inbox 호출 설계 B, jaebin 승인).
--
-- 러너는 턴이 끝난 뒤에 읽음 처리한다(at-least-once). 그래서 처리 중인 항목도 안 읽은 채라 `inbox.poll` 이
-- 그것을 **곧바로 다시** 돌려줬다 — 바쁜 러너는 25초 롱폴 대신 5초마다 같은 배치를 받고 channel.list·/accounts·
-- thread-claims 를 함께 돌렸다(10-12 14시대 /accounts 13배·thread-claims 17배).
--
-- 러너가 폴마다 지금 쥔 항목을 알리면 서버가 그 항목에 `claimed_until` 을 걸고 폴 결과에서 뺀다. 쥐지 않게 되면
-- 다음 폴에서 풀고(`claimed_by` 가 같은 러너일 때만), 러너가 죽으면 시각이 지나 다시 나간다 — 잃지 않는다.
--
-- 둘 다 null 허용 컬럼 추가라 옛 파드에 무해하다(expand). 인덱스는 따로 두지 않는다 — 폴은 121 의 안 읽은 행만
-- 훑고 그 행에서 이 두 칸을 본다.
alter table inbox add column if not exists claimed_by text;
alter table inbox add column if not exists claimed_until timestamptz;

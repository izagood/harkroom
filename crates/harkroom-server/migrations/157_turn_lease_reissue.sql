-- 턴 임대 다시 주기(157). 러너가 다시 떠서(앱 갱신 등) 같은 부름을 다시 집으면, 앞 러너가 받은 임대는 박동이 끊긴 채
-- 남아 있고 서버는 「부름당 한 번」 규칙으로 새 임대를 거절했다(409). 이제 그 부름이 아직 처리되지 않았고 옛 임대의 박동이 끊겼으면
-- 옛 임대를 끝내고 새로 준다(`issueTurnLease`).
--
-- ① last_renewed_at: 마지막 박동(발급·갱신) 시각. 기존 행은 발급 시각으로 채운다.
-- ② reissue_of: 다시 준 임대가 어느 임대를 대신하는지(부름당 다시 주기 횟수를 센다).
-- ③ 「(에이전트, 부름) 당 하나」 유일 색인을 「살아 있는 임대는 하나」로 바꾼다 — 끝난 옛 임대 행은 기록으로 남는다.
--    부름당 몇 개까지인지는 코드가 advisory lock 안에서 센다(처음 1 + 다시 주기 최대 2).
alter table secret_turn_lease add column last_renewed_at timestamptz;
update secret_turn_lease set last_renewed_at = created_at where last_renewed_at is null;
alter table secret_turn_lease alter column last_renewed_at set default now();
-- not null 은 걸지 않는다(롤링 배포 중 옛 파드는 이 칸을 모른다 — 기본값이 채운다). 코드는 비면 created_at 으로 읽는다.
alter table secret_turn_lease add column reissue_of uuid null references secret_turn_lease(id) on delete set null;
drop index if exists secret_turn_lease_cause_uniq;
create unique index secret_turn_lease_cause_live_uniq on secret_turn_lease (agent_id, cause_message_id) where ended_at is null;

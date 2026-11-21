-- 위임장 C-2 — `delegator`(맡긴 사람): 이 위임장으로 에이전트에게 일을 맡긴 사람(소유자 결정 2026-11-02).
-- 위임장의 주인(owner_account_id)은 그대로 에이전트 소유자다. 지금은 소유자 글에만 위임장이 생기므로 delegator = owner 이고,
-- 사용 권한자 발급(C-3)부터 다를 수 있다. 상시 줄(7일 grant 를 줄로 읽은 것)은 delegator 가 준 grant 만 친다.
--
-- 임대의 principal(`secret_turn_lease.principal_account_id`, 이번 턴을 **깨운** 사람)과는 다른 값이다:
--   - principal: 턴마다 원인 글에서 정함 · wake 로 깬 턴이면 null · mention 호출 판정에만 쓰고 머지 판정에는 쓰지 않는다(C5).
--   - delegator: 위임장마다 한 번 정함 · wake 턴도 위임 키를 물려받으면 같은 delegator · 위임장 줄(머지·도구 판정)의 출처다.
-- 옛 파드가 넣는 행은 null 이다 — 읽는 쪽은 coalesce(delegator_account_id, owner_account_id) 로 읽는다(expand).
alter table mandate add column if not exists delegator_account_id uuid null references account(id) on delete cascade;
update mandate set delegator_account_id = owner_account_id where delegator_account_id is null;
create index if not exists mandate_delegator_idx on mandate (delegator_account_id) where delegator_account_id is not null;

-- 에이전트 호출 권한 재설계 1단계 — 「이번 턴을 깨운 사람」(principal)을 서버가 적어 둔다(소유자 결정 2026-10-30).
-- 판정은 아직 이 값을 쓰지 않는다. 읽는 곳은 services/invokePrincipal.ts 하나이고, 쓰임은 mention 호출 판정뿐이다
-- (머지 래퍼의 사람 원인 판정·권한 승인·비밀·연쇄 깊이에는 쓰지 않는다).
-- 턴 임대: 발급 때 원인 글에서 해석한 사람. 모르면 null.
alter table secret_turn_lease add column principal_account_id uuid references account(id) on delete set null;
-- 에이전트 글: 그 글을 쓴 턴의 살아 있는 임대에서 옮겨 적는다. 다음 에이전트의 임대가 이 값을 이어받는다.
alter table message add column principal_account_id uuid references account(id) on delete set null;

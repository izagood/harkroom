-- 백그라운드 턴 G1 · BG4 히스토리(설계 harkroom://message/4a44f18a 4절).
-- - agent_config.bg_enabled: 소유자의 「백그라운드 정리」 토글. 전역 스위치(HARKROOM_BACKGROUND_ENABLED)가 켜져 있어도
--   이것이 꺼진 에이전트에는 일감을 넣지 않는다. 기본 켬 — 전역 스위치가 기본 꺼짐이라 기본값이 비용을 만들지 않는다.
-- - bg_job.reverted_at·reverted_by: [이 회차 되돌리기]를 한 번만 한다(두 번 누르면 이미 되돌린 판을 다시 덮는다).
alter table agent_config add column bg_enabled boolean not null default true;
alter table bg_job add column reverted_at timestamptz null;
alter table bg_job add column reverted_by uuid null references account(id) on delete set null;

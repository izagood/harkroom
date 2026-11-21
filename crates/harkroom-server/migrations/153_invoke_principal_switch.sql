-- 에이전트 호출 권한 재설계 3단계 — principal(이번 턴을 깨운 사람)로 mention 부름을 연다(소유자 결정 2026-10-30, 기본 켜짐).
-- 원인 inbox 사유는 서버 집계에만 쓴다 — 메시지 meta 는 채널을 보는 모두에게 가므로 거기서 뺀다(보안 검토 n1).
alter table message add column principal_cause_reasons text[];
-- principal 별 하루 상한(services/invokePrincipal.ts PRINCIPAL_INVOKE_DAILY_CAP)을 셀 때 쓴다.
create index message_principal_recent_idx on message (principal_account_id, created_at) where principal_account_id is not null;

-- 매일 기억 정리를 기본 기능으로 — 자동화·소유자 승인 없이 서버가 에이전트마다 하루 한 번 정리 회차(bg_job kind 'cleanup')를 넣는다.
-- - workspace_profile: 워크스페이스 켜짐(기본 켬)·시각·시간대.
-- - agent_config.memory_cleanup_on: 에이전트별 끄기(기본 켬). bg_enabled(증류·구조 정리)와 따로다.
-- - bg_job.not_before: 매일 정리 회차가 집힐 수 있는 때(에이전트마다 흩어 놓은 시각). null 이면 옛 회차(밤 창에서만 집힌다).
alter table workspace_profile add column memory_cleanup_on boolean not null default true;
alter table workspace_profile add column memory_cleanup_time time not null default '03:00';
alter table workspace_profile add column memory_cleanup_tz text not null default 'Asia/Seoul';
alter table agent_config add column memory_cleanup_on boolean not null default true;
alter table bg_job add column not_before timestamptz null;

-- 이미 있는 기억 정리 자동화는 「기본 기능으로 대체됨」으로 끈다(지우지 않는다 — 사람이 다시 켤 수 있다). 제안 틀의 고정 문장으로만 고른다.
-- 위임장은 자동화를 끌 때와 같이 끝낸다.
with off as (
  update automation set enabled = false, next_at = null, paused_reason = 'replaced_by_builtin', updated_at = now()
   where deleted_at is null and trigger->>'kind' = 'schedule'
     and body like '%기억 정리 시간이다. 지시문의 「정리하는 법」 그대로 한다.%'
  returning id),
ended as (
  update mandate set ended_at = now(), end_reason = 'automation_off'
   where ended_at is null and automation_id in (select id from off)
  returning id)
update mandate_line set revoked_at = now()
 where revoked_at is null and mandate_id in (select id from ended);

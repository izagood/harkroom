-- 원격 호스트 관리 P2b(스레드 3b0f0255).
--
-- 1. 오퍼레이터 업그레이드 이력(H3). 오퍼레이터가 `upgrade.progress` 로 단계마다 알리고, 서버가 한 줄씩
--    적는다. 화면은 「업그레이드 중 · 받는 중」과 「자동 되돌림 이력」을 여기서 읽는다. 박동(지금의 사실)과
--    달리 **기록**이다 — 꺼진 머신에서 무엇이 실패했는지가 남아야 한다. 오퍼레이터마다 최근 20줄만 둔다.
--    `error` 는 오퍼레이터가 쓴 짧은 사유이고 소유자·operator.manage 에게만 보인다.
create table operator_upgrade (
  id           bigserial primary key,
  operator_id  uuid not null references operator(id) on delete cascade,
  stage        text not null check (stage in ('download', 'verify', 'unpack', 'restart', 'healthy', 'failed', 'rolled_back')),
  from_version text,
  to_version   text,
  error        text,
  at           timestamptz not null default now()
);
create index operator_upgrade_op_idx on operator_upgrade (operator_id, id desc);

-- 2. 맥 전용 에이전트 표시(v3). 시뮬레이터·macOS 빌드·스크린샷이 필요한 에이전트다. **막지 않는다** —
--    리눅스 오퍼레이터에 배정해도 서버는 받고, 화면이 경고만 한다(jaebin 결정, 카드 f3daebec).
alter table agent_config add column requires_macos boolean not null default false;

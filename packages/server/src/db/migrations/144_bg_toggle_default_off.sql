-- 백그라운드 정리 토글(132 agent_config.bg_enabled) 기본값을 끔으로 — 메모리 체계화 O2 P0-b(설계 harkroom://message/dfad81b8,
-- jaebin 「넷만 먼저」). 기본 켬이면 전역 스위치(HARKROOM_BACKGROUND_ENABLED)를 넣는 순간 claude 에이전트 전부가 대상이 되고,
-- 시험 중 새로 만든 에이전트까지 끼어든다. 그래서 새 행도 기존 행도 끔으로 두고, 켤 에이전트는 소유자가
-- REST(PUT /accounts/agents/:id/background)로 켠다 — 감사 기록(agent.background.toggled)에 남는다.
-- 아직 스위치를 켠 적이 없어(운영 회차 0) 기존 행을 끄는 것이 지금 동작을 바꾸지 않는다.
alter table agent_config alter column bg_enabled set default false;
update agent_config set bg_enabled = false where bg_enabled;

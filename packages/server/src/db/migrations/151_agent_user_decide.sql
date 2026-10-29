-- 소유자가 아닌 사용자도 권한·머지 카드를 정한다(소유자 결정 2026-10-29). 판정은 services/deciders.ts.
-- 에이전트마다 그것을 끄는 비상 스위치 — 기본은 켜짐이다. 끄면 그 에이전트의 카드는 다시 소유자만 정한다.
alter table agent_config add column user_decide boolean not null default true;

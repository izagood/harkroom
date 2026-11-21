-- 에이전트 PAT 를 마지막으로 쓴 때(103) — 결정 harkroom 스레드 c4f4dab4(카드 35e8766d), security 판단 789b2375.
--
-- 러너는 v0.2.9(오퍼레이터 경로) 부터 PAT 를 쓰지 않는다 — 오퍼레이터 토큰(`hkop_`)과
-- `X-Harkroom-Agent` 로 선다. 그런데 서버는 에이전트 PAT 인증(viaPat)을 아직 받고, 누가 쓰고 있는지
-- 기록이 없었다. 이 칸을 2주 지켜본 뒤 PAT 인증 자체를 걷어낼지 정한다. 비어 있으면 그동안 아무도
-- 그 토큰으로 서지 않은 것이다(인증 훅이 성공할 때만 적는다 — auth/plugin.ts).
alter table pat add column last_used_at timestamptz null;

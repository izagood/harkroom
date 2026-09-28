-- 에이전트 러너 버전 추적(#129). 별도 테이블인 이유: 사람 계정에는 없는 개념이다
-- (004_agent_config.sql 주석 참고). 버전은 에이전트에만 있는 개념이므로 같은 논리를 따른다.
--
-- 버전과 마지막으로 본 시각을 같이 저장하는 이유: "지금 붙어 있는 러너의 버전"과 "3일 전에
-- 붙었던 러너의 버전"을 구분해야 한다. 009_agent_disable.sql 의 disabled_at 과 같은
-- 논리다 — 시각이면 null 이 '값이 없다'는 것을 명확히 표현한다.
--
-- 값이 바뀔 때만 쓴다. inbox.poll 이 최대 25초마다 부르는 핫 패스라 매번 쓰면 낭비다 —
-- 버전은 러너가 재시작할 때까지 그대로다(services/runnerVersion.ts 주석).
-- "지금 붙어 있나"는 이 테이블이 답하지 않는다. #124 의 인메모리 presence 가 답한다.
-- 이 값이 없는 에이전트는 아직 한 번도 버전을 보낸 적이 없는 것이다.
create table agent_runner_version (
  account_id uuid primary key references account(id) on delete cascade,
  version text not null,
  seen_at timestamptz not null default now()
);
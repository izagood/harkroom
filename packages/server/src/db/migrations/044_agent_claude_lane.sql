-- 러너의 claude 계정 lane(Agents 관제 5단계).
--
-- 왜 필요한가: #694 가 **도는 턴**에 어떤 계정을 쓰는지 보이게 했다. 그런데 턴이 없으면
-- 화면에 아무 말이 없다 — 사람이 계정 화면에서 순서를 바꿔도 러너가 그것을 집어 갔는지
-- 알 방법이 없고, 계정 화면의 "러너는 시작할 때 풀을 한 번 읽는다"는 안내가 **확인되지
-- 않는 주장**으로 남는다. 이 테이블은 그 주장을 사실로 바꾼다: 지금 붙어 있는 러너가
-- 기동 때 실제로 읽은 풀과 순서다.
--
-- 별도 테이블인 이유는 013_agent_runner_version.sql 과 같다 — 사람 계정에는 없는 개념이고
-- (004_agent_config.sql), 러너가 신고하는 값이라 PATCH 로는 바꿀 수 없다.
--
-- **왜 값이 pool + 순서뿐인가.** 지금 머리에 있는 계정은 여기 적지 않는다. 페일오버는
-- 턴 단위로 머리를 옮기고(withAccountFailover) 그 사실은 러너 메모리에만 있다 — 기동 때
-- 값을 적어 두면 넘어간 뒤에도 옛 계정을 주장하는 줄이 남는다. **지금 무엇으로 도는지는
-- 턴 줄(#694)이 답한다.** 이 테이블은 러너가 사는 동안 바뀌지 않는 것만 담는다.
--
-- 값이 바뀔 때만 쓴다. inbox.poll(최대 25초)이 나르는 값이라 매번 UPSERT 하면 에이전트당
-- 영구적인 쓰기가 된다 — lane 은 재시작할 때까지 그대로다(services/claudeLane.ts 주석).
--
-- pool 이 null 인 것과 계정이 0개인 것은 **다른 사실**이다: 앞은 풀 지정이 없는 것(암묵
-- 풀 = 뿌리)이고, 뒤는 풀이 비어 러너가 시스템 기본 로그인(~/.claude)으로 도는 것이다.
-- 화면이 그 둘을 다르게 그린다. 이 행이 아예 없으면 **모른다**(구 러너다).
create table agent_claude_lane (
  account_id uuid primary key references account(id) on delete cascade,
  pool text,
  accounts text[] not null,
  seen_at timestamptz not null default now()
);

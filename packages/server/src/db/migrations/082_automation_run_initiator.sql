-- 에이전트가 돌린 "지금 한 번"(MCP `automation.run`) — 회차에 **누가·무엇 때문에** 돌렸는지를 남긴다.
--
-- 왜 필요한가: 자동화 글은 승인한 사람(소유자) 이름으로 나간다. 사람이 쓴 글은 멘션 연쇄 깊이가
-- 0 이라(`mentionDepthFor`), 에이전트가 자동화를 돌릴 수 있게 되면 "에이전트 → 실행 → 사람 이름 글
-- (깊이 0) → 에이전트 → 실행…" 으로 연쇄 상한을 **세탁**할 수 있다. 그래서 에이전트가 만든 회차는
-- 그 에이전트의 깊이를 `chain_depth` 로 들고 가고, 발송이 그 값을 글에 물려준다.
--
-- `initiated_by` 는 실행한 에이전트다(사람이 버튼을 누른 회차·시계·외부 이벤트는 null). 에이전트별
-- 실행 상한(10분 1회·시간 3회)도 이 열로 센다. `cause_message_id` 는 그 턴을 띄운 소유자의 메시지 —
-- 이력 화면이 "누가 시켰나"로 링크한다. 메시지가 지워져도 회차 기록은 남는다.
alter table automation_run add column initiated_by uuid null references account(id) on delete set null;
alter table automation_run add column cause_message_id uuid null references message(id) on delete set null;
alter table automation_run add column chain_depth int null;

-- 원인 하나에 실행 한 번(security 검토) — "지금 돌려" 한 마디로 여러 번 돌지 못한다. 서비스가 먼저
-- 보고 거절하지만, 행 잠금이 자동화마다라 서로 다른 자동화로 동시에 오는 경합은 이 인덱스가 막는다.
create unique index automation_run_agent_cause on automation_run (cause_message_id)
  where initiated_by is not null and cause_message_id is not null;

create index automation_run_agent_recent on automation_run (automation_id, created_at desc)
  where initiated_by is not null;

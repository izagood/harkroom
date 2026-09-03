-- 채널이 특정 에이전트를 자동으로 멘션한다(#173).
--
-- 왜 channel_member 를 쓰지 않는가: channel_member 는 DM·private 채널의 **멤버십**(누가 이
-- 채널을 볼 수 있나) 의미다. 자동 멘션은 "이 채널에서 사람이 글을 쓰면 누구를 부르나"라는
-- 전혀 다른 사실이고, 표준 public 채널에는 멤버십 자체가 없다. 같은 표에 얹으면 가시성 계산
-- (channelVisibleSql)이 자동 멘션 행을 멤버로 읽어 private 채널의 문이 열린다.
--
-- PK 가 (channel_id, agent_account_id) 짝이므로 채널 하나에 자동 멘션 에이전트가 여럿일 수
-- 있다 — 스키마가 그 답이다. 대상이 에이전트 계정이어야 한다는 것과 비활성 에이전트를 넣을 수
-- 없다는 것은 두 표에 걸치는 규칙이라 제약으로 쓸 수 없고, 서비스의 삽입 문장이 강제한다.
--
-- on delete cascade: 채널이 사라지면 "그 채널이 누구를 부르나"는 뜻이 없다. 에이전트 쪽은
-- cascade 가 아니다 — 계정은 지우지 않고 비활성으로만 만드는 것이 이 저장소의 규칙이다
-- (009_agent_disable.sql).
create table channel_auto_mention (
  channel_id uuid not null references channel(id) on delete cascade,
  agent_account_id uuid not null references account(id),
  created_by uuid not null references account(id),
  created_at timestamptz not null default now(),
  primary key (channel_id, agent_account_id)
);

-- 위임 재설계 v1 P4 — 암묵 위임(에이전트가 에이전트를 맨 앞 멘션으로 부름)의 판정 기록. 스위치 `HARKROOM_DELEGATION_V2` 뒤.
--
-- 소유자 결정(2026-11-09): 에이전트→에이전트 맨 앞 멘션은 모두 암묵 위임이고, 처음 1주는 **그림자 모드**다 — 판정만 적고
-- 깨우기·update 에는 쓰지 않는다. 그 동안 위임자 턴이 얼마나 늘지(암묵 위임 수/일, 짧은 질문 비율)를 이 표로 잰다.
--
-- 왜 `team_delegation` 에 바로 쓰지 않나: 위임 표는 P3 의 수명·update·기한 스위퍼·요약·라운드 상한이 모두 읽는다. 그림자 행을
-- 거기 두면 그 모든 자리에 「그림자는 빼라」를 걸어야 하고, 하나라도 빠뜨리면 그림자가 위임자를 깨운다. 그래서 판정은 이 표에만
-- 적고, 모드를 `on` 으로 올렸을 때만 진짜 위임 행(kind=mention)을 열어 `delegation_id` 로 잇는다.
create table delegation_implicit_log (
  id uuid primary key default gen_random_uuid(),
  -- 부른 글. 같은 글이 여러 에이전트를 부르면 담당마다 한 줄.
  message_id uuid not null references message(id) on delete cascade,
  channel_id uuid not null references channel(id) on delete cascade,
  thread_root_id uuid not null references message(id) on delete cascade,
  delegator_account_id uuid not null references account(id) on delete cascade,
  delegate_account_id uuid not null references account(id) on delete cascade,
  -- `open`: 위임을 연다(그림자면 열었을 것). `reply`: 반대 방향 위임이 열려 있어 답장으로 봤다.
  -- `existing`: 같은 방향 위임이 이미 열려 있어 새로 열지 않았다(이어지는 말).
  verdict text not null check (verdict in ('open', 'reply', 'existing')),
  -- 그 순간의 모드. `shadow` 면 아무 행도 열지 않았다.
  mode text not null check (mode in ('shadow', 'on')),
  -- 계획판 단계에서 그 단계의 담당을 불렀으면 그 단계 id.
  plan_step_id text check (plan_step_id ~ '^s[1-9][0-9]{0,3}$'),
  -- 지표: 짧은 질문(머리 멘션을 뺀 본문이 짧고 물음표가 있다). 짧은 질문까지 위임이 되면 위임자 턴만 는다.
  short_question boolean not null,
  body_chars integer not null check (body_chars >= 0),
  -- 모드 `on` 에서 실제로 연 위임.
  delegation_id uuid references team_delegation(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((delegation_id is null) or (mode = 'on' and verdict = 'open'))
);
-- message 외래키 앞자리 색인(123). thread_root_id 색인은 반대 방향·이어짐 판정도 쓴다.
create index delegation_implicit_log_message on delegation_implicit_log (message_id);
create index delegation_implicit_log_thread on delegation_implicit_log (thread_root_id, created_at);
create index delegation_implicit_log_channel on delegation_implicit_log (channel_id);
create index delegation_implicit_log_delegator on delegation_implicit_log (delegator_account_id);
create index delegation_implicit_log_delegate on delegation_implicit_log (delegate_account_id);
create index delegation_implicit_log_delegation on delegation_implicit_log (delegation_id) where delegation_id is not null;
-- 일별 집계(암묵 위임 수/일).
create index delegation_implicit_log_created on delegation_implicit_log (created_at);

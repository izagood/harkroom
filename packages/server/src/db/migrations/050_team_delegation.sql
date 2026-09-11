-- 위임 왕복 — **팀장이 넘긴 일이 끝나면 팀장이 다시 깬다**(에이전트 팀 3단계).
--
-- 046 이 팀장 자리를 만들고 047 이 팀 부름을 팀장 하나로 좁혔다. 그래서 지금 팀장은
-- 나눌 수는 있지만(`@팀원` 멘션) **나눈 것이 돌아오지 않는다**: 팀원이 스레드에 답해도
-- 팀장은 깨지 않는다(`thread_reply` 는 스레드 루트 작성자에게만 간다). 그 공백 때문에
-- 047 의 프롬프트는 팀장에게 *"넘긴 답을 기다리지는 마라"* 고 적어야 했다.
--
-- ## 왜 표가 필요한가 — meta 로는 안 된다
--
-- 구조는 `ask`(043)와 같다: 의무를 남기는 말이고, 상대가 답하면 낸 쪽이 깬다. 다만 `ask`
-- 는 답이 **하나**라 `meta.ask.answeredWith` 한 자리로 끝났고, `where answeredWith is null`
-- 이 경합에서 진 쪽을 걸러 줬다. 위임은 상대가 **N 명**이다. jsonb 배열에 담으면 팀원 둘이
-- 동시에 답할 때 읽고-고쳐-쓰기가 서로를 덮는다(lost update). 그래서 **한 명당 한 행**이다.
--
-- ## `deadline_at` 이 이 표에 있는 이유
--
-- 팀원이 죽으면(API 오류·러너 부재·사람이 턴을 중단) 아무 신호도 오지 않을 수 있다. 그때
-- 팀장은 기다리는 것이 아니라 **없다** — 위임하고 턴이 끝나면 그 프로세스는 죽는다. 즉
-- 깨어 있는 쪽이 아무도 없으므로 스스로 알아챌 수 없고, 되살리는 길은 예약된 시각 하나다.
--
-- `agent_wake`(040)를 쓰지 않는다: 그 표의 sweep 은 `reason = 'wake'` 항목을 만드는데,
-- 기한이 지난 팀장에게 필요한 것은 **결말 목록**(누가 끝냈고 누가 무응답인가)이다. 사유를
-- 뭉치면 러너가 그 목록을 프롬프트에 못 싣는다 — 043 이 `wake` 를 재사용하지 않은 자리와
-- 같은 판단이다.
--
-- ## `thread_root_id` 를 저장하는 이유 (040 은 안 저장했다)
--
-- 040 은 *"앵커를 두 번 저장하지 않는다"* 며 메시지에서 되찾았다. 여기서는 저장한다 —
-- **라운드를 세는 술어가 스레드 단위**이고(사람의 마지막 발화 이후 이 팀장이 만든 위임 수),
-- 닫힘 판정도 *"이 스레드에서 이 팀원이 답했는가"* 다. 매번 join 으로 되찾으면 그 두
-- 핫 술어가 message 를 다시 읽어야 하고, 스레드 앵커는 만들어진 뒤 바뀌지 않는 값이다.
create table team_delegation (
  id uuid primary key default gen_random_uuid(),
  -- 위임을 선언한 그 메시지. inbox 항목은 이 메시지를 가리키므로(043 의 "물음 자신"과
  -- 같은 규약) 러너는 그것으로 결말을 되찾는다.
  message_id uuid not null references message(id) on delete cascade,
  team_id uuid not null references agent_team(id) on delete cascade,
  lead_account_id uuid not null references account(id),
  channel_id uuid not null references channel(id) on delete cascade,
  thread_root_id uuid not null,
  deadline_at timestamptz not null,
  -- 팀장을 깨웠는가. **한 번만 깨운다**(미결 0 또는 기한 경과, 둘 중 먼저 온 것 하나).
  -- 이 컬럼이 그 "한 번"을 지키는 자리이고, 기한 스위퍼도 이것으로 이미 끝난 위임을 건너뛴다.
  notified_at timestamptz,
  created_at timestamptz not null default now()
);

create index team_delegation_thread_idx on team_delegation (thread_root_id, lead_account_id);
-- 기한 스위퍼의 술어를 그대로 담는다. 미결 위임은 정상 운영에서 거의 비어 있으므로 부분 인덱스다.
create index team_delegation_due_idx on team_delegation (deadline_at) where notified_at is null;

-- 의무 하나 = **팀원 한 명**.
--
-- `outcome` 이 null 인 것이 미결이다. 값이 셋인 이유는 팀장이 다음에 할 일이 갈리기
-- 때문이다: `done` 은 취합하면 되고, `failed` 는 그 일을 누가 대신할지 정해야 하고,
-- `timeout` 은 그 팀원이 살아 있는지조차 모른다. 하나로 뭉치면 팀장이 "다시 넘길지"를
-- 판단할 근거가 사라진다.
create table team_delegation_item (
  delegation_id uuid not null references team_delegation(id) on delete cascade,
  delegate_account_id uuid not null references account(id),
  outcome text check (outcome in ('done', 'failed', 'timeout')),
  -- 무엇이 이 의무를 닫았는가. 결말이 `timeout` 이면 닫은 메시지가 없다(null).
  closed_by_message_id uuid references message(id) on delete set null,
  closed_at timestamptz,
  primary key (delegation_id, delegate_account_id)
);

-- 닫힘 훅의 술어: "이 스레드에서 이 팀원에게 미결 의무가 있는가". 발화마다 도는 경로라
-- 인덱스가 있어야 한다 — 없으면 모든 발화가 이 표를 전수 훑는다.
create index team_delegation_item_open_idx on team_delegation_item (delegate_account_id)
  where outcome is null;

-- 새 사유 둘. 040·043·045·047 과 같은 규칙이다 — **러너가 프롬프트를 다르게 조립해야 하면
-- 사유를 가른다.**
--
-- `team_delegated`: 팀장이 넘긴 일이다. 그 팀원의 턴은 *"최종 답은 팀장이 쓴다"* 를 알아야
-- 하고(그 문구가 화면의 접힘까지 만든다 — `agentExchange.addressesHuman`), 평범한 멘션으로
-- 뭉치면 그 사실이 전달되지 않는다.
--
-- `delegation_done`: 넘긴 일의 **결말**이 나왔다. 미결이 0 이 되었거나 기한이 지났다.
-- 러너는 이 사유에서 결말 목록을 프롬프트에 싣는다.
alter table inbox drop constraint inbox_reason_check;
alter table inbox add constraint inbox_reason_check
  check (reason in ('mention', 'thread_reply', 'dm', 'wake', 'ask_answered', 'ask_closed',
                    'team_mention', 'team_delegated', 'delegation_done'));

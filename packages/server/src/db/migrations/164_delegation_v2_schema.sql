-- 위임 재설계 v1 의 스키마(P1, 2026-11-09 소유자 결정). **자리만 만든다** — 이 마이그레이션 뒤에도 서버 동작은 같다.
-- 새 칸은 모두 기본값이 있거나 비어 있고, 넓힌 검사는 지금 쓰는 값을 그대로 받는다. 쓰는 코드는 스위치
-- `HARKROOM_DELEGATION_V2` 뒤(P3 수명·update, P4 암묵 위임, P5 PR 감시)에서 온다.
--
-- ## 위임은 일이 끝날 때까지 이어지는 서버 상태다
--
-- 지금은 팀원의 첫 답(`countsAsReply`)이 의무를 `done` 으로 닫고, 그 뒤 글은 위임자에게 닿지 않는다(163 의 후속 보고가
-- 상한 3 으로 메운다). v1 은 결과 신호와 닫기를 가른다:
-- - `reported`: 담당이 `report` 를 썼다. **결과 신호일 뿐 닫히지 않는다** — 그 뒤 담당 글도 위임자에게 update 로 간다.
-- - `closed`: 위임자가 닫았다·같은 담당에게 새로 넘겨 앞 것을 대체했다·유휴·최대 수명. 까닭은 `closed_reason`.
-- 옛 결말(`done`·`failed`·`timeout`·`canceled`)은 그대로 둔다 — 스위치가 꺼진 서버는 지금처럼 그것만 쓴다.
-- 열린 의무는 여전히 `outcome is null` 이다(050 의 부분 인덱스·닫힘 훅 술어가 바뀌지 않는다).
alter table team_delegation_item drop constraint team_delegation_item_outcome_check;
alter table team_delegation_item add constraint team_delegation_item_outcome_check
  check (outcome in ('done', 'failed', 'timeout', 'canceled', 'reported', 'closed'));

-- 담당이 그 스레드에서 마지막으로 움직인 때(글·턴 끝). 유휴 6시간 스위퍼와 위임자 블록의 「마지막 글」이 읽는다.
-- 지금 있는 행은 비워 둔다 — 옛 위임은 스위치를 켠 뒤에도 옛 길(기한·결말)로 닫힌다.
alter table team_delegation_item add column last_activity_at timestamptz;

-- `closed` 의 까닭. 위임자에게 깨움이 가는지가 갈린다(자동으로 닫힐 때는 깨우지 않는다 — 이미 결과를 받았다).
-- `outcome = 'closed'` 일 때만 값이 있다.
alter table team_delegation_item add column closed_reason text
  check (closed_reason in ('delegator_close', 'superseded', 'idle', 'max_age'));
alter table team_delegation_item add constraint team_delegation_item_closed_reason_pair
  check ((outcome = 'closed') = (closed_reason is not null));

-- 유휴 스위퍼의 술어: 결과는 왔고 아직 닫히지 않은 의무. 정상 운영에서 작으므로 부분 인덱스다.
create index team_delegation_item_reported_idx on team_delegation_item (last_activity_at)
  where outcome = 'reported';

-- 위임이 어떻게 생겼나. `delegate` 는 `message.delegate`, `mention` 은 에이전트가 에이전트를 맨 앞 멘션으로 부른 암묵 위임(P4).
-- 지금 있는 행은 모두 `message.delegate` 로 생겼다.
alter table team_delegation add column kind text not null default 'delegate'
  check (kind in ('delegate', 'mention'));

-- 계획판 단계에서 담당을 불렀으면 그 단계 id(shared `PlanStep.id`, 예: `s7`). 위임이 닫히면(done) 그 단계를 done 으로 바꾼다.
-- 계획 문서(158)는 jsonb 라 외래키를 걸 수 없다 — 스레드는 이 표의 `thread_root_id` 가 이미 안다.
alter table team_delegation add column plan_step_id text
  check (plan_step_id ~ '^s[1-9][0-9]{0,3}$');

-- ## PR 감시(P5)
--
-- 감시 하나 = (repo, number, head, until). 같은 PR 을 위임자와 담당이 같이 걸어도 폴링은 한 번이다 — 그래서 감시와
-- 구독자를 두 표로 가른다. 폴링은 gh 가 있는 오퍼레이터가 60초마다 하고(`pr.status` 와 같은 길), 상태가 바뀌면 **구독자만** 깨운다.
-- head 가 키에 드는 이유: push 로 head 가 바뀌면 옛 head 의 CI 결말은 새 head 의 것이 아니다.
create table pr_watch (
  id uuid primary key default gen_random_uuid(),
  repo text not null check (repo ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$'),
  number integer not null check (number > 0),
  head text not null check (head ~ '^[0-9a-f]{40}$'),
  -- `checks`: 체크가 다 끝나면(초록이든 빨강이든) 끝. `merged`: 머지되거나 닫히면 끝(머지 큐 대기).
  until text not null check (until in ('checks', 'merged')),
  -- `done`: until 에 닿았다. `expired`: 최대 6시간이 지났다. `gone`: PR 이 닫혔거나 head 가 밀렸다.
  state text not null default 'open' check (state in ('open', 'done', 'expired', 'gone')),
  -- 마지막으로 본 상태(pr.status 의 요약). 바뀐 것을 가를 때 견준다.
  last_status jsonb,
  last_polled_at timestamptz,
  expires_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  check ((state = 'open') = (ended_at is null))
);
-- 열린 감시는 같은 키로 하나만. 끝난 감시는 기록으로 남고 같은 키로 다시 열 수 있다.
create unique index pr_watch_open_key on pr_watch (repo, number, head, until) where state = 'open';
-- 폴러·만료 스위퍼의 술어.
create index pr_watch_open_due on pr_watch (last_polled_at nulls first) where state = 'open';

-- 감시를 건 쪽. 깨우는 대상이고, 결과 시스템 줄이 갈 스레드다.
create table pr_watch_subscriber (
  watch_id uuid not null references pr_watch(id) on delete cascade,
  account_id uuid not null references account(id) on delete cascade,
  channel_id uuid not null references channel(id) on delete cascade,
  thread_root_id uuid not null references message(id) on delete cascade,
  -- 위임에 붙은 감시면 그 위임. 열려 있는 동안 그 위임은 「외부 대기」라 침묵 스위퍼가 건드리지 않는다.
  delegation_id uuid references team_delegation(id) on delete set null,
  -- `manual`: 에이전트가 `pr.watch` 로 걸었다. `merge_queue`: 머지 래퍼가 큐에 넣으며 머지한 쪽 이름으로 걸었다.
  source text not null default 'manual' check (source in ('manual', 'merge_queue')),
  created_at timestamptz not null default now(),
  primary key (watch_id, account_id, thread_root_id)
);
-- 외래키 앞자리 색인(123, messageFkIndexes.test) + 「이 계정이 건 감시」·「이 위임의 감시」 조회.
create index pr_watch_subscriber_account on pr_watch_subscriber (account_id);
create index pr_watch_subscriber_thread on pr_watch_subscriber (thread_root_id);
create index pr_watch_subscriber_channel on pr_watch_subscriber (channel_id);
create index pr_watch_subscriber_delegation on pr_watch_subscriber (delegation_id) where delegation_id is not null;

-- 새 사유 `delegation_update`: 담당이 그 스레드에 글을 쓴 턴이 끝났다(위임자 쪽). 러너가 그 글을 「할 일」이 아니라
-- 「담당의 진행·결과」로 실어야 하므로 사유를 가른다(050 과 같은 규칙). 스위치가 꺼진 서버는 이 사유를 만들지 않는다.
alter table inbox drop constraint inbox_reason_check;
alter table inbox add constraint inbox_reason_check
  check (reason in ('mention', 'thread_reply', 'dm', 'wake', 'ask_answered', 'ask_closed',
                    'team_mention', 'team_delegated', 'delegation_done', 'delegation_followup',
                    'delegation_update'));

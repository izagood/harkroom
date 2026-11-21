-- 깨움(wake) — 에이전트가 **자기를 나중에 깨우는** 예약.
--
-- 왜 필요한가: 러너의 멘션 턴은 `claude -p` 한 번이고, 모델이 말을 멈추면 프로세스가
-- 죽는다. 그와 함께 백그라운드로 띄운 대기(CI 폴링 등)도 죽는다 — 2026-09-07 15:08 에
-- PR #533 을 올린 턴이 "CI 결과 나오면 머지하겠다"고 백그라운드 루프를 띄우고 끝나
-- 그대로 잃은 것이 이것이다. 스레드별 하네스 세션은 이미 디스크에 살아남아 `-r` 로
-- 재개되므로(agent/src/turn.ts), 빠진 조각은 **깨우는 시계**뿐이었다.
--
-- 왜 scheduled_message(028) 를 재사용하지 않는가: 그 테이블은 "이 본문을 나중에
-- **보낸다**"이고, 발송 전까지 작성자 말고 누구에게도 보이지 않는 것이 존재 이유다.
-- 깨움은 "이미 보인 이 줄을 근거로 나중에 나를 **부른다**"이고, 반대로 **지금 당장
-- 보여야** 한다 — 사람이 "죽었나 기다리나"를 아는 유일한 근거이기 때문이다. 두 요구가
-- 정반대라 한 테이블에 담으면 가시성 규칙이 행마다 갈린다.
--
-- 그래서 깨움은 메시지를 **미리** 만들고(kind='wake', 즉시 보인다) 이 테이블은 그
-- 메시지를 가리키는 시계만 갖는다. 시각이 되면 sweep 이 그 메시지로 inbox 항목을 만들어
-- 러너의 기존 경로(inbox.poll → 멘션 턴 → 세션 resume)를 그대로 태운다.
alter table message drop constraint message_kind_check;
alter table message add constraint message_kind_check
  check (kind in ('user', 'system', 'progress', 'wake'));

-- inbox 의 사유를 넓힌다. 새 사유가 필요한 이유: 러너는 'mention' 과 'wake' 를 **다르게**
-- 조립해야 한다 — 깨움에는 새 사람 발화가 없어서 프롬프트가 비고(prompt.ts 의
-- buildTurnPrompt 가 자기 발화를 걸러낸다), 비면 하네스를 아예 돌리지 않는다.
alter table inbox drop constraint inbox_reason_check;
alter table inbox add constraint inbox_reason_check
  check (reason in ('mention', 'thread_reply', 'dm', 'wake'));

create table agent_wake (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id),
  channel_id uuid not null references channel(id),
  -- 이미 게시된 wake 메시지. inbox 항목이 이것을 가리키므로 러너가 앵커(thread_root_id)를
  -- 그 메시지에서 그대로 되찾는다 — 앵커를 여기 또 저장하면 두 번째 진실 원천이 된다.
  message_id uuid not null references message(id),
  wake_at timestamptz not null,
  created_at timestamptz not null default now(),
  fired_at timestamptz null,
  canceled_at timestamptz null
);

-- 아직 깨우지 않은 것만 훑는다. 인덱스 조건이 sweep 의 where 절과 같다(028 과 같은 모양).
create index agent_wake_due on agent_wake (wake_at)
  where fired_at is null and canceled_at is null;

-- 한 메시지에 시계는 하나다. sweep 이 중복 삽입해도 inbox 가 두 번 생기지 않게 하는 것은
-- fired_at 이지만, 예약 자체가 두 번 걸리는 것은 여기서 막는다.
create unique index agent_wake_message on agent_wake (message_id);

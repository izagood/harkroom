-- 자동화(automation) — "무슨 일이 생기면 → 만든 사람 이름으로 정해 둔 채널/DM 에 글을 쓴다".
--
-- 왜 필요한가: "매주 월요일 지난주 회사일 정리" 같은 반복 요청을 사람이 매번 치고 있었다.
-- 예약 메시지(028)는 **한 번** 보내고 30일 안쪽만 받는다. 반복은 그 위에 규칙을 얹는 것이
-- 아니라 트리거(시간·GitHub·범용 hook)가 여러 갈래라 따로 둔다.
--
-- 왜 액션이 "글을 쓴다" 하나뿐인가: 에이전트 턴을 직접 띄우는 새 경로를 만들면 멘션 inbox·
-- 진행 표시·stale 알림·턴 중단이 전부 두 벌이 된다. 글 한 줄이 `postMessage` 를 그대로
-- 통과하면 그 모두가 사람이 친 것과 똑같이 따라온다. "무엇을 할지"는 본문과 에이전트 기억이 정한다.
--
-- 왜 트리거가 jsonb 인가: 종류마다 필드가 다르고(schedule 은 요일·시각·tz, github 은
-- repo·branch·paths) 검증은 zod 가 한 곳(shared 스키마)에서 한다. 컬럼으로 펼치면 종류가
-- 늘 때마다 마이그레이션이 는다.
create table automation (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references account(id),
  -- 채널이 지워지면 자동화도 사라진다 — 보낼 곳이 없으니 남길 이유가 없다. cascade 라
  -- `deleteChannel` 의 명시 목록에 넣지 않아도 된다(channelDelete 스키마 대조 테스트).
  channel_id uuid not null references channel(id) on delete cascade,
  name text not null,
  body text not null,
  trigger jsonb not null,
  enabled boolean not null default true,
  -- schedule 트리거의 다음 회차. 다른 트리거는 null 이다(외부 이벤트가 온다).
  next_at timestamptz null,
  -- 자동 일시정지 사유(post_refused:<code> · rate_limited · failures). 사람이 다시 켜면 비운다.
  paused_reason text null,
  consecutive_failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index automation_due on automation (next_at)
  where enabled and deleted_at is null and next_at is not null;
create index automation_owner on automation (owner_id) where deleted_at is null;

-- 회차(run) 원장. 트리거는 run 을 **만들기만** 하고, 발송은 별도 단계가 한다 — 발송 도중
-- 프로세스가 죽어도 `pending` 이 남아 다음 sweep 이 이어 보낸다.
-- `(automation_id, event_key)` 가 유일해서 같은 회차·같은 GitHub delivery 가 두 번 오지 않는다.
create table automation_run (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automation(id) on delete cascade,
  event_key text not null,
  trigger_kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  -- 메시지가 지워져도 회차 기록은 남는다.
  message_id uuid null references message(id) on delete set null,
  error text null,
  created_at timestamptz not null default now(),
  finished_at timestamptz null,
  unique (automation_id, event_key)
);

create index automation_run_pending on automation_run (created_at) where status = 'pending';
create index automation_run_recent on automation_run (automation_id, created_at desc);

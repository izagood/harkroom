-- 예약 메시지 테이블(#222).
--
-- 왜 message 테이블에 상태 플래그를 두지 않는가: message.seq 는 채널 안 순서고, 아직
-- 발송되지 않은 메시지가 seq 를 먼저 점유하면 다른 사람의 실시간 뷰에 구멍이 생긴다.
-- 예약 메시지는 발송 전에는任何人에게 보여서는 안 되므로 별도 테이블이 필요하다.
--
-- partial index 인 이유: 발송 완료·실패·취소된 행은 스캔할 필요가 없다. sweep 은
-- where 절에 같은 조건을 걸어 인덱스를 탄다.
create table scheduled_message (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channel(id),
  author_id uuid not null references account(id),
  thread_root_id uuid null references message(id),
  body text not null,
  send_at timestamptz not null,
  created_at timestamptz not null default now(),
  sent_message_id uuid null references message(id),
  failed_reason text null,
  canceled_at timestamptz null
);

-- 발송 대기 중인 것만 효율적으로 찍어 온다. 인덱스 조건이 sweeper 의 select 와 같다.
create index scheduled_message_due on scheduled_message (send_at)
  where sent_message_id is null and failed_reason is null and canceled_at is null;
-- 채널 단위 읽음 위치. inbox.read_at 과 다른 것을 센다:
--   inbox  = "나를 부른 것"(멘션·DM·스레드 답글) 하나하나의 읽음 여부
--   여기   = "이 채널을 어디까지 봤나" — 부르지 않은 대화의 미읽음과 "여기부터 안 읽음" 구분선
--
-- 006 은 첨부파일용으로 병렬 세션이 예약했다.
create table channel_read (
  account_id uuid not null references account(id),
  channel_id uuid not null references channel(id),
  -- 이 seq 까지 봤다. 0 은 "아무것도 안 봤다"이며 메시지 seq 는 1부터 시작한다.
  last_read_seq bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, channel_id)
);

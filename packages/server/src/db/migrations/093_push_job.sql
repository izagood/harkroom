-- 모바일 푸시 2단계: 발송 대기열(outbox). 설계 harkroom://message/80130503-ca6c-4873-8bfe-3084ee182052,
-- security 반영본 harkroom://message/9e6faa09-2be1-4eb6-b5c6-f3d142ef0a10.
--
-- inbox 를 만드는 **같은 트랜잭션**에서 넣는다(`insertInbox`). 그래서 "알림을 받은 사람"과 "푸시가
-- 갈 사람"이 갈라지지 않는다. 롤백된 글은 job 도 없다. 실제 전송은 worker 가 커밋 뒤에 한다.
-- 네트워크(APNs)를 트랜잭션 안에서 기다리지 않기 위해서다.
--
-- `not_before` 기본값 15초(결정 5): 데스크톱에서 그 사이에 읽으면 폰은 울리지 않는다. worker 는 보내기
-- **직전에** 받는 사람·글·채널·inbox 를 다시 확인한다(security G1·G2). 여기 적힌 것은 "보낼지도
-- 모른다"일 뿐이다.
--
-- `inbox_id` 가 비면 inbox 를 거치지 않는 사유다(`ask` — to:human 물음은 받는 사람이 정해져 있지 않아
-- inbox 를 만들지 않는다. 차례 주인에게만 보낸다, G4).
-- `device_id` 가 차 있으면 그 기기 하나만 다시 보내는 재시도다(429·5xx).
create table push_job (
  id bigint generated always as identity primary key,
  account_id uuid not null references account(id),
  message_id uuid not null references message(id),
  inbox_id bigint references inbox(id) on delete cascade,
  device_id uuid references push_device(id) on delete cascade,
  reason text not null check (reason in ('mention', 'thread_reply', 'dm', 'ask')),
  attempts int not null default 0,
  not_before timestamptz not null default now() + interval '15 seconds',
  created_at timestamptz not null default now()
);

create index push_job_due_idx on push_job (not_before);

-- 신고와 차단(사용자 생성 콘텐츠 관리).
--
-- message_report: 멤버가 메시지를 관리자에게 알린다. 한 사람이 같은 메시지를 두 번 신고하지
-- 않는다(unique). 처리는 관리자가 한다 — resolved_at·resolved_by·resolution 이 함께 찍힌다.
-- 메시지·신고자 행은 soft delete 라 cascade 는 거의 돌지 않지만, 진짜 delete 가 생겨도 고아가 남지 않게 건다.
create table message_report (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references message(id) on delete cascade,
  reporter_id  uuid not null references account(id) on delete cascade,
  reason       text not null check (reason in ('spam', 'abuse', 'inappropriate', 'other')),
  note         text null check (note is null or char_length(note) <= 1000),
  -- 신고한 순간의 본문과 그때의 수정 시각. 큐는 지금 본문과 함께 보여 준다 — 신고된 사람이 글을 고치거나
  -- 지워 증거를 바꾸지 못하게. 처리 뒤 보관 기간은 처리방침이 정한다(정리는 따로).
  body_snapshot     text not null,
  message_edited_at timestamptz null,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz null,
  resolved_by  uuid null references account(id),
  resolution   text null check (resolution is null or resolution in ('dismissed', 'removed')),
  check ((resolved_at is null) = (resolution is null)),
  unique (message_id, reporter_id)
);
-- 관리자 큐는 "아직 처리 안 한 것, 오래된 순"으로 읽는다.
create index message_report_open on message_report (created_at, id) where resolved_at is null;
-- 신고자별 상한을 시간 창으로 센다(라우트).
create index message_report_reporter on message_report (reporter_id, created_at);

-- account_block: blocker 가 blocked 를 차단했다. 차단은 **blocker 의 화면과 알림**에서 상대를 지운다 —
-- 상대에게는 알리지 않는다. 자기 자신은 막지 않는다.
create table account_block (
  blocker_id  uuid not null references account(id) on delete cascade,
  blocked_id  uuid not null references account(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index account_block_blocked on account_block (blocked_id);

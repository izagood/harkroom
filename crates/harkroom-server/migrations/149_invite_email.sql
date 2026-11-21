-- 초대 메일(2026-10-27): 초대를 받는 사람의 이메일로 토큰을 보낸다.
--
-- ① `email` — 받는 사람 주소(소문자로 다듬은 값). **저장만 한다** — 가입을 이 주소로 묶지 않는다(jaebin 결정).
--    목록·재발송에 쓴다. null 이면 메일 없이 화면에서 건넨 초대다.
-- ② `mail_status` — 마지막 발송 결과. 'sent' = SMTP 가 받음(받는 쪽 도착은 모른다) · 'failed' = 보내지 못함.
-- ③ `last_sent_at` — 마지막 발송 시도 시각. 재발송 간격·시간당 상한이 이 칸으로 센다.
alter table invite add column email text null;
alter table invite add column mail_status text null check (mail_status in ('sent', 'failed'));
alter table invite add column last_sent_at timestamptz null;

create index invite_mail_sender_idx on invite (created_by, last_sent_at) where last_sent_at is not null;

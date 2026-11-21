-- 오퍼레이터의 gh 계정 보고(D1). 이 머신에 로그인된 gh 이름과 저장소별 계정 줄 - 이름뿐이다(토큰, 이메일은 받지 않는다).
-- 서버 하나가 커뮤니티 하나라 커뮤니티 칸은 따로 두지 않는다. 오퍼레이터가 이 커뮤니티에 맞게 거른 값이다.
-- 오퍼레이터마다 마지막 값 한 줄만 둔다(upsert). 다른 기기의 승인 화면이 그 에이전트의 소유자에게만 읽힌다.
create table operator_gh_report (
  operator_id      uuid primary key references operator(id) on delete cascade,
  logins           jsonb not null default '[]'::jsonb,
  by_scope         jsonb not null default '{}'::jsonb,
  default_gh_user  text,
  reach            jsonb not null default '[]'::jsonb,
  reported_at      timestamptz not null default now()
);

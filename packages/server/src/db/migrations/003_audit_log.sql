-- 감사 추적. "누가·언제·무엇을 했는가"를 append-only 로 남긴다.
--
-- 요청 로그(stdout)와 다른 이유: 요청 로그는 회전으로 사라지고 컨테이너를 교체하면 없어지며,
-- authorization 헤더를 redact 하므로 **누가 그 요청을 인증했는지가 남지 않는다.** 감사는
-- 백업 대상이고 쿼리 가능해야 한다.
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null,
  -- 실패한 로그인은 계정이 없을 수 있다. 그래서 actor_id 는 nullable 이고, 시도된 handle 은
  -- 따로 남긴다(handle 은 멘션에 쓰이는 공개 식별자이므로 기록해도 비밀이 아니다).
  actor_id uuid references account(id),
  actor_handle text,
  target text,
  ip text,
  -- 본문·토큰·비밀번호는 절대 넣지 않는다. 감사 로그는 널리 읽히도록 만드는 것이 목적이고,
  -- 거기 비밀이 있으면 열람 권한이 곧 계정 권한이 된다.
  detail jsonb not null default '{}'
);

create index audit_log_at_idx on audit_log (at desc, id desc);
create index audit_log_action_idx on audit_log (action, id desc);

-- append-only 를 관례가 아니라 DB 가 강제한다. 지울 수 있는 기록은 증거가 못 된다.
-- 보존 정책을 넣으려면 이 트리거를 의도적으로 내려야 한다 — 그 의도성이 이 장치의 목적이다.
create or replace function audit_log_append_only() returns trigger as $$
begin
  raise exception 'audit_log is append-only';
end;
$$ language plpgsql;

create trigger audit_log_no_mutation
  before update or delete on audit_log
  for each statement execute function audit_log_append_only();

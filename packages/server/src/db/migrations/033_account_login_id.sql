-- 로그인 ID 를 handle 과 분리한다(#271).
-- 기존 인간 계정의 login_id 를 handle 로 백필한다. 로그인 ID 는 한 번 정하면 바꾸지 않으므로
-- 이미 로그인한 사람들을 로그아웃시키지 않아도 된다 — 같은 계정으로 계속 로그인 가능하다.
alter table account add column login_id text;

-- 백필: 이미 로그인 중인 사람들은(handle 로 로그인했던) 그대로 로그인 ID 가 된다.
-- 로그아웃시킬 필요 없이 다음 로그인에서 새로운 login_id 로 인증한다.
update account set login_id = handle where kind = 'human';

-- login_id 는 대소문자 무시 유니크해야 한다 — Alice 와 alice 가 같은 로그인 이름이다.
-- 에이전트는 login_id 가 필요 없다(kind = 'agent') — 사람 계정 행만 유니크 제약의 대상이다.
create unique index account_login_id_unique on account ((lower(login_id))) where kind = 'human';

-- 인간 계정은 반드시 login_id 가 있어야 한다. 에이전트는 null 이 정상이다.
alter table account add constraint account_login_id_not_null check (kind <> 'human' or login_id is not null);
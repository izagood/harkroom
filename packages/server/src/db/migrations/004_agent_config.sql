-- 에이전트의 '정의'. UI 로 등록·수정하려면 설정이 서버에 살아야 한다 — 러너의 환경변수로 두면
-- UI 가 바꿀 대상이 없어 장식이 된다. 러너는 GET /agent/config 로 자기 정의를 읽는다.
--
-- account 에 컬럼을 붙이지 않고 별도 테이블로 둔 이유: 사람 계정에는 없는 개념이다.
create table agent_config (
  account_id uuid primary key references account(id) on delete cascade,
  -- 이 에이전트가 무엇을 하는 사람인지. harness 의 시스템 프롬프트에 덧붙는다.
  instructions text not null default '',
  -- murmur 가 실제로 실행할 수 있는 harness 이름. 값 검증은 애플리케이션이 한다
  -- (harness 목록은 코드와 함께 늘어나므로 스키마 제약으로 굳히지 않는다).
  harness text not null default 'claude-code',
  -- null 이면 harness 기본값을 쓴다 ('Use harness defaults').
  model text,
  effort text,
  -- claude-code harness 가 도구를 실행할 디렉터리.
  working_dir text,
  updated_at timestamptz not null default now()
);

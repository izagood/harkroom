-- 모바일 푸시 1단계: 디바이스 토큰 등록(설계 harkroom://message/80130503-ca6c-4873-8bfe-3084ee182052,
-- security 검토 반영본 harkroom://message/9e6faa09-2be1-4eb6-b5c6-f3d142ef0a10, jaebin "추천대로").
-- 이 PR 은 저장과 등록·해제만 한다. 발송(push_job·APNs)은 다음 PR 이다.
--
-- **세션에 묶는다**(`session_token_hash` → `session` on delete cascade). 그래서 "이 기기가 푸시를
-- 받는가"는 "이 기기의 로그인이 살아 있는가"와 갈라지지 않는다.
-- - 로그아웃(`delete from session where token_hash = …`)하면 그 기기 행이 함께 사라진다.
-- - 비밀번호를 바꿔 다른 세션을 끊으면 그 세션들의 기기 행도 사라진다.
-- - 커뮤니티를 제거할 때 앱이 그 서버에 `/auth/logout` 을 부르는 것도 같은 길이다.
-- 계정에 직접 묶으면 이 셋마다 지우는 코드를 따로 둬야 하고, 하나라도 빠지면 로그아웃한 폰이
-- 계속 울린다.
-- 만료된 세션은 행이 남는다(`session` 을 지우는 sweep 이 없다). 그래서 발송할 때
-- `expires_at > now()` 로 거른다(다음 PR).
--
-- unique (token, account_id) 인 이유: 같은 서버의 두 계정에 같은 폰으로 로그인할 수 있다
-- (모바일 커뮤니티 열쇠가 origin#accountId 다). 이때 둘 다 받는 것이 맞다. token 만 unique 로
-- 두면 나중에 로그인한 계정이 앞 계정의 알림을 빼앗는다.
--
-- 토큰 형식을 DB 에서도 막는다(라우트가 소문자로 고쳐 넣는다). 라우트 검사가 빠진 다른 길이
-- 생겨도 APNs 경로에 임의 문자열이 들어가지 않게 하는 두 번째 그물이다.
create table push_device (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id),
  session_token_hash text not null references session(token_hash) on delete cascade,
  platform text not null check (platform in ('ios')),
  -- 개발 빌드(Xcode)는 sandbox, TestFlight·App Store 는 production APNs 로 가야 한다.
  -- 같은 앱이라도 빌드마다 다르므로 기기가 말한다.
  apns_env text not null check (apns_env in ('production', 'sandbox')),
  token text not null check (token ~ '^[0-9a-f]{64,200}$'),
  -- 사유별 끄기와 본문 미리보기(기본 꺼짐). 라우트가 기본값을 채운 온전한 모양만 넣는다.
  prefs jsonb not null,
  created_at timestamptz not null default now(),
  -- 다시 등록할 때마다 갱신한다. 계정당 기기 상한(20)을 넘으면 이 값이 가장 오랜 것부터 지운다.
  last_seen_at timestamptz not null default now(),
  -- 발송 결과(다음 PR 이 쓴다). 응답에는 싣지 않는다.
  last_ok_at timestamptz,
  last_error text,
  unique (token, account_id)
);

create index push_device_account_idx on push_device (account_id, last_seen_at desc);
create index push_device_session_idx on push_device (session_token_hash);

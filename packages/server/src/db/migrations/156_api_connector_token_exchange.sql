-- API 연결에 「토큰 교환」 인증 꼴(156). 대상 API 가 정적 키를 바로 받지 않고, 키를 토큰 주소에 form 으로 보내 받은
-- 짧은 수명의 access_token 을 Bearer 로 요구할 때 쓴다. 교환·캐시는 오퍼레이터가 한다(키가 이미 거기 메모리에 있다) —
-- 서버는 바깥으로 요청하지 않는다. 키 값은 이 표에 없다(비밀 id 만, 098 과 같다).
--
-- 되돌리기: 기능 코드만 되돌리고 이 열은 남겨도 된다(빈 칸). 그 전에 `token_exchange` 연결을 지우거나 다른 꼴로 바꾼다.
alter table api_connector drop constraint if exists api_connector_auth_kind_check;
alter table api_connector add constraint api_connector_auth_kind_check
  check (auth_kind in ('bearer', 'header', 'none', 'token_exchange'));
-- https 주소(경로 허용, 질의·조각·사용자 정보 없음). 라우트가 정규화해 넣는다 — 여기서는 모양만 다시 잰다.
alter table api_connector add column token_url text null check (token_url is null or token_url ~ '^https://[^?#@\s]+$');
-- {grantType, clientId, keyField}. 칸 검사는 라우트가 한다.
alter table api_connector add column token_form jsonb null;
alter table api_connector add constraint api_connector_token_exchange_check
  check ((auth_kind = 'token_exchange') = (token_url is not null and token_form is not null));

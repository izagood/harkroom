-- 워크스페이스 **클레임 토큰**(2026-09-15).
--
-- `*.harkroom.com` 에서 워크스페이스를 만드는 쪽(harkroom-gate)이 빈 인스턴스를 띄우고,
-- 그것을 **처음 가져가는 한 번**을 이 토큰이 지킨다. `POST /claim` 이 유일한 소비자다.
--
-- ## 왜 필요한가 — `/bootstrap` 에는 인증이 없다
--
-- `/bootstrap` 은 "사람 계정이 하나도 없으면 첫 관리자를 만든다" 이고, 그 관문이 전부다.
-- 셀프호스트(자기 기계, 자기 네트워크)에서는 그것으로 충분하다 — 주소를 아는 사람이 곧
-- 설치한 사람이다.
--
-- 공개된 `*.harkroom.com` 에서는 아니다. 인스턴스가 뜬 뒤 주인이 부트스트랩하기 전까지
-- **주소를 아는 누구나 그 워크스페이스의 첫 관리자가 될 수 있는 창**이 열려 있다. 서브도메인
-- 이름은 비밀이 아니므로(DNS·인증서 로그·추측) 그 창은 실제로 열려 있는 것이다.
-- 토큰을 가진 사람만 통과시키면 그 창이 닫힌다.
--
-- ## 왜 env 가 아니라 테이블인가
--
-- 토큰 자체는 env(`CLAIM_TOKEN_HASH`)로 들어온다 — gate 가 SealedSecret 으로 심는다.
-- 그런데 **소진 여부**는 env 에 적을 수 없다. env 에만 두면 파드가 재시작될 때마다 이미 쓴
-- 토큰이 되살아나고, 그것은 곧 "한 번만" 이라는 성질이 없어지는 것이다. 그래서 기동 시
-- 이 테이블에 한 번 넣고(`on conflict do nothing`), 소진은 여기에 기록한다.
--
-- ## 원문을 저장하지 않는다
--
-- `session`·`pat`·`invite` 와 같은 규칙이다(001). 이 테이블이 통째로 새도 토큰은 새지 않는다.
-- 해시는 sha256(`auth/tokens.ts` 의 `hashToken`) 이다 — 토큰이 128비트 난수라 사전 공격의
-- 대상이 아니므로 argon2 가 아니어도 된다(비밀번호와 다른 점이다).
create table if not exists claim_token (
  token_hash text primary key,
  -- 소진 시각. null 이면 아직 쓸 수 있다. **행을 지우지 않고 남기는 이유**: 지우면
  -- "쓴 토큰" 과 "없는 토큰" 이 구별되지 않아, 이미 클레임된 워크스페이스에 옛 토큰을
  -- 보냈을 때 라우트가 그것을 알 수 없다.
  used_at timestamptz,
  -- 누가 가져갔는가. 감사용이고, 계정이 지워져도 클레임 사실은 남아야 하므로
  -- `on delete set null` 이다.
  used_by uuid references account(id) on delete set null,
  created_at timestamptz not null default now()
);

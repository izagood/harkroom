-- 계정 칩 ②(2026-11-12): 서버에 남아 있던 claude 계정·풀 **이름**을 지운다.
--
-- 계정·풀 이름은 사람이 지은 폴더 이름이라 사람 이름일 수 있다(security #1039). 칩 ①(#1977)이 턴 줄에서 이름을
-- 순번으로 바꿨고, 이 마이그레이션이 남은 두 자리를 지운다. 러너는 칩 ②부터 두 자리에 이름을 보내지 않고, 서버는
-- 옛 러너가 보내도 받기만 하고 버린다(`message.fail` 의 `account`, `inbox.poll` 의 `claudeLane`).
--
-- ① 계정 관문 실패 카드의 이름표 `meta.failure.account`. 새 카드는 풀·계정 순번(`claudePoolRank`·
--    `claudeAccountRank`)만 싣는다. 지난 카드에서는 이름표만 빼고 나머지(차례 주인·코드)는 그대로 둔다 —
--    🙋 상태와 차례 주인 계산은 `code`·`awaitingAccountId` 만 읽으므로 바뀌지 않는다.
update message
   set meta = meta #- '{failure,account}'
 where meta->>'kind' = 'failure'
   and meta->'failure' ? 'account';

-- ①-b 같은 실패 글의 **본문**에 이미 적힌 이름(security, #1978). 정본 문구 자리만 좁게 「(지움)」으로 바꾼다.
--    · 관문 글 끝 「… 답하면 이 턴이 그 자리에서 이어집니다. 계정: {이름})」 — 이름 대신 순번을 쓴 새 꼴
--      (「풀 N · 계정 N」·「계정 N」·「기본 로그인」·「모름」)과 옛 기본값 「(기본)」은 그대로 둔다.
--    · #1972 이전 계정 축 소진 글의 「계정별 이유:」 아래 줄 머리 「- {이름}: 설정 확인…/사용량 한도…/로그인이 풀림/
--      입력창…」 — 「(기본 계정)」과 #1972 뒤의 「계정 N」은 그대로 둔다.
--    이름은 풀 폴더 꼴(`CLAUDE_POOL_NAME_PATTERN`, [a-z0-9-])이거나 「풀/계정」이다. 검색 색인(044 trigram)은
--    본문을 따라가므로 따로 할 일이 없다. 'n' 플래그로 ^ 가 줄 머리에 맞는다. 이름 자리는 [a-z0-9/-] 만 받으므로
--    한글·공백·괄호가 든 새 꼴과 기본값은 맞지 않는다.
update message
   set body = regexp_replace(
                regexp_replace(
                  body,
                  '(답하면 이 턴이 그 자리에서 이어집니다\. 계정: )[a-z0-9/-]+\)',
                  '\1(지움))', 'g'),
                '^- [a-z0-9-]+(/[a-z0-9-]+)?: (설정 확인|사용량 한도|로그인이 풀림|입력창)',
                '- (지움): \2', 'gn')
 where meta->>'kind' = 'failure'
   and (body like '%답하면 이 턴이 그 자리에서 이어집니다. 계정: %' or body like '%계정별 이유:%');

-- ①-c 같은 이름이 실패 카드의 짧은 사유 `meta.failure.reason` 에도 「{이름}: 사용량 한도 · …」로 들어갔다(#1972 이전
--    `accountTrailReason`). 같은 규칙으로 「(지움)」으로 바꾼다.
update message
   set meta = jsonb_set(meta, '{failure,reason}', to_jsonb(regexp_replace(
                meta->'failure'->>'reason',
                '(^| · )[a-z0-9-]+(/[a-z0-9-]+)?: (설정 확인|사용량 한도|로그인이 풀림|입력창)',
                '\1(지움): \3', 'g')))
 where meta->>'kind' = 'failure'
   and jsonb_typeof(meta->'failure'->'reason') = 'string';

-- ② 러너가 기동 때 신고하던 계정 순서(044). 프로필의 「기동 때 읽은 claude 계정」 줄이 쓰던 표다.
--    이 기기의 풀 순서는 데스크톱 설정(에이전트 › 풀 순서)이 오퍼레이터에게서 직접 읽는다.
--    **표는 지우지 않고 비운다** — 판올림 중 아직 도는 옛 서버 파드가 `agents.ts` 에서 이 표를 left join 한다.
--    지우면 그 사이 에이전트 목록이 500 이 된다. 비우면 옛 서버는 「모른다」(null)로 그린다. 표 자체는 다음
--    마이그레이션에서 지운다(이 판이 운영에 나간 뒤).
truncate table agent_claude_lane;

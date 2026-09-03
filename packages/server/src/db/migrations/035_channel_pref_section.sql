-- 채널 섹션(#157). channel_pref 에 컬럼을 더한다 — 같은 계열(계정별-채널별 선호)이므로
-- 같은 테이블에 두어야 조인이 둘이 되지 않고 한쪽만 정리하는 사고가 나지 않는다.
--
-- section: 자유 문자열. null = 섹션 없음(맨 아래 "기타").
-- sortOrder: 섹션 안에서의 수동 순서. null 이면 이름순 뒤에 붙는다.
alter table channel_pref add column section text;
alter table channel_pref add column sort_order integer;
-- 사람이 직접 정하는 상태(#186). 소켓 연결에서 파생되는 presence 와 **나란히** 산다 —
-- 덮지 않는다. 덮으면 "연결이 끊긴 사람"과 "방해 금지인 사람"이 한 표시로 뭉쳐,
-- 하트비트가 잡아내려던 신호(죽은 연결을 online 으로 남기지 않는다)를 잃는다.

-- check 제약을 두는 이유: 값 집합이 코드(zod enum, shared 의 AccountStatus)에만 있으면
-- 타입 검사기가 닿지 않는 경로 — 수동 SQL, 다음 마이그레이션, 러너의 직접 질의 — 가
-- 잘못된 값을 넣어도 DB 가 막지 못한다. 화면은 모르는 값을 만나면 아무것도 그리지 못한다.
alter table account add column status text not null default 'available'
  check (status in ('available', 'away', 'dnd'));

-- 사용자 지정 문구. 없음은 null 이다 — 빈 문자열과 구분해야 "지웠다"가 표현된다.
alter table account add column status_text text;

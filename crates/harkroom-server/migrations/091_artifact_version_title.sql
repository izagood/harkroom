-- 미리보기 버전마다 제목을 둔다(2026-10-02, designer 판정 · jaebin 승인값 "옛 카드는 그때 버전 고정").
--
-- 090 은 제목을 `artifact` 에 하나만 두었다. 고쳐 올리면 그 값이 바뀌어 **옛 카드도 새 이름으로**
-- 보였다 — v1 「시안 A」를 보고 "A 가 좋다"고 답했는데 v2 가 「시안 B」로 바뀌면 그 답이 엉뚱한 것을
-- 가리킨다. 그래서 버전이 자기 제목을 갖는다. 요약(summary)은 090 부터 버전에 있었다.
--
-- `artifact.title` 은 **최신 버전의 제목**으로 남는다 — "이 안 전체"를 부르는 자리(최신 알약 툴팁 등)가 쓴다.
-- 이미 있는 행은 지금 제목으로 채운다(v1 데이터는 거의 없다).
--
-- **null 을 허용한다**(expand-only, docs/operations.md §12). 롤링 배포 중 옛 파드는 이 칸을 모르고 버전 행을
-- 쓴다 — `not null` 이면 그 파드의 `artifact.publish` 가 깨진다. 읽는 쪽은 `coalesce(v.title, a.title)` 로
-- 비어 있는 행을 최신 제목으로 메운다. `not null` 은 옛 파드가 사라진 다음 릴리스에서 걸 수 있다.
alter table artifact_version add column title text
  check (title is null or char_length(title) between 1 and 200);
update artifact_version v set title = a.title from artifact a where a.id = v.artifact_id and v.title is null;

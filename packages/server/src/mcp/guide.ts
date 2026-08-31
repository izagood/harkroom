export const GUIDE = `# murmur workspace 가이드 (에이전트용)

## avcs 사용 경계
- 읽기 전용 요청(요약·질문 답변·설명·리뷰 의견): 채팅으로만 응답한다. avcs 오브젝트를 만들지 않는다.
- 저장소 상태 변경(코드 수정·파일 추가/삭제·통합·릴리스): avcs로 진행한다(intent → session → operations).
- 회색지대(조사·분석): 산출물이 repo에 들어가면 avcs, 채팅 답변으로 끝나면 채팅만.

## 작업 스레드 연결
채팅 스레드에서 촉발된 작업은 intent 생성 직후 work.link(repo, intentOid, threadRootMessageId)를
호출해 그 대화 스레드를 작업 스레드로 승격시켜라. 이후 operation/decision이 그 스레드에 투영된다.

## 깨어나기
inbox.poll을 timeoutMs와 함께 호출해 두면 멘션·DM·스레드 답글이 도착할 때 응답이 돌아온다.
처리한 항목은 REST POST /inbox/read 로 읽음 처리하라.
`;

// API 키 연결(lane) 턴에 하네스의 시스템 쪽 자리로 덧붙이는 답 규칙(2026-10-25~29, 스레드 db4ab174).
//
// codex·opencode 는 lane 모델(MiniMax-M2.7 실측)에 「가벼운 대화는 최종 메시지로」·「짧게, 4줄 이하로」 같은 기본 지시를 싣는다. harkroom
// 지시는 두 하네스에서 사용자 글 앞에 붙어(prompt-prefix) 그 문장을 못 이겨, 인사·잡담에 MCP 로 답하지 않고 화면에만 쓰고 끝났다.
// 하네스마다 **기본 지시를 지우지 않고 덧붙이는** 칸에 이 문구를 싣는다 — codex `developer_instructions`(`providerLane.ts`),
// opencode·kilo 설정 `instructions`(`opencodeHome.ts`). 기본 지시를 대체하는 칸(codex `instructions`·`model_instructions_file`,
// opencode `agent.<이름>.prompt`)은 도구·셸 지침까지 지우므로 쓰지 않는다.
export const LANE_REPLY_INSTRUCTIONS =
  '이 대화의 답은 화면(최종 메시지)에 쓰는 것으로 끝나지 않는다. 사람은 harkroom 스레드만 본다 — 인사·잡담을 포함한 모든 답을 '
  + '반드시 harkroom MCP 의 message_post 도구로 그 스레드(프롬프트 맨 위의 channelId·threadRootId)에 올려라. '
  + 'message_post 에는 threadRootId 를 꼭 넣는다 — 빼면 채널 최상위에 올라가 그 스레드에서 답이 안 보인다.';

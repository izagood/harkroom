// 스레드를 하네스 턴이 받는 텍스트로 바꾸는 순수 로직. 네트워크도 하네스 실행도 여기 없다 —
// 그래서 이 부분만 테스트되고, 프로세스 spawn·resume 판단은 main.ts 가 조립한다.
//
// reply.ts 의 후신이다(spec §4). 다른 점: 예전에는 멘션마다 프로세스를 새로 띄워 스레드
// 전체를 매번 넘겼지만, 이제 스레드마다 하네스 세션이 디스크에 살아남아 resume 되므로
// 세션이 이미 아는 것까지 다시 넘길 필요가 없다 — 그 경계가 `lastFedSeq` 다. 그리고 예전엔
// 러너가 모델 응답을 파싱해 대신 올렸지만, 이제 에이전트가 harkroom MCP `message.post` 로
// 스스로 올린다 — 그래서 시스템 프롬프트가 "어디에 쓸지"까지 알려줘야 한다.
import { messagePermalink, type MessageRow, type InboxTeamCall, type InboxDelegationOutcome, type InboxDelegatedBy, type InboxCanceledWake, type WakeReportTo } from '@harkroom/shared';

import type { AccountFailure } from './claudeAccounts.js';

/** 서버의 메시지 본문 상한(`POST /channels/:id/messages` 의 zod `max(8000)`). 넘기면 발화가 실패한다. */
export const BODY_LIMIT = 8000;

/**
 * 답을 올리지 않고 턴이 정상 종료했을 때 러너가 에이전트 계정으로 앵커에 남기는 통지(spec §4 발화 경로).
 *
 * ## 왜 세 갈래인가 (2026-10-01, designer 검토안·jaebin 승인)
 *
 * 옛 통지는 `(답 없이 턴을 끝냈습니다 — 프로세스는 정상 종료, 발화 없음)` 한 줄 + TUI 꼬리 원문이었다.
 * 10-01 하루에만 40건이 넘었고 대부분은 **에이전트끼리 주고받은 FYI 멘션**이었다 — 덧붙일 말이 없어
 * 답하지 않은 것이 정상인데, 사람 눈에는 오류 카드가 줄줄이 쌓였다. 그래서 부른 쪽과 정황으로 나눈다:
 *
 * - 부른 쪽이 **에이전트**이고 다른 스레드 답도 없다 → 글 없이 멘션 메시지에 ✅ 리액션만 단다. 처음 안은
 *   progress 줄이었지만, 데스크톱은 마지막 줄이 에이전트의 progress 인 스레드를 그 러너가 살아 있는지로
 *   `running`/`stuck` 이라 칠하고(`desktop/src/lib/threadState.ts::decide`) progress 묶음은 같은 저자의 보통
 *   글이 와야 닫힌다(`progressGroup.ts`) — FYI 스레드가 끝나지 않는 '작업 중'으로 남는다(designer 재검토).
 * - 다른 스레드에 답했다 → 부른 쪽과 무관하게 보통 답글로 그 링크를 준다(드물고, 링크는 사람에게도 쓸모 있다).
 * - 부른 쪽이 **사람**이고 정말 답이 없다 → 보통 답글로 그 사실과 마지막 말 한 줄.
 *
 * TUI 꼬리 원문은 본문에 싣지 않는다 — 화면 찌꺼기(상태줄·입력창·이스케이프 잔여)가 대부분이라 사람이
 * 읽을 수 없었다. 대신 하네스 기록의 **마지막 말 한 줄**(`readLastAssistantText`, `silentWakeNotice` 와
 * 같은 방식)을 싣고, 원문 꼬리는 러너 로그에만 남긴다(호출자).
 */
export type SilentTurnNotice = { kind: 'react'; emoji: string } | { kind: 'post'; body: string };

/** 에이전트가 부른 턴이 덧붙일 말 없이 끝났다는 표시 — 멘션 메시지에 단다(👀 받았음·💬 도는 중의 끝). */
export const SILENT_ACK_EMOJI = '✅';

export function silentTurnNotice(opts: {
  /** 이 턴을 부른 쪽. 모르면 `'human'` — 사람에게 안 보이는 쪽으로 틀리는 것이 더 나쁘다. */
  caller: 'agent' | 'human';
  /** 하네스가 끝내며 남긴 말(`readLastAssistantText`). 못 읽었으면 `null`. */
  lastSaid: string | null;
  /** `offAnchorNotice` 의 결과 — 이 턴이 다른 스레드에 답했으면 그 링크 문장. */
  offAnchor: string | null;
  pat: string;
  /** 이 턴에 마운트한 비밀 값(`secretLeases.needles`). 마지막 말 인용에서 가린다(`quotedLine`). */
  secrets?: readonly string[];
}): SilentTurnNotice {
  if (opts.offAnchor !== null) return { kind: 'post', body: opts.offAnchor };
  // 에이전트 쪽은 글이 없으니 마지막 말을 실을 자리도 없다 — 호출자가 러너 로그에 남긴다.
  if (opts.caller === 'agent') return { kind: 'react', emoji: SILENT_ACK_EMOJI };
  const said = quotedLine(opts.lastSaid, opts.pat, opts.secrets);
  return {
    kind: 'post',
    body: said
      ? `답을 남기지 못하고 끝났습니다. 마지막 말: "${said}" — 다시 부르면 이어서 합니다.`
      : '답을 남기지 못하고 끝났습니다 — 다시 부르면 이어서 합니다.',
  };
}


/** 통지에 실을 하네스 출력의 상한. 이 길이를 넘으면 앞을 자르고 뒤를 남긴다. */
const TAIL_NOTICE_MAX_CHARS = 1000;

/**
 * 발화 없이 끝난 턴에서 **하네스가 마지막에 남긴 출력**을 통지에 실을 형태로 만든다.
 *
 * ## 왜 있는가
 *
 * 2026-09-07 15:08 의 턴은 `PR #533 을 올렸고 CI 두 잡이 도는 중입니다 … 통과 시 머지하고
 * 결과를 스레드에 올리겠습니다` 를 stdout 에 남기고 끝났다. 사람이 스레드에서 본 것은
 * `(답 없이 턴을 끝냈습니다)` 한 줄이었다 — **정보는 존재했고 러너가 버렸다.** 그 말은
 * `runTurn` 이 돌려주는 `tail`(끝 2KB) 안에 있었고, 성공 경로가 그것을 쓰지 않았을 뿐이다.
 *
 * ## 이것은 하네스 출력의 "해석" 이 아니다
 *
 * `pty.ts` 가 그은 금지선은 **출력을 해석해 답으로 삼는 것**이다(옛 `reply.ts::extractReply`
 * 가 하던 일이고, 발화를 에이전트의 자율로 옮기며 걷어냈다). 여기서 하는 것은 판정이 아니라
 * **증거 첨부**다: 무슨 뜻인지 정하지 않고, 마지막에 무엇이 찍혔는지를 그대로 보인다.
 * 그래서 발화 판정(`countOwnPostsSince`)은 여전히 harkroom 데이터만 본다.
 *
 * ## 새니타이즈가 선택이 아닌 이유
 *
 * PTY 안에서는 stdout·stderr 가 한 스트림으로 섞이고 프롬프트 에코까지 남는다(`pty.ts`
 * 주석의 실측). 러너 env 에는 `HARKROOM_PAT` 가 있으므로 하네스가 `env` 를 찍는 순간 그것이
 * tail 에 들어온다 — 걸러내지 않으면 이 통지가 **비밀을 대화에 흘리는 경로**가 된다.
 * 그래서 러너 자신의 PAT(정확한 문자열), `murp_` 모양의 다른 토큰, `Bearer <값>` 을 가린다.
 *
 * 남길 것이 없으면 `null` — 빈 상자는 "여기 뭔가 있다"는 거짓 신호다(`readAskMeta` 판례).
 */
export function harnessTailNotice(tail: string, pat: string, secrets: readonly string[] = []): string | null {
  let text = tail
    // CSI/OSC 등 ANSI 이스케이프. 색·커서 제어가 그대로 흐르면 사람이 읽을 수 없다.
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // CSI 는 ECMA-48 모양 그대로 지운다: 매개변수 바이트 0x30–0x3F(`<`·`=`·`>`·`?` 포함), 중간 바이트
    // 0x20–0x2F, 끝 바이트 0x40–0x7E. 옛 식은 매개변수에 `<`·`>` 를 안 넣어 claude TUI 의 kitty 키보드
    // 시퀀스(`ESC[<u`·`ESC[>1u`)와 modifyOtherKeys(`ESC[>4m`)에서 `ESC[` 만 지우고 `<u>4m` 을 남겼다(10-01).
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    // 나머지 두 바이트짜리 ESC 시퀀스(`ESC(B`·`ESC=`·`ESC7` …).
    .replace(/\x1B[ -/]*[0-~]/g, '')
    // PTY 는 줄바꿈을 `\r\n` 으로 낸다. `\r` 만 남으면 채팅에서 줄이 겹쳐 보인다.
    .replace(/\r\n?/g, '\n')
    // 남은 제어문자(벨 등). 개행·탭은 뜻이 있으므로 남긴다.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // 비밀 가리기. **정확한 PAT 를 먼저** 지운다 — 아래 모양 규칙이 못 잡는 형태여도 이건 잡힌다.
  if (pat.length > 0) text = text.split(pat).join('(가림)');
  /**
   * 마운트한 비밀 값(비밀 보관소 D7 후속). 바늘은 러너가 그 턴의 디렉터리에서 만든다(`secretLeases.needles`) —
   * 긴 것부터 온다. 가리지 않으면 이 통지가 서버 D5(`secret_in_body`)에 통째로 막혀 실패 안내가 사라진다.
   *
   * 통째로 맞는 값은 가린다. 그다음 **조각**을 본다(security U1): PTY 는 긴 줄을 화면 폭에서 접고, claude TUI 는
   * 도구 출력에 `⎿`·들여쓰기를 붙여 접으며, 꼬리 버퍼는 앞을 자르므로 값의 뒷부분으로 시작할 수 있다. 그러면
   * 바늘 전체는 안 맞고 조각은 그대로 나간다(서버 D5 도 전체 값만 본다). 그래서 공백·박스 문자를 다 걷은 사본에서
   * 바늘의 12자 조각 하나라도 보이면 **출력을 통째로 싣지 않는다** — 조각만 가리면 나머지가 남는다.
   */
  if (secrets.length > 0) {
    for (const n of secrets) if (text.includes(n)) text = text.split(n).join('(가림)');
    if (tailHasSecretFragment(text, secrets)) return '(마지막 출력에 비밀 값이 섞여 있어 싣지 않았다)';
  }
  text = text
    .replace(/(?:hrkp|murp)_[A-Za-z0-9_-]+/g, '(가림)')
    .replace(/(Bearer\s+)\S+/gi, '$1(가림)');

  text = text.trim();
  if (text.length === 0) return null;
  // 뒤를 남긴다 — 마지막에 무엇을 했는지가 이 통지의 값이다. 자른 사실을 밝힌다:
  // 밝히지 않으면 사람이 "이게 전부"로 읽는다.
  return text.length > TAIL_NOTICE_MAX_CHARS
    ? `…${text.slice(-TAIL_NOTICE_MAX_CHARS)}`
    : text;
}

/** 꼬리 판정에서 걷어 내는 글자 — 공백 전부와 TUI 의 상자·접힘 문자. */
const TAIL_FLATTEN_RE = /[\s│⎿╭╮╰╯─]/g;
/** 조각 길이. 짧을수록 앞 잘림·접힘에 강하고, 길수록 우연히 맞는 일이 적다. */
export const TAIL_FRAGMENT_CHARS = 12;

/** 바늘의 12자 조각(끝 조각은 마지막 12자) 중 하나라도 공백·박스 문자를 걷은 꼬리에 있는가. */
export function tailHasSecretFragment(text: string, secrets: readonly string[]): boolean {
  const flat = text.replace(TAIL_FLATTEN_RE, '');
  for (const raw of secrets) {
    const n = raw.replace(TAIL_FLATTEN_RE, '');
    if (n.length <= TAIL_FRAGMENT_CHARS) { if (n && flat.includes(n)) return true; continue; }
    for (let i = 0; i < n.length; i += TAIL_FRAGMENT_CHARS) {
      const piece = i + TAIL_FRAGMENT_CHARS <= n.length ? n.slice(i, i + TAIL_FRAGMENT_CHARS) : n.slice(-TAIL_FRAGMENT_CHARS);
      if (flat.includes(piece)) return true;
    }
  }
  return false;
}

/** 한 줄 요약의 상한. 스레드에 남는 러너 통지는 한눈에 읽혀야 한다. */
const NOTICE_LINE_MAX_CHARS = 200;

/**
 * 비밀을 가리고 한 줄로 접는다(`harnessTailNotice` 와 같은 가리기 규칙).
 *
 * 마운트한 비밀(`secrets`)은 **자르기 전에** 통째로 가린다 — 자른 뒤에 가리면 경계에 걸친 값의 앞 조각이
 * 남고, 서버 D5(`secret_in_body`)는 통째 값만 보므로 그 조각이 그대로 나간다(security #1015 재현).
 * 조각(접힘·앞 잘림) 판정은 인용하는 쪽(`quotedLine`)이 한다.
 */
function oneLine(text: string, pat: string, max = NOTICE_LINE_MAX_CHARS, secrets: readonly string[] = []): string {
  let t = maskWhole(text, secrets);
  if (pat.length > 0) t = t.split(pat).join('(가림)');
  t = t
    .replace(/(?:hrkp|murp)_[A-Za-z0-9_-]+/g, '(가림)')
    .replace(/(Bearer\s+)\S+/gi, '$1(가림)')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 마운트한 비밀 값을 통째로 가린다(긴 것부터 온다 — `secretLeases.needles`). */
function maskWhole(text: string, secrets: readonly string[]): string {
  let t = text;
  for (const n of secrets) if (n && t.includes(n)) t = t.split(n).join('(가림)');
  return t;
}

/**
 * 통지에 인용할 마지막 말 — 없으면 빈 문자열. 통째로 가린 뒤에도 비밀의 12자 조각이 보이면 **인용을 통째로
 * 뺀다**(`tailHasSecretFragment`) — 조각만 가리면 나머지가 남는다(`harnessTailNotice` 판례).
 */
export function quotedLine(lastSaid: string | null, pat: string, secrets: readonly string[] = []): string {
  if (lastSaid === null) return '';
  if (secrets.length > 0 && tailHasSecretFragment(maskWhole(lastSaid, secrets), secrets)) return '';
  return oneLine(lastSaid, pat, NOTICE_LINE_MAX_CHARS, secrets);
}

/**
 * **예약으로 깨어난 턴이 말없이 끝났다**(2026-09-30).
 *
 * 그 턴이 다시 깨움을 걸었으면 `silentTurnNotice` 는 나가지 않는다(대기 줄이 보이므로). 그런데
 * 그 사이 무엇을 확인했는지는 아무 데도 없었다 — 09-30 #task e3ecfdf7·5f5fc126 에서 깨어난 턴이
 * "새 소식이 없어서 글을 쓰지 않았어"를 터미널에만 남기고 끝났고, 사람은 약속한 보고가 사라진
 * 것으로 읽었다. 한 줄로 **확인은 했다**는 사실과 하네스가 남긴 이유를 싣는다.
 *
 * progress 로 올린다(호출자) — 결과 발화가 아니므로 발화로 세지 않고, 스레드를 `막힘` 으로 칠하지 않는다.
 */
export function silentWakeNotice(lastSaid: string | null, pat: string, secrets: readonly string[] = []): string {
  const said = quotedLine(lastSaid, pat, secrets);
  return said
    ? `(예약된 확인 턴이 발화 없이 끝났습니다 — 하네스의 마지막 말: "${said}")`
    : '(예약된 확인 턴이 발화 없이 끝났습니다)';
}

/** 한 턴에 권한 거부 통지를 몇 번까지 올리나. 거부는 줄줄이 번진다(09-30 실측: 한 턴에 4건). */
export const DENIAL_NOTICE_MAX_PER_TURN = 3;

/**
 * **권한 분류기가 도구 호출을 거부했다**(2026-09-30). 러너가 턴 기록에서 보고 스레드에 올린다.
 *
 * 거부는 턴을 죽이지 않고, 거부 문구가 "같은 결과를 다른 도구로 좇지 마라"를 시키므로 에이전트는
 * 그 사실을 말하지 못한 채 끝나기 쉽다. 사람이 할 일(직접 하기·허용 규칙 넣기)은 이 줄에서 시작한다.
 */
export function permissionDenialNotice(
  denials: ReadonlyArray<{ tool: string; input: string; reason: string }>,
  pat: string,
): string {
  const lines = denials.map((d) => {
    const what = d.tool === 'Bash' ? d.input : `${d.tool}${d.input ? ` ${d.input}` : ''}`;
    return `- ${oneLine(d.reason, pat, 120)} — \`${oneLine(what, pat)}\``;
  });
  return ['권한 거부(auto mode 분류기) — 이 명령은 실행되지 않았다:', ...lines].join('\n');
}

/** MAX_ATTEMPTS 를 소진했을 때 채널에 남기는 통지문구(#82). */
export const FAILURE_NOTICE = '(답변에 실패했습니다 — 운영자 확인이 필요합니다)';

/**
 * 하네스 로그인이 풀렸을 때 **스레드에** 남기는 통지(2026-09-07).
 *
 * 왜 러너 로그로 충분하지 않은가: 그날 forge 의 claude 로그인이 만료됐고, 러너 로그에는
 * "`claude` 를 한 번 실행해 로그인해라"가 이미 있었다. 그런데 사람이 보고 있던 곳은
 * 스레드였고 거기 남은 것은 `FAILURE_NOTICE`("운영자 확인이 필요합니다") 두 줄이었다.
 * 사용자의 말이 정확히 이것이다: *"그럼 다시 로그인 할 수 있게 알려줬어야지"*.
 *
 * 이름을 인자로 받는 이유: 하네스마다 명령이 다르고(`claude-code` → `claude`,
 * `codex` → `codex`), 모르면 **지어내지 않는다**(#368).
 */
export function harnessLoginNotice(binary: string | null): string {
  return binary === null
    ? '(하네스 로그인이 풀렸습니다 — 그 CLI 로 다시 로그인한 뒤 저를 다시 불러 주세요)'
    : `(하네스 로그인이 풀렸습니다 — 터미널에서 \`${binary}\` 를 실행해 다시 로그인한 뒤 저를 다시 불러 주세요)`;
}

/**
 * 사용량 한도에 걸렸을 때 스레드에 남기는 통지(2026-09-07 16:05 실측).
 *
 * 자격증명 통지와 갈라야 하는 이유: 여기서 사람이 할 일은 **아무것도 없다** — 기다리면
 * 낫는다. 그것을 "운영자 확인이 필요합니다"로 말하면 사람은 로그인과 PAT 를 뒤진다.
 * 시각을 아는 것이 이 통지의 값이고, 모르면 사실만 말한다.
 */
export function quotaNotice(resetsAt: string | null): string {
  return resetsAt === null
    ? '(사용량 한도에 걸렸습니다 — 한도가 풀린 뒤 다시 불러 주세요)'
    : `(사용량 한도에 걸렸습니다 — ${resetsAt} 에 풀립니다. 그 뒤에 다시 불러 주세요)`;
}

/**
 * 하네스 세션 상태가 어긋났을 때 스레드에 남기는 통지(2026-09-07 19:03 실측).
 *
 * 앞의 두 통지와 갈라야 하는 이유는 **사람이 할 일이 다르다**는 것뿐이다. 한도는 기다리면
 * 낫고, 로그인 만료는 그 CLI 로 다시 로그인하면 낫는다. 이것은 둘 다 아니다 — 러너가 든
 * 세션 상태와 하네스의 디스크가 어긋난 것이라, 기다려도 로그인해도 그대로다.
 *
 * `FAILURE_NOTICE`("운영자 확인이 필요합니다")가 실패한 자리가 정확히 여기다: 확인이
 * 필요한 것은 맞는데 **무엇을** 확인할지 말하지 않았다. 그래서 어긋난 대상과 볼 곳을
 * 함께 적는다. 인자를 받지 않는 이유는 세션 uuid 가 사람에게 아무 정보도 주지 않아서다 —
 * 그 값이 필요한 사람은 러너 로그를 보고, 거기에는 tail 원문이 함께 찍힌다.
 */
export function sessionConflictNotice(): string {
  return '(하네스 세션 상태가 어긋나 답할 수 없었습니다 — 운영자가 러너 로그를 확인해야 합니다)';
}

/**
 * 스레드 지정 모델을 하네스가 거절했다는 통지(결정 6). 사람이 할 일(스레드 칩에서 되돌리기)을
 * 말한다 — 앱은 이 실패 카드에 [기본으로 되돌리고 다시 부르기] 를 단다.
 */
export function threadModelRejectedNotice(model: string | null, effort: string | null, apiError: string): string {
  const value = [model ?? '설정 모델', effort].filter(Boolean).join(' · ');
  const why = apiError.replace(/\s+/g, ' ').trim().slice(0, RETRY_REASON_MAX_CHARS);
  return `(이 스레드에 지정한 모델 ${value} 을 하네스가 받지 않아 답하지 못했습니다 — 다시 시도하지 않습니다. `
    + `스레드 머리의 모델 칩에서 기본으로 되돌리거나 다른 모델을 골라 다시 불러 주세요. 하네스: ${why})`;
}

/** 계정 이유 한 칸의 말(종류만 — 화면 원문은 싣지 않는다, `claudeAccounts.ts::AccountFailureKind`). */
function accountFailureText(f: AccountFailure): string {
  const who = f.account ?? '(기본 계정)';
  switch (f.kind) {
    case 'gate': return `${who}: 설정 확인 화면에서 사람의 선택을 기다림`;
    case 'quota': return f.resetsAt === null ? `${who}: 사용량 한도` : `${who}: 사용량 한도(${f.resetsAt} 에 풀림)`;
    case 'credential': return `${who}: 로그인이 풀림`;
    case 'timeout': return `${who}: 입력창이 뜨지 않음(시간 초과)`;
  }
}

/**
 * 계정 축이 다 돈 뒤 **계정마다 왜 못 했나**를 덧붙인다(2026-10-02). 축을 안 넘겼으면 원문 그대로다.
 *
 * 2026-10-01 에 스레드에는 마지막 계정의 "11pm 에 풀립니다"만 남았고, 사람 손으로 바로 풀리는
 * 계정(첫 실행 승인 화면)이 있다는 사실은 러너 로그에도 없었다. 관문이 하나라도 있으면 할 일을
 * 함께 적는다 — 기다리는 것보다 그쪽이 빠르다.
 */
export function withAccountTrail(notice: string, trail: readonly AccountFailure[]): string {
  if (!trail.length) return notice;
  const lines = trail.map((f) => `- ${accountFailureText(f)}`);
  const gate = trail.some((f) => f.kind === 'gate')
    ? ['설정 확인 화면에 선 계정은 그 계정으로 claude 를 터미널에서 한 번 실행해 화면의 물음에 답하면 풀립니다. 그 뒤 다시 불러 주세요.']
    : [];
  return [notice, '계정별 이유:', ...lines, ...gate].join('\n');
}

/** 실패 카드의 `reason` 한 줄 — 같은 사실을 짧게(종류만). */
export function accountTrailReason(trail: readonly AccountFailure[]): string | null {
  return trail.length ? trail.map(accountFailureText).join(' · ') : null;
}

/** 재시도 통지에 싣는 사유의 최대 길이. 한 줄로 읽히는 만큼만 남긴다. */
const RETRY_REASON_MAX_CHARS = 160;

/**
 * 답하지 못한 턴을 **다시 시도한다**는 통지(2026-09-09 실측).
 *
 * 왜 필요한가: 이 자리는 지금까지 `console.error` 뿐이었다. 그날 한 턴이 30분을 서 있다가
 * 접혔고 러너 로그에는 `답변 실패 (1/3)` 이 남았는데, 스레드에는 **아무것도 남지 않았다** —
 * 스레드 행의 `failureCount` 조차 0이라 화면이 알 방법이 없었다. 사람이 본 것은 👀 하나
 * 붙은 `끝남` 배지뿐이었고, 그래서 나온 말이 *"이거 왜 답변 안 하고 있어"* 다.
 *
 * `FAILURE_NOTICE` 로 대신할 수 없다: 그것은 3회를 **다 태운 뒤**에 나오는 말이라, 재시도가
 * 도는 동안(백오프까지 합쳐 수십 분)은 여전히 침묵이다. 사람이 알아야 하는 것은 "끝났다"가
 * 아니라 **"아직 하는 중이고, 왜 한 번 엎어졌는지"** 다.
 *
 * entry 당 1회만 올린다(중복 판정은 호출자가 갖는다) — 매 시도마다 올리면 빠르게 실패하는
 * 오류에서 스레드가 몇 초 만에 도배된다.
 */
export function retryNotice(tried: number, max: number, reason: string | null): string {
  const head = `(답하지 못하고 끝나 다시 시도합니다 — ${tried}/${max}회째`;
  const tail = reason === null ? '' : `, 원인: ${reason}`;
  return `${head}${tail})`;
}

/**
 * 하네스가 **턴 도중에 확인을 기다린다**는 통지(2026-09-09 실측, `pty.ts::looksLikeGate`).
 *
 * ## 왜 실패(`message.fail`)로 내는가
 *
 * 이 사실의 수신자는 언제나 사람이고, 사람이 손을 대야만 풀린다 — 그것이 `failure` 어휘의
 * 정의이고 화면의 `stuck`("사람만이 풀 수 있으므로 실패와 같은 대접")이 가리키는 상태다.
 *
 * **선택 카드(`message.ask`)로 내지 않는다.** 카드의 선택지를 harkroom 에서 눌러도 관문은
 * 그대로 서 있다 — 답을 받아야 하는 것은 이 스레드가 아니라 **그 터미널**이다. 누를 수
 * 있는데 아무 일도 안 일어나는 단추는 없는 문을 그리는 것이다(규칙 06).
 *
 * `retryable: false` 인 이유도 같다: 이 턴을 다시 부르는 것으로는 안 풀린다. 사람이 화면의
 * 물음에 답하면 **그 턴이 그 자리에서 이어진다** — 다시 부를 일 자체가 없다.
 *
 * 계정을 함께 적는다: 어느 계정의 하네스가 묻고 있는지가 사람이 열 화면을 고르는 재료다.
 */
export function gateNotice(accountLabel: string): string {
  return `(하네스가 확인을 기다려 진행이 멈췄습니다 — 이 스레드의 터미널을 열어 화면의 물음에 `
    + `답해 주세요. 답하면 이 턴이 그 자리에서 이어집니다. 계정: ${accountLabel})`;
}

/**
 * 하네스가 **서 있어서** 접었다는 통지(2026-09-09). `retryNotice` 와 갈라야 하는 이유는
 * 하나다 — **이 실패는 재시도하지 않는다.**
 *
 * 재시도가 왜 소용없는가: 정지의 원인은 대개 사람을 기다리는 화면이고(관문), 프롬프트를
 * 다시 넣으면 모델이 같은 명령을 다시 시도해 **같은 자리에 다시 선다.** 실측에서 그 값이
 * 정지 한도 10분 × `MAX_ATTEMPTS` 3회 = 30분이었고, 끝에 남은 것은 사람이 할 일을 잘못
 * 가리키는 "운영자 확인이 필요합니다" 한 줄이었다. 한도·세션 충돌을 회계에 넣지 않는 것과
 * 같은 판례다(`mentionScheduler` 의 두 분기).
 *
 * `pty.ts::looksLikeGate` 가 관문을 알아보면 애초에 이 자리에 오지 않는다(그 턴은
 * `awaitingHuman` 이라 정지 시계를 재지 않는다). 여기 오는 것은 **알아보지 못한** 관문이거나
 * 진짜로 멈춘 하네스다 — 어느 쪽이든 볼 곳은 그 터미널이므로 말은 하나로 족하다.
 */
export function stallNotice(stallMs: number): string {
  const 분 = Math.round(stallMs / 60_000);
  return `(하네스가 ${분}분 동안 아무것도 하지 않아 접었습니다 — 다시 시도하지 않습니다: `
    + `같은 자리에 다시 서기 때문입니다. 이 스레드의 터미널을 열어 화면을 확인해 주세요 — `
    + `확인을 기다리는 물음이 서 있을 수 있습니다.)`;
}

/**
 * 실패 사유를 통지에 실을 한 줄로 줄인다. 줄바꿈을 없애고 앞을 남긴다 — 사유는 문장 머리에
 * 있고(`harness 정지 …`), `tailNotice` 와 방향이 반대인 이유가 그것이다.
 *
 * **PAT 가림을 여기서도 한다.** 실패 문구에는 tail 이 섞일 수 있고(`harness 종료 N: …`),
 * 그 tail 은 PTY 원문이라 토큰이 지나갈 수 있다 — 통지는 스레드에 영구히 남는다.
 */
export function retryReason(message: string): string | null {
  const text = message
    .replace(/(?:hrkp|murp)_[A-Za-z0-9_-]+/g, '(가림)')
    .replace(/(Bearer\s+)\S+/gi, '$1(가림)')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return null;
  return text.length > RETRY_REASON_MAX_CHARS
    ? `${text.slice(0, RETRY_REASON_MAX_CHARS)}…`
    : text;
}

/**
 * 사람이 조종 중인 스레드에 온 멘션의 대기 통지(#337, 스펙 §5-2 결정 6). 러너가
 * **에이전트 계정으로** 스레드에 올린다 — silentTurnNotice 와 같은 판례다: 시스템 계정을
 * 새로 만들지 않고, 그 스레드에서 말하던 바로 그 목소리가 자기 사정을 말한다.
 * entry 당 1회만 올린다(중복 판정은 mentionQueue 가 갖는다).
 *
 * **문구가 약속을 하지 않는다.** 전에는 "터미널이 닫히면 처리합니다" 라고 적었는데, 닫는
 * 것과 조종이 끝나는 것은 다른 사실이다 — 뷰어 수 프레임이 유실되면 닫아도 끝나지 않고,
 * 그러면 이 문장은 사람이 이미 한 일을 다시 하라고 시킨다(실측된 결함). 조건이 아니라
 * **끝나는 방법**을 적는다.
 */
export function controlledNotice(handle: string, pending: number): string {
  return `(지금 ${handle} 이(가) 직접 조종 중입니다 — 이 멘션은 대기 ${pending}건째입니다. `
    + '조종이 끝나면 처리합니다: 터미널에서 하네스를 종료하거나, Agents 탭에서 「조종 끝내기」)';
}

/**
 * 조종이 상한을 넘겼다 — **실패로** 남긴다(`message.fail`).
 *
 * 평문이 아닌 이유: 유예에는 상한이 없고 대기 통지는 entry 당 1회라, 조종이 풀리지 않으면
 * 그 스레드는 **아무 신호도 없이** 영구 정지한다. 실측된 사건에서 남은 흔적은 대기 수가
 * 1→2→3 으로 늘어난 것뿐이었고, 스레드 머리는 그동안 `끝남` 이었다. 사람이 손을 대야
 * 풀리는 것은 스레드 상태에 `막힘`으로 서야 한다(`harkroom.ts::fail` 주석).
 *
 * 유예 자체는 **유지한다** — 멘션은 inbox 에 살아 있고(그것이 큐다), PTY 가 그 하네스
 * 세션을 쥐고 있는 동안 턴을 억지로 띄우면 한 세션을 두 프로세스가 밟는다(스펙 §1 금지).
 * 여기서 하는 일은 무엇이 막혔는지와 푸는 방법을 사람에게 보이는 것뿐이다.
 */
export function controlHeldNotice(handle: string, pending: number, heldMs: number): string {
  const minutes = Math.max(1, Math.round(heldMs / 60_000));
  return `${handle} 의 조종이 ${minutes}분째 이어져 이 스레드의 멘션 ${pending}건이 대기 중입니다. `
    + '조종이 끝나야 처리됩니다 — 터미널에서 하네스를 종료하거나, Agents 탭에서 「조종 끝내기」를 누르세요. '
    + '(대기 중인 멘션은 사라지지 않습니다.)';
}

/** 진행 설명이 담긴 progress 메시지의 kind 값. */
export const MESSAGE_KIND_PROGRESS = 'progress';

/** 깨움 예약이 남기는 대기 줄의 kind 값(마이그레이션 040). */
export const MESSAGE_KIND_WAKE = 'wake';

/**
 * **결과 발화로 세지 않는** 메시지 종류. `progress` 는 과정 설명이고 `wake` 는 기다림의
 * 표시다 — 둘 다 "물어본 것에 답한 것"이 아니다.
 *
 * 집합으로 둔 이유: 세는 자리가 하나여야 한다(`countOwnPostsSince` 주석). 종류가 늘 때
 * 필터 조건을 두 곳에서 고치면 한쪽만 고쳐지고, 그때 침묵한 턴이 발화한 것으로 판정된다.
 */
const NON_UTTERANCE_KINDS: ReadonlySet<string> = new Set([MESSAGE_KIND_PROGRESS, MESSAGE_KIND_WAKE]);

/**
 * 매 턴 `--append-system-prompt` 로 하네스에 주입되는 시스템 프롬프트. 프로세스가 턴마다
 * 새로 뜨고 이 함수도 매번 다시 불리므로, UI 로 지시문(instructions)을 바꾸면 재시작 없이
 * 다음 턴부터 바로 반영된다(로드맵 §1의 기존 성질 — 세션 무효화 장치가 필요 없다).
 */
/**
 * 메모리 조회 결과(#139). **세 상태를 타입으로 강제한다.**
 *
 * `string` 이나 `string | null` 로 두면 "저장소가 비었다"와 "조회가 실패했다"가 같은
 * 값이 되고, 그것이 이슈가 경고한 사고다 — **DB 장애를 "기억 없음" 으로 읽으면
 * 에이전트가 진짜 기억을 새 프로필로 덮어쓴다.** 판별 가능한 값을 두면 호출부가
 * `catch` 로 빈 값을 흘려보낼 수 없다.
 */
export type MemoryContext =
  | {
    core: string | null;
    slugs: string[];
    /** slug → 한 줄 요약(서버 069). 목록에 이름 옆으로 실린다. 옛 서버면 없다. */
    descriptions?: Record<string, string>;
    /** slug → 종류(서버 070). topic 이 아닌 것만 담긴다. journal 은 목록에서 빠진다. */
    kinds?: Record<string, string>;
    /**
     * 서버를 못 읽어 러너 사본(`memoryCache.ts`)으로 돈다 — 그 사본을 받은 시각. 없는 것이
     * 기억 없이 도는 것보다 낫지만, 에이전트가 **그 사실을 알아야** 낡은 값을 새것처럼
     * 믿고 덮어쓰지 않는다.
     */
    stale?: { fetchedAt: string };
  }
  | 'unavailable';

/**
 * PTY 에 주입할 텍스트가 **입력창의 명령 문법으로 읽히지 않게** 한다.
 *
 * TUI 하네스는 입력이 `!` 로 시작하면 셸로, `/` 로 시작하면 슬래시 명령으로 읽는다 — pi 는 `!` 를
 * `--tools` 와 상관없이 셸로 실행한다(security 지적 2026-10-01, `interactive-mode.js`), claude 도 `!` 가
 * bash 모드다. 지금 주입하는 프롬프트의 첫 줄은 러너가 짓지만, 그 첫 줄이 기억·안내 문구로 바뀌는
 * 순간 읽기 전용 경계가 우연에 기대게 된다 — 그래서 첫 글자를 보고 막는다.
 * 앞에 붙이는 것은 뜻 없는 이름표 한 줄이다(모델에게도 사람에게도 읽힌다).
 */
export function guardInjectedPrompt(text: string): string {
  return /^\s*[!/]/.test(text) ? `[harkroom]\n${text}` : text;
}

/**
 * 프롬프트에 넣기 전 이스케이프.
 *
 * 에이전트가 쓴 메모리를 **자기가 나중에 읽는다** — 저장된 프롬프트 인젝션 경로다.
 * `<` 와 `&` 를 그대로 두면 메모리 내용이 아래 경계 마커를 위조할 수 있다.
 * `&` 를 먼저 바꾼다(나중에 바꾸면 자신이 만든 `&lt;` 를 다시 망가뜨린다).
 */
export function escapeForPrompt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * 메모리를 **쓰는 법**. 저장소가 비었을 때와 차 있을 때가 같은 문장을 쓴다 — 갈라 두면
 * 한쪽만 늙고, 실제로 늙은 쪽이 매 턴 실리는 쪽이었다.
 *
 * 왜 문법을 프롬프트에 적나(2026-09-11 실측): `memory.set` 의 slug 는 `core` 또는 `mem/…`
 * 인데 그 사실이 **어디에도 적혀 있지 않았다.** 한 에이전트가 `baremetal`·`baremetal.cluster`
 * 를 시도해 전부 `invalid_slug` 를 받고 "이 도구는 `core` 하나만 받는다"고 결론지었다. 그날
 * 에이전트 9 중 8이 메모리 1개(=`core`)뿐이었고, 남길 것이 없어서가 아니라 **둘째를 만들
 * 방법을 몰라서**였다. 서버도 거절에 문법을 싣지만(`mcpPlugin.ts::MEMORY_SLUG_HINT`), 거절을
 * 한 번 받고 포기하는 것이 관찰된 행동이므로 시도하기 **전에** 읽는 자리에도 적는다.
 *
 * 갱신 지시가 왜 여기 있나: 전에는 "적어 둬라"가 **저장소가 비었을 때만** 붙었다. `core` 가
 * 한 번 생기면 그 뒤로는 본문만 실리고 고치라는 말이 사라져서, 내 `core` 는 저장소 이름이
 * 바뀐 뒤에도 사흘간 옛 이름을 싣고 다녔다. 기억은 **쓰는 것보다 고치는 것이 어렵다** —
 * 어려운 쪽을 매 턴 말한다.
 *
 * 문구 셋(자주 고쳐라 / 스냅숏이지 정답이 아니다 / 중복해서 쓰지 마라)은 Claude Code 본체의
 * 메모리 절에서 값이 확인된 것을 그대로 가져왔다(claude 2.1.266 바이너리 실측).
 */
const MEMORY_USAGE_LINES = [
  'slug 는 둘 중 하나다: **`core`** — 매 턴 본문이 통째로 실리는 층이다(길어지면 그만큼 매 턴',
  '비싸다. **3,000자까지만 받는다** — 넘기면 `core_too_long` 으로 거절되니 나머지는 아래로 내린다) — 그리고 **`mem/<이름>`**,',
  '예를 들어 `mem/deploy` · `mem/people/jaebin` 처럼 **반드시 `mem/` 으로 시작한다**(소문자·숫자·',
  '`-`·`_` 와 구분자 `/` 만 쓴다. **점(`.`)은 못 쓴다**). `deploy` 나 `agent.config` 같은 slug 는',
  '`invalid_slug` 로 거절되는데, 이건 **`core` 하나만 쓸 수 있다는 뜻이 아니다** — 이름만 고치면',
  '된다. 길거나 한 가지 주제인 것은 `mem/*` 로 나눠 담고 `core` 에는 포인터 한 줄만 남긴다.',
  '`mem/*` 를 쓸 때는 `description` 에 **언제 열어 볼지 알 수 있는 한 줄 요약**을 같이 준다 — 목록에',
  '이름 옆에 실리고, 요약이 없으면 이름만 보고 열지 말지 정해야 한다(생략하면 있던 요약이 유지된다).',
  '한 작업의 경위(PR 하나의 진행 기록 같은 것)는 `kind: "journal"` 로 쓴다 — 목록에 안 실리고 최근 60개만',
  '남는다. 되풀이할 교훈은 journal 이 아니라 주제 기억(`topic`)·절차(`procedure`)로 따로 증류한다.',
  '목록에 없는 것은 `memory.search` 로 찾는다.',
  '',
  '**정리하는 법** — 정리하라는 요청(주간 정리 자동화 등)을 받았거나 `<memory-index>` 머리에 정리 신호가 보이면:',
  '① `memory.lease`(acquire)로 정리 임대를 잡는다 — 다른 턴이 들고 있으면 물러난다. ② `memory.audit` 으로',
  '후보(안 쓰임·비슷한 이름·비슷한 본문·곧 밀려날 journal·오래 안 고친 것·큰 것)를 받아 **하나씩 읽고** 판단한다',
  '(`truncated` 면 고친 뒤 다시 audit). ③ 같은 주제 여럿은 `memory.merge`(into·from·value) **한 번**으로 합친다 —',
  'set 과 지우기를 따로 하면 그 사이 다른 턴이 고친다. ④ 안 쓰는 것 같으면 **지우지 말고 `memory.archive`** 로',
  '보관한다 — 목록·recall·200 상한에서 빠지고 `memory.unarchive` 로 돌아온다. ⑤ 잘못 고쳤으면 `memory.revisions` →',
  '`memory.restore`. ⑥ 끝나면 임대를 놓고(release) 무엇을 바꿨는지 보고한다.',
  '',
  '**자주 읽고 자주 고쳐라 — 그래야 정정이 남는다.** 기억은 확정된 답이 아니라 과거의 스냅숏이니',
  '현재 원본(파일·저장소·화면)과 대조한 뒤 쓴다. 적어 둔 경로·함수·플래그가 아직 있는지 본다.',
  '**중복해서 쓰지 마라** — 새 slug 를 만들기 전에 고칠 기존 항목이 있는지 먼저 본다. 틀린 것은',
  '고쳐 쓰고, 쓸모를 잃은 것은 `memory.archive` 로 보관한다. `memory.set` 의 `value: null` 삭제는 틀린 것에만 쓴다 —',
  '**지워도 이전 판에 남는다**(`memory.revisions` 로 되살아난다). 비밀이 섞였으면 지우는 것으로 끝내지 말고 사람에게',
  '알려 판까지 지우게 하라.',
  '**있던 기억을 고칠 때는 먼저 `memory.get` 으로 읽고 그 `updatedAt` 을 `ifUpdatedAt` 으로 준다**(core 도 —',
  '프롬프트에 실린 core 는 세션 첫 턴 것일 수 있다). 같은 에이전트의 다른 턴이 병렬로 돈다. `conflict` 가',
  '오면 다시 읽어 네 변경을 합쳐 쓰고, 그냥 덮어쓰지 마라.',
];

/** 메모리 절을 만든다. 세 상태가 각각 다른 것을 낸다 — 아래 주석이 이유다. */
function memorySection(memory: MemoryContext): string[] {
  // 조회 자체가 실패했다. **아무것도 주입하지 않는다** — 온보딩 안내조차 넣으면
  // 에이전트가 "나는 기억이 없다" 고 믿고 새로 쓴다. 러너 로그에는 호출부가 남긴다.
  if (memory === 'unavailable') return [];

  if (memory.core === null && memory.slugs.length === 0) {
    // 사본으로 도는데 그 사본이 비어 있다 — "비었다"는 **그때의** 사실이지 지금의 사실이
    // 아니다. 온보딩을 넣으면 'unavailable' 에서 막은 사고(새 프로필로 덮어쓰기)가 돌아온다.
    if (memory.stale) return [];
    // 조회는 성공했고 저장소가 비어 있다. 이건 사실이므로 안내해도 안전하다.
    return [
      '기억이 아직 없다. 이 워크스페이스에서 반복해서 쓸 사실(사람들의 역할, 저장소 규칙,',
      '자주 하는 작업)이 생기면 harkroom MCP 의 `memory.set` 으로 적어 둬라 — 다음 턴부터',
      '여기에 실려 온다.',
      '',
      ...MEMORY_USAGE_LINES,
      '',
    ];
  }

  // **여기에는 core 만 싣는다**(메모리 고도화 PR2). `mem/*` 목록과 사본 경고는 턴마다
  // 달라지는 값이라 턴 프롬프트로 갔다(`memoryPin.ts`) — 시스템 프롬프트가 바뀌면 이어받은
  // 세션의 대화 기록 전체가 프롬프트 캐시를 잃는다. core 도 호출자가 세션 첫 턴 값으로 고정해 넘긴다.
  const lines = ['<memory>'];
  if (memory.core !== null) lines.push(escapeForPrompt(memory.core));
  // 사용법은 **닫는 태그 바깥**에 둔다. 안에 넣으면 기억 본문과 같은 자리에 서고, 그러면
  // 기억을 지운 사람이 지시까지 지우게 된다(`<memory>` 안은 데이터, 밖은 지시다).
  lines.push('</memory>', '', ...MEMORY_INDEX_LINES, '', ...MEMORY_USAGE_LINES, '');
  return lines;
}

/**
 * 목록이 어디 있는지 말하는 고정 문장. 목록이 비었든 찼든 **같은 문장**이다 — 조건에 따라
 * 넣고 빼면 그것만으로 시스템 프롬프트가 바뀐다.
 */
export const MEMORY_INDEX_LINES: readonly string[] = [
  '`mem/*` 기억의 목록은 턴 프롬프트 맨 앞의 `<memory-index>` 에 실린다(세션 첫 턴에 전체,',
  '그 뒤로는 바뀐 것만 `<memory-update>` 로). 이 세션에서 알게 된 가장 최근 것이 지금 값이다.',
  '본문은 필요할 때 `memory.get` 으로 가져온다 — 이름만으로 짐작되지 않으면 열어 본다.',
];

/**
 * 러너 사본으로 돌 때 붙는 경고(`memoryCache.ts`). 닫는 태그 **바깥**이다 — 지시이기 때문이다.
 * 없으면 에이전트는 낡은 core 를 지금 것으로 믿고, 그것을 바탕으로 `memory.set` 해 그 사이
 * 다른 턴이 고친 것을 덮어쓴다.
 */
export function staleMemoryLines(fetchedAt: string): string[] {
  return [
    `**위 기억은 러너가 ${fetchedAt} 에 받아 둔 사본이다** — 이번 턴은 서버에서 메모리를 읽지`,
    '못했다. 그 뒤에 바뀐 것은 반영돼 있지 않을 수 있다. 기억을 고치기(`memory.set`) 전에는',
    '`memory.get` 으로 지금 값을 먼저 확인하고, 읽히지 않으면 고치지 마라.',
  ];
}

/**
 * 스킬 절(#140 의 마지막 조각). **도구는 처음부터 있었고, 없던 것은 이 절이다.**
 *
 * 2026-09-09 실측: `workspace_skill` 테이블과 MCP `skill.propose`(#140), 승인 화면(#311),
 * 러너의 실체화(`mentionTurn.ts::syncSkills`)가 전부 머지·릴리스된 상태에서 설정 → Skills
 * 는 대기 0 / 승인 0 / 비활성 0 이었다. 이 파일에 `skill` 이 한 번도 없었기 때문이다 —
 * 에이전트는 도구 목록에서 이름만 보고 그것을 **언제** 부를지 알지 못했다. 옆의 메모리
 * (#139)가 실제로 쓰이는 것이 대조군이다: `memorySection` 은 "이런 게 생기면 `memory.set`
 * 해라"까지 적어 둔다. 도구를 여는 것과 쓰이게 하는 것은 다른 일이다.
 *
 * **문턱을 적는 것이 이 절의 절반이다.** 승인된 스킬은 모든 에이전트의 스킬 디렉터리에
 * 깔리므로 가장 레버리지가 큰 프롬프트 표면이고(#140 결정문), 제안 하나에는 사람의 승인
 * 시간이 든다. 문턱이 없으면 두 방향으로 다 실패한다 — 낮으면 승인 큐가 차서 게이트가
 * 형식이 되고, 아예 없으면 지금처럼 0 이다. 그래서 "언제 제안하나"와 "무엇은 제안하지
 * 않나"를 같은 절에 적는다. 후자가 없는 절은 전자만 읽힌다.
 *
 * 메모리와 갈라 주는 것도 여기서 한다. 둘 다 "배운 것을 남기는" 도구라 문턱을 말하지
 * 않으면 아무 쪽에나 쓰인다: 나만 쓸 사실은 메모리, 다른 에이전트도 그대로 따라할 절차는
 * 스킬이다(스킬이 워크스페이스 자산인 이유 그대로 — #140 결정문).
 *
 * 조건 없이 매 턴 붙인다. 이미 승인된 스킬 목록을 함께 실어 주고 싶어지는 자리지만, 그것은
 * 하네스가 자기 스킬 디렉터리에서 이미 읽는다(`syncSkills` 가 링크해 둔다) — 같은 사실의
 * 두 번째 원천을 프롬프트에 만들지 않는다.
 */
function skillSection(memory: MemoryContext): string[] {
  // **메모리 조회가 실패한 턴에는 `memory.set` 을 가리키지 않는다.** #139 가 세운 불변식은
  // `memorySection` 하나의 성질이 아니라 프롬프트 전체의 성질이다 — 조회가 실패했는데
  // 프롬프트가 메모리를 입에 올리면 에이전트는 "내 기억은 비어 있다"고 읽고 진짜 기억을
  // 새 프로필로 덮어쓴다. `prompt.test.ts` 의 '조회가 실패하면 온보딩 안내조차 들어가지
  // 않는다' 가 그 선이고, 이 절이 무심코 도구 이름을 적으면 같은 파일 안에서 그 선을 뚫는다.
  const notSkill = memory === 'unavailable'
    ? '아니다 — 그건 내가 기억해 둘 것이고, 스킬은 남이 그대로 따라할 절차다.'
    : '아니라 `memory.set` 이다.';
  return [
    '이 워크스페이스에는 **스킬**이 있다 — 승인되면 모든 에이전트의 스킬 디렉터리에 `SKILL.md`',
    '로 깔려서, 다음부터는 누구든 그 절차를 읽고 그대로 한다. 만드는 길은 harkroom MCP 의',
    '`skill.propose`(slug·body·channelId) 하나이고 **제안만 할 수 있다** — 사람이 승인해야',
    '깔린다. 같은 slug 를 다시 제안하면 본문을 덮고 승인은 버려진다(다시 승인받아야 한다).',
    '',
    '**언제 제안하나:** 같은 절차를 세 번쯤 되풀이했고, 그것이 이 스레드·이 요청에 한정된',
    '맥락이 아니라 다른 에이전트도 그대로 따라할 수 있는 것일 때다. 본문에는 절차와 **그 절차가',
    '그 모양인 이유**를 함께 적는다 — 읽는 쪽은 그때의 대화를 모른다.',
    '',
    `**무엇은 제안하지 않나:** 나만 쓸 사실(사람들의 역할, 저장소 규칙, 내 작업 경위)은 스킬이 ${notSkill}`,
    '한 번 하고 끝난 일, 이 스레드에서만 뜻이 있는 것, 확실하지 않은 것은 제안하지 마라 —',
    '제안 하나마다 사람의 승인 시간이 들고, 승인된 본문은 모든 에이전트가 읽는다. 애매하면',
    '제안하지 말고 스레드에서 물어라.',
    '',
    // 자동화(072): 스킬이 "어떻게"를 남기는 것이라면 자동화는 "언제"를 남긴다. 도구만 열어 두면
    // 스킬처럼 0 으로 남는다(위 머리말의 실측) — 그래서 문턱과 함께 한 단락을 붙인다.
    '사람이 **같은 요청을 정해진 때마다**(매주 월요일 정리 등) 또는 **같은 사건이 날 때마다**',
    '(특정 repo 머지·새 파일 추가 등) 되풀이한다면 `automation.propose`(name·channelId·body·trigger)로',
    '자동화를 **제안**할 수 있다. 승인은 사람이 설정 › Automations 에서 하고, 글은 **승인한 사람',
    '이름으로** 나간다. 제안했으면 그 사실과 승인할 곳을 스레드에 한 줄 적어라. 한 번뿐인 요청은',
    '제안하지 않는다.',
    '',
  ];
}

/**
 * PR 본문 서명이 가리키는 곳. **인스턴스 주소가 아니라 프로젝트 저장소다** — harkroom 는
 * 셀프호스트라 인스턴스 주소는 저마다 다르고(`messagePermalink` 주석), 그래서 링크에
 * 호스트를 박지 않는 것이 이 저장소의 규율이다. 여기 박아도 되는 이유는 이 값이
 * 인스턴스의 주소가 아니라 **프로젝트 자체의 상류 주소**이기 때문이다.
 */
const HARKROOM_REPO_URL = 'https://github.com/izagood/harkroom';

export function buildSystemPrompt(opts: {
  handle: string;
  channelName: string;
  instructions: string;
  guide: string;
  /** #139: 세 상태를 구분한다. `MemoryContext` 주석 참고. */
  memory: MemoryContext;
  /**
   * 이 턴이 살아있을 수 있는 시간(`config.turnTimeoutMs`). 옵셔널인 이유는 기본값을 여기서
   * 정해도 좋기 때문이 **아니다** — 값을 지어내면 프롬프트가 거짓을 말한다. 없으면 예산
   * 문장을 아예 빼고, 대신 "말을 멈추면 죽는다"는 사실만 말한다.
   */
  turnBudgetMs?: number;
  /**
   * 머지 권한(스레드 3deac356). `repos` 가 비면 "머지 권한이 없다"를 말한다 — 말하지 않으면 에이전트가 옛 습관대로
   * `gh pr merge` 를 치고 deny 규칙에 걸려 분류기 운에 기댄다. 없으면(옛 호출부) 이 절을 아예 뺀다.
   */
  merge?: { operatorBin: string; repos: readonly string[]; approved?: readonly { repo: string; number: number }[] };
  /** 외부 API 권한(C안 P3). 연결이 비면 절을 빼지 않고 "키를 채팅에서 찾지 마라"만 적는다. 없으면(옛 호출부) 뺀다. */
  api?: { operatorBin: string; connectors: readonly string[]; delegatable?: readonly string[] };
  /** 비밀 만들기 권한(capability `secret.create`). 참일 때만 절을 쓴다 — 없는 에이전트에게 도구를 권하지 않는다. */
  secretCreate?: boolean;
  /**
   * 권한 요청(스레드 f61af808). 이 채널에서 소유자가 승인해 둔 allow 규칙. 있으면(빈 목록도) 「막히면 permission.request 로
   * 청하라」 절을 쓴다 — 말하지 않으면 에이전트가 분류기에 막힌 명령을 돌아가는 길을 찾거나 사람에게 손 설정을 부탁한다.
   */
  permissions?: { toolAllows: readonly string[] };
}): string {
  const { handle, channelName, instructions, guide, memory, turnBudgetMs, merge, api, secretCreate, permissions } = opts;
  const budgetMinutes = turnBudgetMs === undefined ? null : Math.floor(turnBudgetMs / 60_000);
  return [
    `너는 harkroom 워크스페이스의 에이전트 @${handle} 이고, 지금 #${channelName} 에서 말한다.`,
    '',
    '이 에이전트에 대한 지시문:',
    instructions,
    '',
    '워크스페이스 규칙:',
    guide,
    '',
    ...memorySection(memory),
    ...skillSection(memory),
    // 발화가 러너의 책임에서 에이전트의 자율로 넘어갔다(spec §4 발화 경로) — 어디에 쓸지를
    // 명시하지 않으면 턴이 조용히 끝나고, 러너는 그걸 프로세스 종료 후에나(hasOwnPostSince)
    // 알아챈다. 이 지시가 이 프롬프트에서 가장 중요한 한 줄이다.
    '답은 화면에 출력하는 것으로 끝나지 않는다 — 이 프로세스가 끝나기 전에 네가 직접 harkroom',
    'MCP 의 `message.post` 도구를 불러 이 스레드에 남겨라. channelId 와 threadRootId 는',
    '대화 프롬프트 맨 위에 준다 — 그대로 넣어 호출한다(threadRootId 가 "채널 최상위(없음)"으로',
    '적혀 있으면 그 인자는 생략하고 channelId 만 넘긴다).',
    '',
    // 2026-09-08 실측: 서로 다른 앵커를 받은 턴 셋 중 둘이 **자기 앵커 대신** 채널의 더
    // 새로운 요청을 구현했다. 같은 기능 PR 이 셋 나오고(#638·#639·#640) 정작 그 둘의
    // 앵커에는 답이 없었다. 원인은 워크스페이스 가이드가 상주 에이전트용 poll 계약을
    // 턴에게도 주고 있었던 것이고(서버 `mcp/guide.ts` 가 그것을 모드로 갈랐다), 이 두 줄은
    // 가이드가 없거나 옛 판본이어도 앵커가 지켜지도록 프롬프트 자신이 거는 안전선이다.
    // 여기에 두는 이유: 바로 위가 channelId·threadRootId 를 말한 자리다 — 그 값이 무엇을
    // 뜻하는지(=이 턴의 일 전체)를 같은 문단에서 말해야 한다.
    '**그 앵커가 이 턴의 일 전부다.** 채널이나 인박스에 더 새로운 요청이 보여도 손대지 마라 —',
    '멘션마다 턴이 따로 떠 있으므로 네가 하면 같은 일이 두 번 되고, 정작 네 앵커의 요청은',
    '답 없이 남는다. 눈에 띈 요청은 대신 하지 말고 그 사실만 네 스레드에 한 줄 적어라.',
    '',
    // PR 본문 끝의 서명(2026-09-10, jaebin 승인). **하네스 층이 아니라 여기 있는 것**이
    // 요점이다. Claude Code 에는 `settings.json` 의 `attribution.pr` 이 있어 그 한 줄을
    // 갈아끼울 수 있지만, 그것은 **claude-code 전용 설정**이다 — codex 에는 대응물이 없어
    // 같은 저장소의 PR 인데 그날 어느 하네스가 걸렸느냐로 서명이 있다/없다로 갈린다
    // (`RUNNABLE_HARNESSES` 는 claude-code·codex 둘이다). 이 프롬프트는 두 하네스에 모두
    // 도달하므로(codex 는 지시문 주입 플래그가 없어 프롬프트 앞에 붙는다 — `turn.ts`)
    // 서명이 하네스와 무관해지고, gemini 가 러너블이 되는 날에도 따라온다.
    //
    // 문장에 하네스 이름을 쓰지 않는 것도 같은 결정이다: 하네스는 harkroom 가 에이전트 설정에
    // 이미 갖고 있고, PR 을 나중에 읽는 사람에게 중요한 것은 **어느 에이전트가 열었는가**다.
    // 하네스를 굳이 남기려면 문장 가운데가 아니라 뒤에 따로 붙여야 갈아끼울 수 있다.
    ...(merge ? mergeSection(merge) : []),
    ...(permissions ? permissionSection(permissions) : []),
    ...(api ? apiSection(api) : []),
    ...(secretCreate ? secretCreateSection() : []),
    '저장소에 PR 을 열면 본문 **맨 끝**에 이 줄을 넣는다:',
    '',
    `🤖 Opened by \`@${handle}\`, an agent in [Harkroom](${HARKROOM_REPO_URL}) — a chat workspace where people and AI agents share channels.`,
    '',
    // 백틱은 장식이 아니다: GitHub 은 PR 본문의 맨몸 `@이름` 을 **GitHub 사용자 멘션**으로
    // 읽어 링크를 걸고 그 이름을 가진 계정에 알림을 보낸다. harkroom 핸들과 GitHub 계정은
    // 아무 관계가 없으므로, 백틱을 빼면 이 서명이 매번 남의 알림함을 울린다.
    '핸들의 백틱을 빼지 마라 — GitHub 은 맨몸 `@이름` 을 GitHub 사용자 멘션으로 읽어 그 이름을',
    '가진 **남의 계정**을 부른다. 하네스 이름은 이 줄에 적지 않는다.',
    '',
    // 2026-09-08 실측: 사람이 한 스레드에서 에이전트 넷을 불러 검토를 시켰는데, 넷 다
    // 스레드에 답을 올렸는데도 사람에게는 "에이전트끼리 대화만 했다"로 보였다. 원인이 둘이고
    // 아래 두 줄이 각각의 짝이다.
    //
    // ① 답에 요청자의 이름이 없었다. 데스크탑은 에이전트끼리의 연속 구간을 한 줄로 접는데
    //    (`desktop/src/lib/agentExchange.ts`), 그 판정이 "이 말이 사람에게 오는가"를 본다.
    //    요청자를 `@handle` 로 부르면 그 판정에 걸려 접히지 않는다 — 화면의 `addressesHuman`
    //    과 이 지시가 한 쌍이다. 접힘 규칙 자체도 같은 커밋에서 고쳤으므로 이 줄이 없어도
    //    답은 보이지만, 이름을 부른 답이 사람에게 훨씬 잘 읽힌다.
    // ② 답이 스레드 안에만 있었다. 채널 화면은 `alsoInChannel` 이 아닌 스레드 답을 걸러낸다
    //    (`desktop/src/components/ChannelPane.tsx`). 그래서 채널만 보는 사람에게는 자기
    //    질문 뒤가 비어 있었다. 그때는 "채널에도 에코하라"로 고쳤으나 같은 날 오후 그 처방이
    //    병보다 나쁜 것으로 드러나 되돌렸다 — 아래 에코 문단이 그 경위와 지금의 짝을 적는다.
    // #600: 어느 모델이 답했는지. **에이전트만 알 수 있다** — 러너가 넘기는 `--model` 은
    // 설정값이고, 설정이 비면(`agent_config.model === null`) 러너는 플래그를 아예 안 붙여
    // 하네스가 고른다. 그 선택은 하네스 출력에만 있고, 러너는 출력을 해석하지 않는다(pty.ts).
    // 그래서 이 한 줄이 harkroom 가 실제 모델을 아는 유일한 길이다. 표시는 hover 뿐이므로
    // (`desktop/src/components/MessageItem.tsx`) 이 값을 실어도 화면이 시끄러워지지 않는다.
    '발화할 때(`message.post`·`report`·`fail`·`ask`·`progress`) `model` 인자에 **네가 지금 쓰는',
    '모델 ID** 를 그대로 실어라 — 환경 설명에 적힌 정확한 ID 를 쓴다(예: `claude-opus-5[1m]`).',
    '이름을 다듬거나 추측하지 말고, 모르면 생략한다. 사람이 이름줄에 hover 할 때만 보이므로',
    '화면을 어지럽히지 않는다.',
    '',
    '누구에게 답하는지를 잊지 마라 — **이 스레드를 연 사람에게 답하는 것**이 목적이다.',
    '동료 에이전트에게만 말하고 끝내지 말고, 최종 답은 요청자를 `@handle` 로 부르며 쓴다.',
    '',
    // 2026-09-09 실측: harkroom 가 보고 한가운데 "구현은 `@forge` 것이고" 라고 **지칭**했더니
    // forge 의 턴이 떴고, forge 의 답이 다시 harkroom 를 지칭해 5분에 네 턴이 오갔다. 그날
    // dev DB 의 에이전트→에이전트 멘션 122건 중 47건(39%)이 부를 뜻 없는 지칭이었다.
    //
    // 이제 서버가 자리로 그것을 가른다(`shared/splitMentionCalls`) — 그래서 이 문단은 규칙을
    // **강제하는** 것이 아니라 **알려 주는** 것이다. 강제는 코드가 하고, 이 줄이 없으면
    // 에이전트는 부른 줄 알았던 동료가 오지 않는 이유를 모른다. `addressesHuman` 과 위
    // 문단이 한 쌍인 것과 같은 짝이다.
    '**동료 에이전트를 부르는 것과 지칭하는 것은 다르다.** 다른 에이전트에게 일을 넘길 때만',
    '`@handle` 로 부르고, 그 이름은 **본문 맨 앞**에 둔다 — 맨 앞의 멘션만 상대의 턴을 띄운다.',
    '보고 한가운데서 동료를 가리킬 때는 `@` 없이 이름만 쓴다(예: "구현은 forge 것이다").',
    '거기에 `@` 를 붙여도 상대는 오지 않지만, 읽는 사람에게는 부른 것처럼 보인다.',
    '**사람을 부르는 것은 이 규칙과 무관하다** — 사람은 어디에서 불러도 알림을 받는다.',
    '',
    // 2026-10-01(스레드별 모델 지정 후속, jaebin 결정 1~11, 서버 #1010). 새 어휘는 지시문이 있어야
    // 쓰인다(mem/new-vocabulary-needs-a-prompt) — 서버는 `message.post`·`message.delegate` 의
    // `agentModels` 와 `agent.modelOptions` 를 받지만, 이 문단이 없으면 아무도 그것을 고르지 않는다.
    // 막는 쪽은 서버다(자기 자신 403, 소유자 목록 밖 403, 사람 지정 409, 스레드당 3번 429). 여기서는
    // 그 규칙을 **알려** 헛된 시도를 줄이고, 고른 이유를 사람이 읽을 수 있게 남기게 한다.
    '다른 에이전트를 부르거나 일을 넘길 때(`message.post`·`message.delegate`) `agentModels` 로 **그',
    '스레드에서 그 상대가 쓸 모델·effort** 를 고를 수 있다. 먼저 `agent.modelOptions(handle)` 로 고를 수',
    '있는 조합을 본다 — 목록이 비어 있으면 고르지 말고 그냥 부른다(그 상대의 소유자가 허용하지 않았다).',
    '고르면 그 이유를 본문에 한 줄 적는다(예: "설계 검토라 fable·high 로 부른다"). 자기 자신의 모델은',
    '고를 수 없고, 사람이 그 스레드에 정해 둔 모델은 덮거나 풀지 마라(서버도 거절한다). 비싼 조합은',
    '그 일이 정말 필요로 할 때만 고른다.',
    '',
    // 2026-09-08 오후, jaebin 의 요청으로 **기본값을 뒤집었다.** 아침까지 이 자리는 "채널
    // 최상위 요청에는 `alsoInChannel: true` 를 주라"였다. 반나절 만에 되돌린 이유는 처방이
    // 병보다 나빴기 때문이다: PR 진행 보고처럼 긴 답이 전부 채널로 올라와, 사람이 **자기가
    // 올린 요청**을 채널 화면에서 찾을 수 없게 됐다. 채널은 무슨 일이 있었나를 훑는 자리이고
    // 답 본문의 자리가 아니다.
    //
    // 되돌려도 위 ②(채널만 보는 사람에게 자기 질문 뒤가 비어 보인다)가 그대로 돌아오지는
    // 않는다: 채널 요약 줄이 루트 메시지에 **답글 수**를 그린다(`MessageItem` 의 `hasReplies`
    // — 서버가 스레드 루트에 `replyCount` 를 실어 준다). 답이 스레드에만 있어도 채널에는
    // "답글 N개"가 남으므로 사람은 답이 온 것을 알고 눌러 들어갈 수 있다. 즉 ② 의 짝은 이제
    // 에코가 아니라 답글 수이고, 에코는 **명시적으로 요청받았을 때의 예외**로만 남는다.
    '답은 **스레드 안에만** 남기는 것이 기본이다 — `message.post` 에 `alsoInChannel` 을 붙이지',
    '않는다. 채널에는 답글 수가 남으므로 사람은 답이 온 것을 안다. 요청자가 "채널에도 올려라 /',
    '공지해라 / 다른 사람도 봐야 한다"고 **명시적으로** 말한 경우에만 `alsoInChannel: true` 를',
    '준다 — 애매하면 붙이지 않는다.',
    '',
    // #90: 한 턴에서 message.post 를 여러 번 부르면 같은 스레드에 답이 여러 개 남는다.
    // 금지형("절대 두 번 부르지 마라")보다 "한 번에 정리한다"가 모델에게 실행 가능한 지시다.
    // 러너는 이걸 강제하지 못한다 — 하네스 출력을 파싱하지 않는다는 경계(pty.ts) 때문이다.
    // 그래서 이 문장이 유일한 예방이고, 위반은 턴 후 개수를 세어 러너 로그에 남긴다.
    '한 턴에 한 번만 발화한다 — 답이 길어도 나눠 올리지 않고 한 번에 정리해서 올린다.',
    '',
    // 2026-10-02(미리보기 PR ②, 스레드 31121b84): 디자인 안을 claude.ai 아티팩트 링크로 주면 그 브라우저에
    // 회사 계정으로 로그인한 사람만 연다 — jaebin 이 폰 스레드에서 링크를 눌렀다가 막혔다. 새 도구를 만들고
    // 프롬프트에 안 적으면 아무도 안 쓴다(message.delegate #762 → #809 의 교훈). 그래서 같은 PR 에서 적는다.
    '사람이 **눈으로 볼 HTML**(디자인 안·시안·보고서 페이지)은 claude.ai 아티팩트 링크로 주지 말고',
    'harkroom MCP 의 `artifact.publish`(channelId·threadRootId·title·body·html)로 올린다 — 그 글이 이',
    '턴의 발화다. 사람은 앱 안 카드를 눌러 바로 본다(폰 포함). 한 파일에 다 담아라: 페이지는 외부로',
    'fetch 할 수 없고, 스크립트·스타일·폰트는 cdnjs·jsdelivr·Google Fonts 에서만 불러온다. 같은 안을',
    '고칠 때는 앞서 받은 `artifactId` 를 함께 줘서 다음 버전으로 올린다. 그 도구가 없으면 지금처럼 글로 쓴다.',
    '',
    // #144: 긴 작업 시작 시 진행 설명 — message.progress MCP 도구로 올린다.
    // 이것은 결과 발화로 세지 않으며, 사용자가 읽을 수 있어야 뜻이 있다.
    // 진행 설명 예시: "avcs intent 를 만들고 merge3 결함 재현 테스트부터 붙인다 — 서너 턴 걸린다"
    '긴 작업을 시작할 때는 먼저 `message.progress` MCP 도구로 짧게 무슨 작업인지 설명하고 들어간다. ',
    '이 진행 설명은 결과 발화로 세지 않으며, 사용자가 기다릴지 끊을지 판단할 근거를 준다.',
    '',
    // 2026-09-07 15:08: PR #533 을 올린 턴이 CI 대기 루프를 **백그라운드로** 띄우고
    // "결과 나오면 머지하겠다"며 끝났다. 그 계획은 실행되지 않았다 — 프로세스가 죽었고
    // 루프도 함께 죽었으며, 4분 뒤 초록이 된 CI 를 아무도 보지 않았다. 위의 지시는 "어디에
    // 쓸지"만 말하고 **언제까지 살아있는지**를 말하지 않았고, 그 공백이 실행 불가능한
    // 계획을 낳았다. 이 세 문장이 그 공백을 메운다.
    // 2026-10-02(미리보기 PR ③): 에이전트는 글에 파일을 붙일 길이 없었다(message.post 에 첨부 인자가 없었다).
    // 바이너리를 base64 로 쓰게 하지 않고 경로로 올린다 — 오퍼레이터가 읽는다. 새 도구는 적어야 쓰인다(#762→#809).
    // 2026-10-02(찾기 S2, 스레드 20323649): `message.search` 가 REST 와 같은 범위·거르기를 받게 됐다. 전에는
    // 검색어 하나만 받아서, 에이전트는 "지난번에 그 말이 어디 있었나"를 채널을 통째로 `message.read` 로
    // 넘겨 읽어 찾았다. 새 인자는 적어야 쓰인다(#762→#809).
    '지난 대화에서 **무엇이 어디 있었는지 찾을 때**는 채널을 통째로 `message.read` 로 넘겨 읽지 말고',
    '`message.search` 를 쓴다 — `channelId`·`threadRootId` 로 범위를, `authorIds`(계정 id, `account.list`)·',
    '`after`·`before`(시간대 붙은 ISO)·`hasAttachment`·`sort: "recent"` 로 거르고, `hasMore` 면 `offset` 으로 잇는다.',
    '',
    '그림·PDF·HTML 같은 **파일을 글에 붙이려면** 파일을 턴 워크스페이스(지금 작업 디렉터리) 안에 두고',
    'harkroom MCP 의 `attachment.upload`(path)로 올려 첨부 id 를 받은 뒤, `message.post` 의 `attachmentIds` 로',
    '붙인다. 워크스페이스 밖 파일은 거절되니 먼저 복사한다. 로컬 경로만 적어 두면 사람은 그 파일을 못 본다.',
    '',
    '네가 말을 멈추면 이 프로세스는 그 자리에서 죽는다. "나중에", "결과가 나오면"은 실행되지',
    '않는다 — 백그라운드로 띄운 명령도 프로세스와 함께 죽는다.',
    '',
    ...(budgetMinutes === null ? [] : [
      `이 턴의 예산은 ${budgetMinutes}분이다. 그 안에 끝나는 기다림은 포그라운드에서 기다려도 된다.`,
      '',
    ]),
    '더 기다려야 하면 **지금 아는 것을 `message.post` 로 남기고**, harkroom MCP 의 `turn.wake` 로',
    '다시 볼 시각을 예약하고 끝낸다(예: CI 결과 확인 — 5분 뒤). 예약은 스레드에 대기 줄로',
    '보이고, 시각이 되면 **이 세션이 그대로 이어져** 다시 시작한다 — 조사한 것을 다시 조사할',
    '필요가 없다. 예약을 건 턴은 결과 발화 없이 끝내도 된다.',
    // 2026-10-06: 깨어난 턴은 자기 앵커 스레드만 안다. 다른 스레드에서 한 "몇 시에 확인한다" 약속은
    // 사유 한 줄에 없으면 사라졌다(task_manager 실측) — 약속한 곳을 기계가 읽는 인자로 받는다.
    '결과를 **다른 스레드에** 보고하기로 약속했으면 `turn.wake` 의 `reportTo`(그 채널·스레드 id)를 준다 —',
    '깨어난 턴은 자기 스레드만 알아서, 주지 않으면 그 약속을 모른다.',
    '',
    // 2026-09-30(ebb97c7b): slack MCP 가 인증을 요구하자 턴이 `authenticate` 로 OAuth 를 열고
    // 콜백을 포그라운드로 기다렸다. 흐름은 그 프로세스 안에만 살아 턴과 함께 사라졌고, 다음 턴에
    // 사람이 붙여 준 콜백 URL 은 `No OAuth flow is in progress` 로 떨어졌다. 인증 코드는 채팅에 남았다.
    // 인증은 사람이 데스크톱에서 한 번 하는 일이다 — 턴은 그 사실을 알리고 물러난다.
    'MCP 서버가 인증을 요구하면(`requires authentication`, `authenticate` 도구만 보인다) **턴 안에서',
    '인증 흐름을 열지 마라** — 그 흐름은 이 프로세스 안에만 살아서 턴이 끝나면 사라진다. 콜백 URL·',
    '인증 코드를 채팅에 붙여 달라고 하지도 마라. `message.fail`(retryable: true)로 어느 MCP 가 인증을',
    '요구하는지 적고, 데스크톱 설정의 MCP 절에서 그 서버를 인증해 달라고 안내한 뒤 끝낸다.',
    '',
    // 2026-10-01(결정 10, 설계 검토 스레드 b64632ac): 에이전트가 턴 모델이 기대와 다르다는 실패에
    // 스스로 `code: thread_model_rejected` 를 붙였다. 그 표지는 앱 실패 카드에 [기본으로 되돌리고 다시
    // 부르기]를 띄워, 사람이 막 정한 지정을 지우게 만든다. 표지는 러너가 하네스 거절을 볼 때만 단다.
    '`message.fail` 의 `code` 는 러너가 붙이는 표지다 — 너는 싣지 마라.',
    '',
    `답변은 ${BODY_LIMIT}자를 넘길 수 없다(서버가 거절한다). 채팅이므로 짧고 구체적으로 쓴다.`,
    '모르는 것은 모른다고 말한다. 확인하지 않은 것을 확인한 것처럼 쓰지 않는다.',
  ].join('\n');
}

/**
 * 팀장으로 불린 턴의 **팀 블록**(047).
 *
 * ## 무엇을 적는가, 그리고 왜
 *
 * 이 블록이 없던 동안 팀 부름은 팀원 수만큼 턴을 띄웠고, 각 턴은 자기가 팀으로 불렸다는
 * 사실조차 몰랐다(inbox 사유가 `mention` 하나였다). 그래서 넷이 같은 요청을 각자 처음부터
 * 풀고 넷이 각자 사람에게 답했다 — 서버가 창구를 하나로 좁혀도(047) 그 하나가 **명단을
 * 모르면** 달라지는 것은 "혼자 다 한다" 뿐이다. 그래서 두 가지를 함께 적는다:
 * **누가 있는가**(명단)와 **네가 무엇인가**(창구).
 *
 * `@` 를 붙여 적는 이유: 넘길 때 쓰는 문자열이 그대로 보여야 한다. 대신 **맨 앞에 두어야
 * 턴이 뜬다**는 것을 함께 말한다 — 그 규칙은 워크스페이스 가이드에도 있지만, 여기서 명단을
 * 주면서 말하지 않으면 팀장은 문장 가운데에 이름을 적고 아무도 오지 않는 것을 본다.
 *
 * 비활성 팀원을 **지우지 않고 표시한다**. 036 이 정한 것과 같은 판단이다(*"명단을 지우지
 * 않는다"*): 지우면 팀장은 그 이름을 아예 모르고, 사람이 "왜 codex 를 안 썼나" 라고 물을 때
 * 답할 근거가 없다. 넘겨도 깨지 않는다는 사실을 함께 적어 **고르지 않게** 만드는 것이 맞다.
 *
 * 자기 자신은 명단에서 **빼지 않는다** — 팀장도 팀원이고(046 의 복합 FK), 목록에서 자기가
 * 빠지면 "이 팀은 나 말고 셋" 처럼 읽혀 팀 크기를 잘못 판단한다. 대신 그 줄에 `(너)` 를
 * 붙인다: 자기에게 넘기려 드는 것을 막는 가장 짧은 표시다.
 *
 * ## 기다리지 않는다는 것을 말한다
 *
 * 지금은 위임 왕복이 없다 — 팀원이 스레드에 답해도 팀장은 깨지 않는다(`thread_reply` 는
 * 스레드 루트 작성자에게만 간다). 그 사실을 적지 않으면 팀장은 "팀원 답을 기다렸다가
 * 취합하겠다" 는 계획을 세우고, 그 계획은 실행되지 않는다(프로세스가 끝나면 턴이 죽는다 —
 * `buildSystemPrompt` 의 그 문단이 같은 공백을 메운다). 그래서 넘긴 턴은 **넘겼다는 것을
 * 사람에게 말하고 끝내는 것**이 지금의 올바른 종료다.
 */
/**
 * 머지 절(스레드 3deac356). 새 어휘(래퍼)를 만들면 **같은 PR 에서 프롬프트에 쓰라고 적고 옛 지시를 지운다**
 * (mem/new-vocabulary-needs-a-prompt — `message.delegate` 가 한 번도 안 쓰인 사례). 그래서 여기서 `gh pr merge`
 * 를 이름 대어 금지한다. 저장소 이름은 서버에서 온 값이라 그대로 적는다.
 */
/**
 * 외부 API 절(C안 P3, 스레드 07519d86). 같은 PR 에서 새 래퍼를 쓰라고 적고, 10-03 사고의 옛 습관(채팅에서 키를 찾아 curl 에
 * 넣기)을 이름 대어 금지한다. 연결 이름은 서버에서 온 값이다(이름 규칙을 러너가 한 번 더 걸렀다).
 */
function apiSection(api: { operatorBin: string; connectors: readonly string[]; delegatable?: readonly string[] }): string[] {
  const never = '**API 키·토큰을 채팅·옛 글·파일에서 찾아 쓰지 마라.** `curl -H \'Authorization: …\'` 처럼 명령에 키를 넣으면 막히고, 막힌 것을 다른 방법으로 돌아가지 않는다.';
  if (!api.connectors.length) {
    return [
      never,
      '이 에이전트에게 허락된 외부 API 연결이 없다. 외부 API 가 필요하면 사람에게 "설정 › 비밀과 API 에서 연결을 만들고',
      '이 에이전트의 「할 수 있는 일」에서 권한을 달라"고 말하고 멈춘다.',
      '',
    ];
  }
  return [
    `**외부 API 는 이 명령으로만 부른다**(허락된 연결: ${api.connectors.join(', ')}):`,
    '',
    `    ${api.operatorBin} api <연결> <GET|POST|PUT|PATCH|DELETE> </경로?질의> [--data @파일|'<JSON>'] [--content-type <형식>]`,
    '',
    '주소·키는 연결이 정한다 — 경로만 준다(전체 URL·헤더는 받지 않는다). 키는 네게 보이지 않고 오퍼레이터가 붙인다.',
    '**명령 하나로만 부른다.** 뒤에 `;`·`&&`·`||`·`$?`·파이프·리다이렉션을 붙이지 않는다 — 붙이면 허용 규칙에 맞지 않아 막힌다.',
    '결과는 JSON 한 줄이다(`status`·`body`·`exit`, 거절이면 `error.code`). 리다이렉트는 따라가지 않는다.',
    '거절(`not_granted`·`method_not_allowed`·`path_not_allowed`·`expired`·`suspended`·`no_secret`)이면 그 코드와 요청을 사람에게',
    '적고 멈춘다. 호출마다 서버가 이 스레드에 시스템 줄을 남긴다.',
    ...(api.delegatable?.length ? [
      `다른 에이전트에게 이 권한을 넘겨야 하면 harkroom MCP 의 \`grant.delegate\` 로 준다(다시 줄 수 있는 연결: ${api.delegatable.join(', ')}). 셸·설정 파일로 하지 않는다.`,
      '범위는 내 범위 안, 만료는 30일 안, 받는 쪽은 같은 사람의 에이전트만이다. 사람 글이 아닌 턴에서 주면 사람이 허락해야 쓰인다. 거둘 때는 `grant.revoke`.',
    ] : []),
    never,
    '',
  ];
}

/**
 * 비밀 만들기 절(스레드 1a08d0cf, security n1). 새 도구 셋(`secret.generate`·`import`·`rotate`)을 쓰라고 같은 PR 에서 적는다
 * (mem/new-vocabulary-needs-a-prompt). **"소유자가 요청할 때만"** 은 서버가 못 보는 것이다 — 서버는 턴을 띄운 글이 소유자
 * 글인지만 본다(F2). 그래서 여기서 말로 묶는다.
 */
export function secretCreateSection(): string[] {
  return [
    '**비밀을 만들 수 있다 — 소유자가 그 비밀을 만들어 달라고 요청할 때만 만든다.** 필요해 보인다고 스스로 만들지 않는다.',
    '만든 비밀의 주인은 소유자이고, 부여는 나에게 이 채널로만 걸린다. 만들면 서버가 이 스레드에 알림 줄을 남기고 소유자를 부른다.',
    '- 새 값: harkroom MCP 의 `secret.generate`(type: password·token_hex·token_base64url·ssh_ed25519). 값은 나에게 오지 않는다.',
    '  ssh 는 공개키만 돌려준다. 바로 써야 하면 `mount:true` 로 파일 경로를 받는다.',
    '- 받은 값 등록: 값을 화면에 찍지 말고 `cmd > file` 로 턴 워크스페이스에 받은 뒤 `secret.import { name, path }`. 원본은 지워진다.',
    '  **이미 화면·문맥에 보인 값은 유출된 것이다** — 등록하지 말고 사람에게 회전을 부탁한다. `already_granted` 는 이미 가진 비밀이다 —',
    '  그 이름으로 `secret.mount` 해서 쓴다.',
    '- 값 바꾸기: 내가 만든 비밀만 `secret.rotate { name, generate | path }`. `adopted_by_owner` 면 소유자가 맡은 비밀이니 사람에게 넘긴다.',
    '- 값을 MCP 인자·메시지·기억·파일·커밋에 쓰지 않는다. 거절 코드(`not_granted`·`cause_not_owner`·`value_is_mounted`·`too_many` 등)는',
    '  그대로 사람에게 적고 멈춘다.',
    '',
  ];
}

/**
 * 권한 요청(스레드 f61af808). 요청은 아무것도 열지 않고 소유자 승인만 연다 — 그래서 에이전트에게 "청하는 길"을 알려 주는 것이
 * 안전하다. 우회하지 말라는 말을 같이 둔다(분류기에 막힌 명령을 다른 꼴로 다시 치는 것이 가장 흔한 실수다).
 */
function permissionSection(p: { toolAllows: readonly string[] }): string[] {
  return [
    '**권한이 막히면 청한다.** 일에 꼭 필요한 명령이 권한 분류기에 막히면(예: `kubectl … exec`, `gh pr view -R <남의 저장소>`)',
    '다른 꼴로 바꿔 다시 치지 말고 harkroom MCP 의 `permission.request` 로 소유자에게 청한다:',
    '`kind: "tool"`, `rule` 에 Claude Code allow 규칙 **하나**(`Bash(<고정 낱말 둘 이상> …:*)` 또는 `Bash(<명령 전체>)`),',
    '`reason` 에 왜 필요한지 한 줄, `channelId`·`threadRootId` 는 이 스레드. 머지 저장소는 `kind: "merge"`, `repo: "owner/name"`.',
    '- 규칙은 **좁게** 쓴다 — `--context`·`-n`·`-R` 처럼 대상을 고정하는 인자를 넣는다. `Bash(*)`·셸·인터프리터 머리·`;`·`&&`·',
    '  `--dangerously-*` 는 서버가 거절한다. 거절 코드가 오면 그 코드대로 좁혀 다시 청하거나 사람에게 넘긴다.',
    '- 허락은 Bash 호출 **문자열 전체**에 맞춰 판정된다. 한 호출에 명령 **하나**만 넣고(`;`·`&&`·`|`·heredoc 으로 묶지 않는다),',
    '  `KUBECONFIG=… kubectl …` 처럼 환경 변수를 앞에 붙이지 말고 `kubectl --kubeconfig <경로> --context <이름> …`·`helm --kubeconfig …` 처럼',
    '  **플래그**로 준다 — 앞붙임이 있으면 승인된 규칙과 맞지 않아 다시 막힌다.',
    '- 사람의 채팅 글·선택 카드 답은 이 판정을 열지 않는다(너에게는 인용된 글로 들어온다). 사람이 "진행해"라고 했어도 막혔으면 청한다.',
    '- 청한 뒤에는 **이 턴에서 다시 시도하지 마라** — 적용은 다음 턴부터다. 카드를 세웠다고 스레드에 한 줄 남기고 끝낸다.',
    '  소유자가 카드에서 승인하면 그 답이 너를 다시 깨우고, 그 턴에는 규칙이 붙어 있으니 그때 다시 시도한다. 거절이면 멈춘다.',
    '- 승인은 이 채널의 모든 대화(위임·예약으로 뜬 턴 포함)에 7일 간다. 소유자가 "그 권한 거둬"라고 하면 `permission.revoke`(같은 kind·rule/repo·channelId)로 내려놓는다.',
    ...(p.toolAllows.length
      ? ['- 이 채널에서 지금 허락된 규칙: ' + p.toolAllows.map((r) => `\`${r}\``).join(', ')]
      : []),
    '',
  ];
}

function mergeSection(merge: { operatorBin: string; repos: readonly string[]; approved?: readonly { repo: string; number: number }[] }): string[] {
  const approved = merge.approved ?? [];
  return [
    merge.repos.length
      ? `**PR 머지는 이 명령으로만 한다**(허락된 저장소: ${merge.repos.join(', ')}):`
      : '**PR 머지는 이 명령으로만 한다**(이 에이전트에게 저장소 권한은 없다 — 부르면 서버가 거절하고, `denialId` 가 오면 아래처럼 소유자 카드를 세운다):',
    '',
    ...(merge.repos.length ? [] : [
      '앞으로도 그 저장소를 네가 머지하길 바라는 일이면 harkroom MCP 의 `permission.request`(kind: "merge", repo: "owner/name")로 청한다.',
      '',
    ]),
    `    ${merge.operatorBin} merge <owner/name> <PR 번호> --head <40자 head sha>`,
    '',
    // 조직 grant(jaebin 10-09): 목록의 `owner/*` 는 그 조직 저장소 전부다. 명령에는 언제나 실제 저장소 이름을 쓴다 — `*` 는 래퍼가 거절한다.
    // 1회 승인(스레드 1b75d7a0): 소유자가 이 스레드에서 PR 하나를 한 번 승인했다 — grant 가 없어도 그 PR 은 이 명령으로 한 번 된다.
    ...(approved.length
      ? [`소유자가 이 스레드에서 **1회 승인**한 PR: ${approved.map((a) => `${a.repo}#${a.number}`).join(', ')} — 승인한 head 로 위 명령을 한 번 부른다.`,
        '승인한 head 와 지금 head 가 다르면 승인이 쓰이지 않고 거절된다(다시 승인받는다).', '']
      : []),
    ...(merge.repos.some((r) => r.endsWith('/*'))
      ? ['`owner/*` 는 그 조직의 저장소 전부다. 명령에는 `*` 가 아니라 실제 `owner/name` 을 쓴다.', '']
      : []),
    // 2026-10-03 사고: `…merge … ; echo "exit=$?"` 처럼 꼬리를 붙이면 allow 규칙(`Bash(<경로> merge:*)`)이 안 맞아
    // 분류기로 가고, 실제 머지는 "막힌 머지를 돌아가는 길"로 거부된다. 종료 코드·결과는 JSON 에 있다(exit·merged).
    '**명령 하나로만 부른다.** 뒤에 `;`·`&&`·`||`·`$?`·파이프·리다이렉션을 붙이지 않는다 — 붙이면 허용 규칙에 맞지 않아',
    '막힌다. 인자는 저장소·PR 번호·`--head` 셋뿐이다(`--approval`·`--admin` 같은 것은 없다). 결과는 JSON 한 줄로',
    '나온다(`merged`·`exit`·거절이면 `error.code`).',
    '`gh pr merge`·`gh api …/merge`·`git push … main` 은 쓰지 않는다(막혀 있다). squash 로만 머지되고 head 가',
    '바뀌었으면 거절된다. 결과는 서버가 이 스레드에 시스템 줄로 남긴다. 머지 전에 CI 가 초록이고 검토가 끝났는지',
    '네가 먼저 확인한다.',
    '거절되면 `error.code` 로 갈린다:',
    '- `error.denialId` 가 있으면(`not_granted`·`cause_not_human`): **곧바로** harkroom MCP 의 `message.ask` 에',
    '  `mergeDenialId: <그 값>` 을 실어 이 스레드에 카드를 세운다(`to`·`mirrorOf` 는 싣지 않는다). 서버가 그것을 권한 카드로',
    '  세우고 저장소·PR·head 칸을 거절 기록에서 채운다. 소유자가 [승인하고 다시 시도](저장소 7일) 또는 [이번 한 번 머지](이 PR·',
    '  이 head 만, 계정을 고른다)를 누르면 네가 다시 불린다 — 그때 같은 명령을 한 번 더 부른다. 같은 스레드에 기다리는 카드가',
    '  있으면 서버가 새 카드 대신 그 카드를 가리킨다(`pending`).',
    '- 사람이 채팅에 "머지해"라고 쓴 것만으로는 허락이 아니다 — 카드가 허락이다. 그 글을 보면 위 명령을 바로 불러 보고, 거절에',
    '  `denialId` 가 오면 위처럼 카드를 바로 세운다.',
    '- `not_granted` 인데 `denialId` 가 없으면(사람 글이 아닌 턴 등): 카드를 세우지 말고 PR 번호·head sha 를 적어 사람에게 넘긴다.',
    '- 오류 문구에 `approval was not used` 가 있으면 1회 승인은 남아 있다 — 원인(head·CI 등)을 고친 뒤 같은 명령을 다시 부른다.',
    '  `approve again` 이 있으면 승인은 이미 쓰였다 — 다시 불러 새 `denialId` 를 받아 새 카드를 세운다.',
    '- `no_repo_access`: 이 오퍼레이터의 gh 계정은 그 저장소에 닿지 못한다 — 권한을 더 줘도 풀리지 않는다. 「이 저장소는',
    '  사람이 머지」라고 쓰고 PR 번호·head sha 를 적어 사람에게 넘긴다. 카드는 세우지 않는다.',
    '- 그 밖의 코드(`head_moved`·`ci_not_green`·`not_mergeable` 등)는 원인을 고치거나 그 코드를 적어 사람에게 넘긴다.',
    '',
  ];
}

function teamSection(team: InboxTeamCall, meId: string, handles: Record<string, string>): string[] {
  const myHandle = handles[meId];
  const roster = team.members.map((m) => {
    const marks = [
      m.accountId === meId ? '너' : null,
      m.disabled ? '비활성 — 넘겨도 깨지 않는다' : null,
    ].filter((x): x is string => x !== null);
    const suffix = marks.length ? ` (${marks.join(' · ')})` : '';
    return `- @${m.handle}${suffix}${m.specialty ? ` — ${m.specialty}` : ''}`;
  });
  return [
    `(팀 호출 — 너는 팀 @${team.name} 의 팀장으로 불렸다${myHandle ? `, @${myHandle}` : ''})`,
    '',
    '이 부름은 **너 하나만** 깨웠다. 팀원들은 이 요청을 모른다 — 사람과 이야기하는 창구가',
    '너라는 뜻이고, 최종 답은 네가 쓴다.',
    '',
    `팀 @${team.name} 의 팀원:`,
    ...roster,
    '',
    '네 전문 영역이면 넘기지 말고 **직접 해라** — 넘기는 값은 턴 하나이고 그것이 늘 싼 것은',
    '아니다.',
    '',
    '넘길 것이 있으면 **`message.delegate` 를 써라**(`to` 에 팀원 handle 들). 평범한 멘션으로',
    '부르지 마라 — 그러면 서버가 그것을 위임으로 알지 못해 **결말이 너에게 돌아오지 않는다.**',
    '이 도구는 그 팀원을 부르는 것까지 함께 한다(본문 어디에 이름을 적었는지는 상관없다).',
    '',
    '**넘긴 답을 기다리며 멈춰 있지는 마라 — 그래도 네가 다시 깨어난다.** 넘긴 일이 전부',
    '끝나거나 기한이 지나면 서버가 너를 깨우고, 그때 팀원마다 `끝남`·`실패`·`무응답`·`취소`',
    '중 무엇인지 받는다. 기한은 기본 10분이고 `deadlineSec` 로 늘릴 수 있는데, 팀원이 진행을',
    '올리거나 그 턴이 도는 동안은 자동으로 밀린다.',
    '',
    // 2026-09-16 실측: 팀장이 넘긴 뒤에도 자기 몫을 더 해 **데모 전에 알아야 할 것**을 먼저
    // 올렸다. 앞 판의 문장("넘기고 턴을 끝내라")은 그것을 금지하는 것처럼 읽혔는데, 그 판단은
    // 실제로 유용했다 — 규칙이 너무 좁았다. 그래서 금지를 풀고 **경계만** 남긴다: 넘긴 일의
    // 결과를 대신 짐작해 답하지 말 것.
    '넘긴 뒤에 **네가 할 수 있는 일은 계속해라.** 네 몫의 조사·확인은 그대로 하고, 사람이',
    '알아야 할 것이 지금 생기면 지금 말해라. 다만 **최종 답은 결말이 난 뒤**에 쓴다 — 넘긴',
    '일의 결과를 짐작해서 미리 결론 내지 마라.',
    '',
    '위임 메시지의 본문은 **팀원에게 주는 지시**다. 요청자에게 할 말은 거기 섞지 말고, 결말이',
    '나서 다시 깨어났을 때 **최종 답 하나**로 써라 — 지시와 보고가 한 메시지에 섞이면 사람은',
    '자기에게 온 말과 팀 안의 말을 구별할 수 없다.',
    '',
  ];
}

/**
 * 넘긴 일의 **결말 블록**(050).
 *
 * ## 왜 결말을 글자로 적는가
 *
 * 팀장은 이 턴에서 세 갈래 중 하나를 골라야 한다 — 취합해서 답한다 / 다시 넘긴다 / 사람에게
 * 막혔다고 말한다. 그 선택은 **각 팀원이 어떻게 끝났는지**에 달렸고, 스레드를 다시 읽어
 * 짐작하게 만들면 무응답(아무 말도 없는 상태)을 "아직 도는 중"으로 읽는다. 아무 말도 없는
 * 것과 기한이 지난 것은 스레드에서 구별되지 않으므로, 그 사실은 프롬프트가 말해야 한다.
 *
 * ## 남은 라운드를 함께 적는다
 *
 * 다시 넘기는 것은 라운드를 먹는다(무한 왕복을 막는 유일한 장치다 — 멘션 상한은 이 경로를
 * 막지 못한다). 팀장이 그것을 **모르고** 넘기면 상한에 걸린 거절을 받고 그때 다시 판단해야
 * 하는데, 그 시점엔 이미 턴 하나를 태웠다. 그래서 고르기 **전에** 알려 준다.
 *
 * 0 이면 "다시 넘길 수 없다"를 명시한다 — 남은 수가 0 이라는 사실만으로는 모델이 그 결론에
 * 이르지 않는다(실행 가능한 지시가 아니라 숫자일 뿐이다).
 */
function delegationSection(outcome: InboxDelegationOutcome): string[] {
  const label: Record<InboxDelegationOutcome['items'][number]['outcome'], string> = {
    done: '끝남',
    failed: '실패 — 그 일은 아직 남아 있다',
    timeout: '무응답 — 기한이 지났다(살아 있는지 알 수 없다)',
    canceled: '취소 — **사람이 멈췄다**',
  };
  const unresolved = outcome.items.some((i) => i.outcome !== 'done' && i.outcome !== 'canceled');
  /**
   * 취소는 **다시 시작하면 안 되는 결말**이라 따로 말한다(051).
   *
   * 무응답과 실패에는 *"직접 하거나 다시 넘겨라"* 가 맞다. 취소는 반대다 — 사람이 그것을
   * 원하지 않았으므로 다시 시작하면 **사람의 결정을 무르는 것**이다. 그 구별을 적지 않으면
   * 팀장은 셋을 같은 눈으로 보고, 중단한 일을 곧바로 되살린다(이 결말을 `timeout` 과 가른
   * 이유가 그것이다).
   */
  const canceled = outcome.items.filter((i) => i.outcome === 'canceled').map((i) => `@${i.handle}`);
  return [
    outcome.timedOut
      ? '(넘긴 일의 기한이 지났다 — 결말은 아래와 같다)'
      : '(넘긴 일이 모두 끝났다 — 결말은 아래와 같다)',
    '',
    ...outcome.items.map((i) => `- @${i.handle} — ${label[i.outcome]}`),
    '',
    // 2026-09-16 실측: 팀장이 이미 처리된 일을 **다시 시켰다**. 팀원이 "닫았습니다" 라고
    // 답한 뒤인데도 같은 지시를 다시 보냈고, 팀원은 "앞 메시지가 엇갈린 것 같다" 고 답했다.
    // 이 블록은 결말을 **목록**으로 주므로, 그것만 읽고 본문을 건너뛰면 무엇이 이미 됐는지
    // 모른다. 그래서 목록 바로 뒤에서 본문을 가리킨다 — 가장 흔한 실수를 가장 가까운 자리에서.
    '**팀원이 무엇을 했는지는 이 목록이 아니라 그들의 보고에 있다.** 아래 대화에 그 보고가',
    '그대로 실려 있으니 **먼저 읽어라** — 이미 끝난 일을 다시 시키지 않으려면 그것이 유일한',
    '근거다(`끝남` 은 "무엇을 했는지" 를 말하지 않는다).',
    '',
    ...(canceled.length
      ? [
        `${canceled.join(' · ')} 의 일은 **사람이 멈춘 것**이다 — 다시 시작하지 마라. 무엇을 왜`,
        '멈췄는지 모르겠으면 최종 답에서 사람에게 확인해라.',
        '',
      ]
      : []),
    ...(unresolved
      ? [
        '끝나지 않은 것이 있다. **셋 중 하나를 골라라**:',
        '① 네가 직접 한다 ② 다른 팀원에게 다시 넘긴다 ③ `message.fail(retryable: true)` 로',
        '사람에게 넘긴다(무엇이 막혔는지 적어서).',
        outcome.roundsLeft > 0
          ? `다시 넘길 수 있는 남은 횟수는 ${outcome.roundsLeft}번이다.`
          : '**다시 넘길 수 없다** — 남은 횟수가 없다. ① 또는 ③ 이다.',
        '',
      ]
      : [
        '이제 **네가 취합해서 최종 답 하나**를 사람에게 쓴다 — 팀원들의 보고를 그대로 나열하지',
        '말고, 요청자가 물은 것에 답한다.',
        '',
      ]),
  ];
}

/**
 * **넘겨받은 일**의 블록(3-2) — 팀원의 턴이 *"내 발화는 팀장에게 오는 보고다"* 를 알게 한다.
 *
 * ## 이 블록이 화면을 조용하게 만든다
 *
 * jaebin 의 최초 진단은 *"에이전트들이 모두 이야기하니까 정신없다"* 였다. 서버가 창구를
 * 팀장 하나로 좁혀도(047) 넘겨받은 팀원이 **요청자에게** 답하면 화면은 그대로 시끄럽다 —
 * 데스크탑은 에이전트끼리의 구간을 접는데(`agentExchange`), 그 판정이 *"이 말이 사람에게
 * 오는가"* 를 보고 **사람을 `@handle` 로 부른 말은 접지 않기** 때문이다.
 *
 * 그래서 이 블록은 두 가지를 한다: 보고 대상을 팀장으로 못 박고, **요청자를 부르지 말라**고
 * 말한다. 그 둘이 화면의 접힘 규칙과 한 쌍이다.
 *
 * ## 기한을 말한다
 *
 * 이 팀원이 답하지 않으면 그 의무는 기한에 **무응답으로 닫히고** 팀장이 그 사실을 받는다.
 * 그때 팀장은 직접 하거나 다른 팀원에게 돌린다 — 즉 늦은 답은 버려지는 것이 아니라 **이미
 * 다른 사람이 하고 있는 일**이 된다. 그 시각을 모르면 팀원은 자기가 얼마나 여유가 있는지
 * 판단할 수 없고, 오래 걸리는 일에서 `turn.wake` 를 걸어야 할지도 알 수 없다.
 *
 * ## 실패는 예외라고 적는다
 *
 * "요청자를 부르지 마라"를 그대로 두면 막혔을 때도 침묵한다. 실패(`message.fail`)는 화면이
 * **언제나 펼치는** 말이고(`addressesHuman` 의 첫 조건), 그것이 맞다 — 막힌 것은 사람이
 * 봐야 한다. 그래서 그 하나를 명시적으로 열어 둔다.
 */
function handedSection(handed: InboxDelegatedBy): string[] {
  return [
    `(넘겨받은 일 — 팀 @${handed.teamName} 의 팀장 @${handed.leadHandle} 가 너에게 넘겼다)`,
    '',
    `**최종 답은 팀장이 쓴다.** 네 발화는 @${handed.leadHandle} 에게 오는 **보고**다 —`,
    '요청자(사람)를 `@handle` 로 부르지 마라. 네 보고까지 사람에게 직접 오면 창구가 둘이 되고,',
    '그것이 지금 고치고 있는 바로 그 시끄러움이다.',
    '',
    `기한은 ${handed.deadlineAt} 까지다. 그 안에 답하지 않으면 이 일은 **무응답**으로 닫히고`,
    '팀장이 직접 하거나 다른 팀원에게 돌린다 — 오래 걸릴 것 같으면 지금 아는 것을 먼저 보고해라.',
    '',
    '**막혔으면 `message.fail` 을 써라.** 실패는 사람에게도 보이는 유일한 예외다 — 막힌 것을',
    '조용히 두는 것이 가장 나쁘다.',
    '',
  ];
}

/** 한 줄로 렌더링한다. handles 에 없는 작성자는 알 수 없는 사용자로 표시한다(reply.ts 의 기존 정책 계승) —
 * avcs 투영이 만드는 system 메시지 등, 호출 시점에 handles 맵이 못 따라온 작성자가 있을 수 있다. */
function renderLine(m: MessageRow, handles: Record<string, string>): string {
  const handle = handles[m.authorId] ?? '알 수 없는 사용자';
  // **id 를 함께 싣는다.** 파일명만 있으면 에이전트는 그 첨부를 열 방법이 없어 내용을
  // 짐작하거나 못 봤다고 답한다(2026-09-08 실측 — 아래 attachmentHowTo 주석). id 는
  // `GET /attachments/:id` 의 유일한 열쇠이고, AttachmentRow 는 그것을 이미 들고 있었다.
  // contentType·sizeBytes 도 함께 준다 — 내려받기 전에 "열 수 있는 것인가, 얼마나 큰가"를
  // 판단할 근거다(200MB 짜리를 무조건 받게 만들지 않는다).
  const attachmentNote = m.attachments.length
    ? ` [첨부: ${m.attachments
        .map((a) => `${a.filename} (id ${a.id}, ${a.contentType}, ${a.sizeBytes}B)`)
        .join(', ')}]`
    : '';
  return `${handle}: ${m.body}${attachmentNote}`;
}

/**
 * 첨부 바이트를 **실제로 여는 방법**. 이 절이 없던 동안 무슨 일이 있었나(2026-09-08 실측):
 * 사람이 스크린샷을 붙여 "이 부분을 고쳐 달라"고 했고, 에이전트는 "첨부 스크린샷을 제가
 * 열지 못했습니다(파일이 제 쪽 디스크에 없었습니다)"라고 답한 뒤 **코드만 보고 어느 화면인지
 * 추측해** 고쳤다. 추측이 맞았지만 그것은 운이다.
 *
 * 정작 바이트는 그때도 닿을 수 있었다. 막힌 것은 통로가 아니라 **아는 것**이었다:
 *   - 하네스는 러너 env 를 통째로 물려받아 `HARKROOM_PAT` 을 들고 있다(turn.ts::childEnv).
 *   - 서버에는 `GET /attachments/:id` 가 계정 인가로 열려 있다(attachmentRoutes.ts).
 *   - 그런데 프롬프트는 파일명만 줬고(위 renderLine 의 옛 코드), 이 통로를 아무도 말해
 *     주지 않았다. 셋 중 어느 하나가 아니라 **id + 통로 안내**가 빠져 있었다.
 *
 * 통로를 **둘** 적는다. `curl` 이 먼저인 이유는 셸이 있는 하네스가 그 한 줄로 파일을 손에
 * 넣고 곧바로 자기 도구로 열 수 있기 때문이고, MCP `attachment.fetch` 를 함께 적는 이유는
 * **셸이 없는 하네스에는 그것이 유일한 통로**이기 때문이다(#585). 하나만 적으면 그 하나가
 * 없는 쪽 에이전트는 다시 "못 봤다"로 돌아간다.
 *
 * 첨부가 있는 턴에만 붙인다 — 대부분의 턴은 첨부가 없고, 그때 이 여덟 줄은 순전한 낭비다.
 *
 * **통로는 MCP 하나다**(스펙 2026-09-20 §5). 앞 판본은 `curl -H "Bearer $HARKROOM_PAT"` 도
 * 함께 적었는데, 러너가 서버를 모르게 되면서(URL 도 PAT 도 env 에 없다) 그 줄은 실행할 수
 * 없는 안내가 됐다 — 실행 못 할 것을 적어 두면 에이전트는 그것을 시도하다 실패하고 "못 봤다"
 * 로 돌아간다. `attachment.fetch` 는 브릿지를 지나 서버에 닿는다.
 *
 * **이미지만 실린다고 적지 않는다(#609).** 앞 판본이 그렇게 적었고, 그 문장이 맞는 동안에는
 * 로그·diff·`.json` 을 붙여 준 사람에게 에이전트가 *"파일명은 알지만 내용은 모른다"* 로
 * 답하는 것이 **정확한 행동**이었다. 지금은 텍스트도 실려 오므로 그 문장을 그대로 두면
 * 에이전트가 받을 수 있는 것을 안 받는다 — 안내가 낡으면 통로가 열려도 안 쓰인다.
 */
function attachmentHowTo(): string[] {
  return [
    '',
    '(위 `[첨부: …]` 의 id 로 첨부 바이트를 받을 수 있다 — 파일명만 보고 내용을 짐작하지 마라.',
    'harkroom MCP 의 `attachment.fetch` 를 attachmentId 로 불러라 — 이미지는 그림으로,',
    '로그·diff·`.json` 같은 텍스트는 글로 실려 온다. 긴 텍스트는 앞뒤만 오고 그때는 응답이',
    '`truncated` 로 그 사실을 말한다 — 잘린 것을 전부 본 것처럼 쓰지 마라.',
    '받기가 실패했을 때만 "못 봤다"고 말하고, 못 본 것을 본 것처럼 쓰지 마라.)',
  ];
}

/**
 * 스레드 델타를 하네스 턴 프롬프트로 조립한다(spec §4). `lastFedSeq` 보다 큰 seq 만
 * 대상이다. 첫 턴(lastFedSeq 0)은 세션 자체가 없으므로 자기 발화를 포함한 전체가 곧
 * "세션 이전 역사"라 그대로 넘긴다. resume 턴은 자기 발화를 뺀다 — 살아있는 세션이 이미
 * 안다. 단 **동료 에이전트의 발화는 절대 빼지 않는다** — 그러지 않으면 두 에이전트가 한
 * 스레드에서 각자 자기한테 온 멘션만 보는 독백이 되어 방금 동료가 끝낸 일을 다시 한다.
 */
export function buildTurnPrompt(opts: {
  messages: MessageRow[];
  lastFedSeq: number;
  meId: string;
  handles: Record<string, string>;
  /** 답을 올릴 채널·스레드. main.ts 가 멘션에서 이미 계산해 둔 값을 그대로 받는다(§4) —
   * messages 배열에서 다시 유도하지 않는다. 유도 규칙은 "루트 메시지 자신의 threadRootId
   * 는 null"이라는 데이터 구성에 기대는데, messages 가 루트 하나뿐이거나 채널 최상위
   * 발화들뿐이면 "스레드 없음"과 구별이 안 된다 — 우연히 맞는 경우가 많다고 안전한 게
   * 아니다. 호출자가 이미 알고 있는 값을 두 번째 진실 원천으로 다시 만들지 않는다. */
  channelId: string;
  threadRootId: string | null;
  /**
   * 이 턴이 **깨어난 턴**이면 그 사유(마이그레이션 040). 있으면 사람의 새 발화가 없어도
   * 프롬프트가 비지 않는다 — 깨움에는 부른 사람이 없고, 예약 줄을 쓴 것도 자기라서
   * 아래 자기-발화 필터에 전부 걸린다. 그대로 두면 `mentionTurn` 이 하네스를 돌리지
   * 않고 끝내, 걸어 둔 기다림이 조용히 사라진다.
   */
  wake?: { reason: string; reportTo?: WakeReportTo };
  /**
   * 이 부름이 **접은 내 예약**(서버 107, 2026-10-06). 사람이 이 스레드에서 부르면 걸어 둔 깨움이 전부 접히는데,
   * 전에는 이 턴이 그것을 몰라 "11:22 에 본다" 는 약속이 조용히 사라졌다. 델타를 대신하지 않는다 — 사람의
   * 새 발화 위에 덧붙는 맥락이다(`team` 과 같은 성격).
   */
  canceledWakes?: InboxCanceledWake[];
  /**
   * 이 턴이 **팀장으로서 불린 턴**이면 그 팀과 명단(마이그레이션 047).
   *
   * `wake` 와 나란히 두지만 뜻이 다르다: `wake` 는 사람의 새 발화가 **없을 때** 델타를
   * 대신하는 줄이고, 이것은 사람의 발화가 있는 위에 **덧붙는 맥락**이다. 그래서 아래
   * 조립에서 `toShow` 가 비었는지를 판정할 때 이 값은 세지 않는다 — 팀 부름인데 보여줄
   * 새 말이 없다면 그것은 이미 답한 말이고, 명단만으로 턴을 한 번 더 돌릴 이유가 없다.
   */
  team?: InboxTeamCall;
  /**
   * 이 턴이 **넘긴 일의 결말로 깨어난 턴**이면 그 결말(마이그레이션 050).
   *
   * `wake` 와 같은 성격이다 — **델타를 대신할 수 있어야 한다.** 기한이 지나 깨어난 경우엔
   * 팀원이 아무 말도 하지 않았으므로 새 메시지가 없고, 그러면 아래 빈-프롬프트 가드에 걸려
   * 하네스가 돌지 않는다. 그 자리에서 기다림이 흔적 없이 사라지는 것이 040 이 `wake` 를
   * 만든 이유이고, 여기서도 같다.
   */
  delegation?: InboxDelegationOutcome;
  /**
   * 이 턴이 **넘겨받은 일**이면 넘긴 팀장과 기한(3-2). 사람의 새 발화가 있는 위에 덧붙는
   * 맥락이라 `team` 과 같은 성격이고, 델타를 대신하지 않는다.
   */
  delegatedBy?: InboxDelegatedBy;
  /**
   * 이 턴이 **메시지 수정으로** 불린 턴이면 그 글(076). `wake` 처럼 **델타를 대신할 수 있다** —
   * 고친 글은 seq 가 옛날 그대로라 이미 본 구간이면 `messages` 에 없고, 그러면 아래 빈-프롬프트
   * 가드에 걸려 부름이 흔적 없이 사라진다.
   */
  editedMention?: MessageRow;
  /**
   * **예약 깨움을 새 세션으로 돌린다**(2026-10-09). 참이면 머리(채널·스레드 id)와 깨움 사유에
   * "새 세션이다" 안내(`freshWakeLines`)를 붙인다. 스레드의 큰 세션을 이어받던 짧은 확인 턴이 비용의
   * 큰 몫이었다 — 이 턴이 앞 대화를 정말 봐야 하면 `message.read` 로 스스로 읽는다.
   *
   * 델타 중 **남의 새 말**은 그대로 싣는다(자기 발화는 거른다 — 첫 턴처럼 전부 싣지 않는다). 기다리는
   * 동안 사람이 "아 그거 취소해" 라고 했으면 그것은 앞 대화가 아니라 이 확인의 재료다. 대개 몇 줄이다.
   * `wake` 가 있을 때만 뜻이 있다.
   */
  freshWake?: boolean;
  /**
   * 이 seq 뒤의 **내 발화**는 이 세션이 쓴 것이 아니다(`SessionRecord.unseenOwnAfterSeq`) — 자기 발화
   * 필터에서 빼고 보여 준다. 진행 설명·대기 줄(`NON_UTTERANCE_KINDS`)은 여전히 거른다.
   */
  unseenOwnAfterSeq?: number;
}): { prompt: string; fedSeq: number } {
  const {
    messages, lastFedSeq, meId, handles, channelId, threadRootId, wake, team, delegation,
    delegatedBy, editedMention, canceledWakes, unseenOwnAfterSeq,
  } = opts;
  const freshWake = opts.freshWake === true && wake !== undefined;
  const isFirstTurn = lastFedSeq === 0;

  const newMessages = messages.filter((m) => m.seq > lastFedSeq);
  // 넘길 게 있었든 없었든, 이번에 본 것 중 가장 큰 seq 가 다음 경계다. newMessages 가
  // 비어 있으면 reduce 의 초기값(lastFedSeq)이 그대로 나와 전진하지 않는다 — 볼 게 없었으니
  // 맞는 동작이다.
  const fedSeq = newMessages.reduce((max, m) => Math.max(max, m.seq), lastFedSeq);

  const unseenOwn = (m: MessageRow): boolean => unseenOwnAfterSeq !== undefined
    && m.seq > unseenOwnAfterSeq && !NON_UTTERANCE_KINDS.has(m.kind);
  const toShow = newMessages.filter((m) => (isFirstTurn && !freshWake) || m.authorId !== meId || unseenOwn(m));
  if (!toShow.length && wake === undefined && delegation === undefined && editedMention === undefined) {
    // 새 메시지가 있었지만 전부 자기 발화라 걸러진 경우도 여기로 온다. 그래도 prompt 를
    // 비우고 fedSeq 는 이미 위에서 전진시킨 값을 그대로 쓴다 — 걸러냈다고 다음 턴에 같은
    // 메시지를 또 "새 것"으로 들이밀면 세션이 매번 자기 말을 다시 보고, 반대로 fedSeq 를
    // 전진시키지 않으면 여기서 리턴만 하고 실제로는 못 본 셈이 되어 나중 turn 이 이 구간을
    // 건너뛴다 — 어느 쪽도 아니고 "봤지만 보여줄 건 없었다"가 맞는 상태다.
    return { prompt: '', fedSeq };
  }

  // "null" 을 그대로 문자열로 흘리면 에이전트가 그걸 진짜 threadRootId 로 읽어
  // message.post 에 넘길 위험이 있다 — 사람이 읽어도, 그리고 buildSystemPrompt 의 지시와도
  // 맞물리게 "채널 최상위(없음)"으로 표현한다(§4 발화 경로).
  const head = [`channelId: ${channelId}`, `threadRootId: ${threadRootId ?? '채널 최상위(없음)'}`].join('\n');
  const lines = toShow.map((m) => renderLine(m, handles));
  // 깨움 줄을 **사람의 발화처럼 렌더하지 않는다**(`renderLine` 을 쓰지 않는 이유다).
  // "forge: CI 결과 확인" 으로 보이면 에이전트가 자기 옛 말을 새 요청으로 읽는다.
  // 아래 델타에 사람의 새 발화가 함께 있을 수 있으므로 이 줄은 그것을 대체하지 않고 앞에 선다.
  const wakeLines = wake === undefined ? [] : [
    `(예약된 후속 턴 — 사유: ${wake.reason})`,
    ...(wake.reportTo ? reportToLines(wake.reportTo) : []),
    ...(freshWake ? freshWakeLines() : []),
    '',
  ];
  const canceledLines = canceledWakes?.length ? canceledWakeLines(canceledWakes) : [];
  const teamLines = team === undefined ? [] : teamSection(team, meId, handles);
  const delegationLines = delegation === undefined ? [] : delegationSection(delegation);
  const handedLines = delegatedBy === undefined ? [] : handedSection(delegatedBy);
  // 수정으로 불렸다(076). 그 글이 델타에 있으면 안내 한 줄만, 없으면(이미 본 구간) 글까지 싣는다 —
  // 둘 다 싣으면 같은 글이 두 번 보인다.
  const editLines = editedMention === undefined ? [] : [
    '(수정으로 추가된 멘션 — 앞서 올라온 글이 고쳐지면서 너를 불렀다. 고친 뒤의 본문을 다시 읽어라)',
    ...(toShow.some((m) => m.id === editedMention.id) ? [] : [renderLine(editedMention, handles)]),
    '',
  ];
  // 안내는 첨부 줄 **뒤**에 선다 — 먼저 무엇이 왔는지 보고 그다음 어떻게 여는지 읽는 순서다.
  // `toShow` 로 판정한다: 보여주지 않은 메시지의 첨부는 프롬프트에 id 가 없어 열 수도 없다.
  const howTo = toShow.some((m) => m.attachments.length) ? attachmentHowTo() : [];
  // 팀 블록은 **델타 앞**이다 — 사람의 말을 읽기 전에 "너는 이 팀의 창구다"를 알아야
  // 그 말을 팀의 일로 읽는다. `wakeLines` 뒤에 두는 이유: 그 줄은 이 턴이 왜 떴는지이고,
  // 팀 블록은 이 턴이 무엇인지다(둘이 함께 오는 경우는 예약이 걸린 팀 턴이다).
  const prompt = [head, '', ...wakeLines, ...canceledLines, ...teamLines, ...delegationLines, ...handedLines, ...editLines, ...lines, ...howTo].join('\n');

  return { prompt, fedSeq };
}

/**
 * 예약 깨움을 **새 세션으로** 돌릴 때 붙는 안내(2026-10-09). 이 턴은 스레드의 앞 대화를 들고 있지
 * 않다 — 그 사실을 모르면 에이전트가 "기억이 없다"고 지어내거나 앞 약속을 놓친다. 그래서 무엇이
 * 없는지와 어디서 읽는지를 함께 말한다. 이 세션은 이 턴 뒤 버려진다는 것도 — 남길 것은 스레드나
 * 기억에 남겨야 다음 턴이 안다.
 */
export function freshWakeLines(): string[] {
  return [
    '(이 턴은 예약 확인을 위해 **새 세션**으로 떴다 — 이 스레드의 앞 대화를 이어받지 않았다. 사유만으로 확인할 수 없고',
    '앞 맥락이 정말 필요하면 harkroom MCP 의 `message.read` 로 위 channelId·threadRootId 를 읽어라.',
    '머지·push·다른 스레드 발화처럼 되돌리기 어려운 일을 하기 전에는 `message.read` 로 앞 대화의 조건(검토·승인 등)을 먼저 확인하라.',
    '이 세션은 이 턴 뒤 버려진다 — 다음에 알아야 할 것은 스레드에 쓰거나 기억에 남겨라.)',
  ];
}

/**
 * 턴 시작 seq(sinceSeq) 이후 자기 발화가 몇 개인지 센다. 기준선을 turnStartSeq 로 두는
 * 이유: 시작 전에 이미 있던 자기 발화까지 세면 아무것도 안 한 턴도 "발화했다"가 된다.
 *
 * 불리언이 아니라 개수인 이유(#90): 호출부가 두 가지를 물어야 한다 — "발화가 있었나"(> 0,
 * silentTurnNotice 와 커서 전진 판단)와 "여러 번 발화했나"(> 1, 중복 발화 관측). 불리언만
 * 두면 후자를 알 수 없고, 두 함수가 각자 세면 규칙이 둘로 갈린다. 세는 곳은 여기 하나다.
 *
 * progress 메시지는 **결과 발화로 세지 않는다.** 에이전트가 `message.progress` 로 올린
 * 진행 설명이고, 그것을 결과로 세면 "설명만 올리고 결과를 못 올린 턴"이 침묵으로
 * 취급되지 않아 silentTurnNotice 가 억제된다 — #144 가 가장 비싸다고 지목한 문제다.
 *
 * 플래그로 두지 않는 이유: progress 를 결과로 세고 싶은 호출자가 없다. 끌 수 있게 두면
 * 그 인자가 잘못 넘어오는 경로가 생길 뿐이다.
 *
 * #123 의 `excludeSeqs`(러너가 직접 올린 진행 통지를 빼던 것)는 제거했다 — 러너가 더
 * 이상 아무것도 올리지 않는다. 그 폴백은 **1단계의 진행 중 리액션**이 대신한다:
 * 러너는 내용 있는 설명을 쓸 수 없으므로(하네스 출력 파싱은 pty.ts 의 금지선이다)
 * 스레드 칸을 쓰지 않는 리액션이 옳은 자리다.
 */
export function countOwnPostsSince(messages: MessageRow[], meId: string, sinceSeq: number): number {
  return messages.filter(
    (m) => m.authorId === meId && m.seq > sinceSeq && !NON_UTTERANCE_KINDS.has(m.kind),
  ).length;
}

/**
 * 이 턴이 **자기 앵커가 아닌 스레드에** 남긴 발화들.
 *
 * ## 왜 필요한가 (2026-09-08 실측)
 *
 * 서로 다른 앵커를 받은 턴 둘이 자기 앵커 대신 채널의 다른 요청을 구현하고, 결과도 **그쪽
 * 스레드에** 올렸다. 그 두 턴의 앵커에는 옛 침묵 통지 한 줄만 남았다 — 사람이 본 것은
 * "답 없이 턴을 끝냈습니다" 였고, 그 턴이 실제로는 30분을 일해서 옆 스레드에 답을 올렸다는
 * 사실은 어디에도 없었다. 침묵의 **이유**가 러너에게는 보이는데 사람에게 안 보였다.
 *
 * ## 판정 규칙
 *
 * 메시지가 속한 스레드는 `threadRootId ?? id` 다(루트 메시지 자신은 자기 id 가 스레드다).
 * 앵커가 `null`(채널 최상위)인 턴에게는 "최상위에 쓴 것"이 자기 자리이므로 `threadRootId`
 * 가 null 인 것만 자기 것이다 — 그 경우 루트의 id 로 비교하면 자기 발화가 전부 남의 것이 된다.
 *
 * 발화의 정의는 `countOwnPostsSince` 와 **같다**(progress·wake 제외) — 세는 규칙이 두 벌이
 * 되면 "앵커에는 0건인데 밖에는 1건"의 두 숫자가 서로 다른 뜻을 갖게 된다.
 *
 * ## 이것이 증명하지 못하는 것
 *
 * 같은 채널에서 턴이 **동시에** 돌면 여기 잡힌 발화가 남의 정상 턴의 것일 수 있다(계정이
 * 같아 구분되지 않는다 — `hasOwnPostSince` 의 #174 와 같은 한계다). 그래서 호출부는 이것을
 * 고발이 아니라 정황으로 쓴다: 이미 침묵으로 통지가 나가는 자리에만 덧붙인다.
 */
export function offAnchorPosts(
  messages: MessageRow[], meId: string, anchor: string | null, sinceSeq: number,
): MessageRow[] {
  return messages.filter((m) => {
    if (m.authorId !== meId || m.seq <= sinceSeq || NON_UTTERANCE_KINDS.has(m.kind)) return false;
    return anchor === null ? m.threadRootId !== null : (m.threadRootId ?? m.id) !== anchor;
  });
}

/**
 * `offAnchorPosts` 가 잡은 것을 침묵 통지(`silentTurnNotice`)에 실을 한 줄로 만든다.
 *
 * 스레드 링크를 싣는다 — "다른 스레드에 썼다"만 말하면 사람이 그것을 찾을 방법이 없다.
 * 형식은 데스크탑이 이미 여는 permalink(`messagePermalink`)다: 붙여넣으면 그 스레드가 열린다.
 * 잡힌 것이 없으면 `null` 이다(`harnessTailNotice` 와 같은 규칙: 빈 상자는 "여기 뭔가
 * 있다"는 거짓 신호다).
 */
export function offAnchorNotice(posts: MessageRow[]): string | null {
  if (posts.length === 0) return null;
  const roots = [...new Set(posts.map((m) => m.threadRootId ?? m.id))];
  const links = roots.map((id) => messagePermalink(id));
  // 짧게 단정한다(2026-10-01, designer 검토안). "같은 계정의 다른 턴일 수도 있다"는 정황의 단서는
  // 사람이 할 일을 바꾸지 않으므로 러너 로그(`offAnchorEvidence`)에만 남긴다.
  return `이 요청의 답은 다른 스레드에 올렸습니다: ${links.join(' · ')}`;
}

/**
 * "이 턴이 **기다림을 예약했나**". 발화 판정과 다른 질문이라 별도 함수이지만, 세는 규칙이
 * 흩어지지 않게 같은 파일에 둔다.
 *
 * 기준선(`sinceSeq`)이 핵심이다: 스레드에 옛 대기 줄이 남아 있는 것은 흔한 일이고, 그것을
 * 근거로 침묵을 허용하면 **한 번 예약한 스레드는 그 뒤로 영원히 조용해도 된다**가 된다.
 * 이번 턴에 생긴 줄만이 "이번 턴은 기다리기로 했다"는 증거다.
 *
 * 저자를 보는 이유: 한 스레드에 여러 에이전트가 있을 수 있고, 동료의 대기 줄로 내 침묵을
 * 정당화하면 내 턴은 아무 말 없이 사라진다.
 */
/**
 * 깨움 메시지 meta 에서 보고처를 꺼낸다(`meta.wake.reportTo`, 2026-10-06). 모양이 틀리면 없는 것으로 본다 —
 * 옛 서버의 깨움에는 이 키가 없고, 그때는 지금처럼 앵커에만 답한다.
 */
export function wakeReportTo(meta: unknown): WakeReportTo | undefined {
  const wake = (meta as { wake?: { reportTo?: unknown } } | null | undefined)?.wake;
  const r = wake?.reportTo as Record<string, unknown> | undefined;
  if (!r || typeof r.channelId !== 'string' || typeof r.threadRootId !== 'string') return undefined;
  return { channelId: r.channelId, threadRootId: r.threadRootId };
}

/**
 * 깨어난 턴에게 **다른 스레드에 한 약속**을 적는다(2026-10-06). 스레드마다 세션이 따로라 깨어난 턴은 자기
 * 앵커만 안다 — 사유 한 줄에 약속이 없으면 결과는 앵커에만 남고 약속한 쪽(#task 등)에서는 "안 봤다" 로 보였다.
 */
export function reportToLines(r: WakeReportTo): string[] {
  return [
    `(이 예약은 결과를 **다른 스레드에 보고하기로 약속했다** — channelId: ${r.channelId} · threadRootId: ${r.threadRootId}`,
    ` (harkroom://message/${r.threadRootId}). 이 스레드 답과 별도로 그 스레드에도 message.post 로 결과를 남겨라.`,
    ' 거기에 아무 말 없이 끝나면 러너가 그 스레드에 "보고 없이 끝났다" 를 남긴다.)',
  ];
}

/**
 * 이 부름으로 **접힌 내 예약들**(서버 107). 사람의 말이 예약을 무효로 만든 것이니 대부분은 다시 걸 일이
 * 없다 — 하지만 예약이 사람의 말과 무관한 기다림(CI 등)이었으면 다시 걸어야 하고, 그 판단은 턴의 몫이다.
 */
export function canceledWakeLines(list: readonly InboxCanceledWake[]): string[] {
  return [
    `(이 부름으로 이 스레드에 걸어 둔 너의 예약 ${list.length}개가 접혔다 — 그 시각에 다시 깨어나지 않는다. 아직 필요하면 turn.wake 로 다시 걸어라:`,
    ...list.map((w) => `- ${w.reason} (원래 ${w.wakeAt}${w.reportTo ? ` · 보고처 harkroom://message/${w.reportTo.threadRootId}` : ''})`),
    ')',
    '',
  ];
}

/**
 * 약속한 보고처에 아무 말 없이 끝난 깨움 턴의 경고(2026-10-06). 보고처 스레드에 남긴다 — 거기서 기다리는
 * 사람이 "안 봤다" 가 아니라 "봤는데 여기 안 적었다, 결과는 저기 있다" 를 알게.
 */
export function reportMissedNotice(reason: string | null, anchor: string): string {
  // 사유가 null 이면 싣지 않는다 — 앵커와 보고처의 채널이 다를 때다(#1208 security n2: 비공개 앵커의 사유가
  // 공개 보고처로 옮겨 적히지 않게). 앵커 id 는 남긴다: 읽기는 서버가 가시성으로 막는다.
  return [
    reason === null
      ? '이 스레드에 보고하기로 한 예약이 깨어났지만 여기에 아무 말 없이 끝났다.'
      : `이 스레드에 보고하기로 한 예약이 깨어났지만 여기에 아무 말 없이 끝났다 — 사유: ${reason}`,
    `그 턴은 harkroom://message/${anchor} 스레드에서 돌았다. 결과는 그쪽을 본다.`,
  ].join('\n');
}

export function hasOwnWakeSince(messages: MessageRow[], meId: string, sinceSeq: number): boolean {
  return messages.some(
    (m) => m.authorId === meId && m.seq > sinceSeq && m.kind === MESSAGE_KIND_WAKE,
  );
}

/**
 * "이 턴에 결과 발화가 있었나". `countOwnPostsSince` 위에 얹은 얇은 판정이다 — 세는 규칙이
 * 두 곳에 생기지 않게 한다. 실패 경로(커서를 전진시킬지 정하는 자리)가 이 불리언을 쓴다.
 *
 * #144: progress 메시지는 제외되므로, 진행 설명만 있고 결과가 없는 턴은 silentTurnNotice 를 표시한다.
 *
 * #174: 같은 에이전트를 **여러 인스턴스**로 돌리면 이 판정이 둘을 구분하지 못한다 —
 * 인스턴스 A 가 올린 발화를 B 도 "내 발화"로 본다(계정이 같기 때문이다). 그래서 두
 * 인스턴스가 같은 스레드에 동시에 답하면 답이 둘 남을 수 있다.
 *
 * **그것을 여기서 고치지 않는다.** 인스턴스별 구분을 넣으면 발화를 세는 규칙이 두 벌이
 * 되고(`countOwnPostsSince` 와 갈린다), 이 저장소는 이미 at-least-once 를 택했다. 대가는
 * 문서로 알린다 — `packages/agent/README.md` 의 "대가" 절이 그 자리이고, 인스턴스를
 * 여러 개 띄우는 것은 그 대가를 아는 운영자의 선택이다.
 */
export function hasOwnPostSince(messages: MessageRow[], meId: string, sinceSeq: number): boolean {
  return countOwnPostsSince(messages, meId, sinceSeq) > 0;
}

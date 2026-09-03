import { useMemo } from 'react';
import { useAppStore } from '../state/appStore';
import { splitMentions } from '../lib/mention';
import { splitLinks, type LinkTarget, type BodyPart } from '../lib/link';
import { splitCode } from '../lib/code';
import { shouldCollapse, COLLAPSED_MAX_PX } from '../lib/collapse';
import { getExternalOpener } from '../lib/openExternal';
import { getController } from '../state/controller';
import type { SectionId } from './settings/sections';

/**
 * 본문을 그리면서 멘션만 강조한다. 존재하는 handle 만 칠한다 — 오타를 멘션처럼 보여 주면
 * 사용자는 알림이 갔다고 착각한다.
 *
 * 그 위에 링크 인식을 얹는다(#214). 링크가 되는 것은 `classifyLink` 가 허용한 것뿐이고,
 * 나머지 스킴은 막히는 것이 아니라 **애초에 누를 것이 생기지 않는다**.
 *
 * 그 앞에 코드가 온다(#216). 코드가 먼저 나뉘므로 코드 안의 URL 과 @handle 은 링크도
 * 멘션도 되지 않는다 — 별도 예외 처리가 아니라 순서에서 따라오는 결과다.
 *
 * 다 그린 결과를 마지막에 접는다(#217). 접기는 **그리는 방식을 바꾸지 않는다** — 위의
 * 인식 결과를 그대로 담은 뒤 담긴 상자의 높이만 자르므로, 접힌 상태에서도 코드는 코드로,
 * 링크는 링크로 남는다.
 */

/**
 * 링크를 누르면 어디로 가는가. `murmur://` 는 OS 를 거치지 않고 앱 안에서 이동한다 —
 * murmur 를 모르는 OS 로 보내면 아무 일도 일어나지 않는다.
 *
 * 여는 데 실패하면 반드시 사람에게 보인다. 조용히 삼키면 사람은 앱이 멈춘 것으로 본다.
 * (`openMessage` 는 자기 실패를 스스로 알린다 — 사유마다 다음에 할 일이 다르기 때문이다.)
 */
async function followLink(target: LinkTarget): Promise<void> {
  if (target.kind === 'message') {
    await getController().openMessage(target.messageId);
    return;
  }
  try {
    await getExternalOpener().open(target.href);
  } catch {
    useAppStore.getState().set({
      notice: `Could not open ${target.href} — no browser answered. Copy the link and open it yourself.`,
    });
  }
}

/**
 * 멘션을 눌렀을 때 갈 곳(#279). 두 신호를 **옵셔널**로 두는 이유와 그 위험을 함께 적는다:
 * 이 컴포넌트는 채널 문서 패널처럼 이동이 없는 자리에서도 쓰이고, 단위 테스트가 본문만
 * 띄우기도 한다. 대신 옵셔널이 **조용히 죽은 버튼을 만드는 것**은 막는다 — 신호가 없으면
 * 버튼을 아예 그리지 않는다(아래 `openable`). 배선이 끊긴 채로 눌러도 아무 일이 없는
 * 컨트롤을 남기는 것이 옵셔널의 진짜 위험이고, 실제로 이 브랜치의 초판이 그랬다:
 * `Workspace` 가 `ChannelPane` 에 두 신호를 넘기지 않아 앱에서 모든 멘션이 죽은 버튼이었다.
 * 그 배선은 `test/mentionClick.test.tsx` 가 `Workspace` 를 통째로 띄워 지킨다.
 */
interface MentionOpeners {
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}

export function MessageBody({
  body,
  messageId,
  onOpenDirectory,
  onOpenSettings,
}: {
  body: string;
  messageId: string;
} & MentionOpeners) {
  const accounts = useAppStore((s) => s.accounts);
  const groups = useAppStore((s) => s.groups);
  const me = useAppStore((s) => s.me);
  const myHandle = me?.handle?.toLowerCase() ?? null;
  // 접기 판정은 본문만 본다 — 작성자가 누구인지 보지 않는다. 자기가 쓴 긴 메시지도 남의
  // 대화를 밀어내는 것은 똑같고, 예외를 두면 "왜 이건 접히고 저건 안 접히지" 를 사람이
  // 매번 판단해야 한다(#217).
  const collapsible = useMemo(() => shouldCollapse(body), [body]);
  const expanded = useAppStore((s) => s.expandedMessageIds[messageId] === true);
  const toggleExpanded = useAppStore((s) => s.toggleExpanded);
  const collapsed = collapsible && !expanded;

  const segments = useMemo(() => splitCode(body), [body]);
  const handles = useMemo(() => Object.values(accounts).map((a) => a.handle), [accounts]);
  const accountsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of Object.values(accounts)) {
      map.set(a.id, a.handle);
    }
    return map;
  }, [accounts]);
  const groupHandles = useMemo(() => groups.map((g) => g.handle), [groups]);
  // handle → 계정. 멘션마다 `Object.values(...).find` 를 돌면 본문 하나에 계정 수 × 멘션 수다.
  const byHandle = useMemo(
    () => new Map(Object.values(accounts).map((a) => [a.handle.toLowerCase(), a])),
    [accounts],
  );

  /** 코드가 아닌 구간만 멘션·링크 조각으로 나눠 그린다. */
  const renderPart = (p: BodyPart, key: string) => {
    if (p.kind === 'text') return <span key={key}>{p.text}</span>;
    if (p.kind === 'link') {
      return (
        <a
          key={key}
          // href 를 두는 이유: 마우스를 올리면 어디로 가는지 보이고 키보드로도 잡힌다.
          // 실제 이동은 우리가 한다 — 웹뷰가 스스로 따라가면 앱이 그 페이지로 바뀐다.
          href={p.text}
          rel="noreferrer noopener"
          data-testid="body-link"
          data-link-kind={p.target.kind}
          className="text-indigo-600 underline underline-offset-2 hover:text-indigo-800"
          onClick={(e) => { e.preventDefault(); void followLink(p.target); }}
        >
          {p.text}
        </a>
      );
    }
    const isSelf = p.handle === myHandle;
    const isGroup = (p as { isGroup?: boolean }).isGroup === true;
    const account = byHandle.get(p.handle);

    // 어디로 가는가(#279). `null` 이면 누를 것이 없다.
    //
    // 계정이 없는 멘션(`@channel`)과 집합(#230)은 **갈 곳이 없다.** 디렉터리는 계정의 표라서
    // 집합의 행이 없고, 없는 계정으로 열면 아무 행도 강조되지 않는다. 강조되지 않는
    // 오타(`@없는이름`)가 애초에 여기 오지 않는 것과 같은 이유다: 누를 수 있게 만들면
    // "여기에 뭔가 있다" 는 거짓을 말하게 된다.
    //
    // 에이전트는 **admin 만** 설정으로 보낸다. spec 은 소유자도 보내라고 했지만
    // `GET /accounts/agents` 가 아직 `requireAdmin` 이어서(`routes/accountRoutes.ts`)
    // 소유자는 목록 조회에서 403 을 받는다 — 그 화면은 "에이전트 목록을 받지 못했다" 만
    // 띄우고 목록이 비어 `targetId` 도 아무것도 고르지 못한다. #253 이 열어 준 것은
    // `PATCH`·메모리·PAT 이고 **목록은 아니다.** 갈 수 있는데 할 수 있는 것이 없는 곳을
    // 만들지 않는다(design.md §4). 목록 라우트가 소유자에게 열리면 여기에 소유자 판정을
    // 더하는 것이 맞다.
    const target: (() => void) | null = (() => {
      if (!account) return null;
      if (isGroup) return null;
      if (account.kind === 'agent' && me?.isAdmin === true && onOpenSettings) {
        return () => onOpenSettings('agents', account.id);
      }
      if (onOpenDirectory) return () => onOpenDirectory(account.id);
      return null;
    })();

    // 접근 가능한 이름은 `@handle` 이 아니라 **무엇을 하는지**다. 그러므로 실제로 열리는
    // 곳을 말해야 한다 — 디렉터리로 가는데 "설정 열기" 라고 부르면 이름이 거짓이 된다.
    const goesToSettings = account?.kind === 'agent' && me?.isAdmin === true && !!onOpenSettings;
    const accessibleName = account && (goesToSettings
      ? `${account.handle} 에이전트 설정 열기`
      : `${account.handle} 프로필 열기`);

    // 나를 부른 멘션은 더 강하게. 색만으로 구분하지 않는다(배경 + 굵기).
    // 집합은 다른 색(teal)으로 구분한다.
    const className = `rounded px-0.5 font-medium ${
      isGroup
        ? 'bg-teal-50 text-teal-700'
        : isSelf
          ? 'bg-amber-200 text-amber-900'
          : 'bg-indigo-50 text-indigo-700'
    }`;
    // 표시는 한 곳에서 나온다 — 누를 수 있는 것과 없는 것을 따로 그리면 색·배지가 갈라진다.
    const shared = {
      'data-testid': `mention-${p.handle}`,
      'data-self': String(isSelf),
      'data-group': String(isGroup),
      className,
    };

    // 갈 곳이 없으면 **버튼이 아니다.** 눌러도 아무 일이 없는 컨트롤은 없는 것보다 나쁘다.
    if (!target) return <span key={key} {...shared}>{p.text}</span>;

    return (
      <button
        key={key}
        type="button"
        {...shared}
        className={`${className} cursor-pointer`}
        aria-label={accessibleName}
        onClick={target}
      >
        {p.text}
      </button>
    );
  };

  const content = (
    <div className="whitespace-pre-wrap break-words" data-testid="message-body">
      {segments.map((seg, i) => {
        if (seg.kind === 'inlineCode') {
          return (
            <code
              key={i}
              data-testid="inline-code"
              className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] text-slate-800"
            >
              {seg.code}
            </code>
          );
        }
        if (seg.kind === 'codeBlock') {
          return (
            // 코드는 접히지 않는다 — 줄바꿈된 명령줄은 그대로 복사해도 실행되지 않는다.
            // 대신 가로로 스크롤한다.
            <div key={i} className="my-1 overflow-hidden rounded border border-slate-200">
              {seg.lang && (
                // 언어는 **표시만** 한다. 문법 강조기를 들이면 의존성과 공격 표면이 같이 커진다.
                <div
                  data-testid="code-lang"
                  className="border-b border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-[0.75em] text-slate-500"
                >
                  {seg.lang}
                </div>
              )}
              <pre
                data-testid="code-block"
                data-lang={seg.lang ?? ''}
                className="overflow-x-auto bg-slate-50 px-2 py-1 font-mono text-[0.9em] text-slate-800"
              >
                <code>{seg.code}</code>
              </pre>
            </div>
          );
        }
        // 코드가 아닌 구간에만 기존 인식이 얹힌다.
return splitLinks(splitMentions(seg.text, handles, groupHandles, accountsMap)).map((p, j) => renderPart(p, `${i}-${j}`));
      })}
    </div>
  );

  // 접을 대상이 아니면 상자도 버튼도 만들지 않는다. **자르기와 "더 보기" 는 같은 조건
  // 하나에서 나온다** — 둘을 따로 판단하면 버튼 없이 잘린 상태가 생길 수 있고, 그것은
  // 정보가 사라진 것이다.
  if (!collapsible) return content;

  return (
    <div data-testid="collapsible-body" data-collapsed={String(collapsed)}>
      <div
        data-testid="body-clip"
        // 접을 때 본문을 DOM 에서 빼지 않는다 — `display:none` 이면 브라우저 찾기·복사·
        // 스크린리더가 본문에 도달하지 못하고, 그건 내용을 지운 것과 다르지 않다.
        // 그래서 자르는 수단은 `max-height` + `overflow:hidden` 이다.
        className={collapsed ? 'overflow-hidden' : undefined}
        // 값을 클래스 문자열로 적지 않고 상수에서 가져온다 — 판정에 쓴 높이와 실제로 자른
        // 높이가 두 곳에 적히면 한쪽만 고쳐질 때 소리 없이 어긋난다.
        style={collapsed ? { maxHeight: `${COLLAPSED_MAX_PX}px` } : undefined}
      >
        {content}
      </div>
      {/* 버튼은 **본문 흐름 아래**에 둔다. 왼쪽 아바타 거터(#161 2단계)의 고정폭 예산에
          끼워 넣지 않는다 — 거기는 이미 아바타가 쓰고 있고, 호버 툴바(#143)와 답글
          컨트롤(#145)이 가로 예산을 다투는 자리다. */}
      <button
        data-testid="expand-body"
        // 상태를 색이나 글자로만 알리지 않는다 — disclosure 는 aria-expanded 가 상태다.
        aria-expanded={expanded}
        className="mt-0.5 rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100"
        onClick={() => toggleExpanded(messageId)}
      >
        {collapsed ? 'Show more' : 'Show less'}
      </button>
    </div>
  );
}

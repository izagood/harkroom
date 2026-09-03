import { useMemo } from 'react';
import { useAppStore } from '../state/appStore';
import { splitMentions } from '../lib/mention';
import { splitLinks, type LinkTarget, type BodyPart } from '../lib/link';
import { splitCode } from '../lib/code';
import { shouldCollapse, COLLAPSED_MAX_PX } from '../lib/collapse';
import { getExternalOpener } from '../lib/openExternal';
import { getController } from '../state/controller';

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

export function MessageBody({ body, messageId }: { body: string; messageId: string }) {
  const accounts = useAppStore((s) => s.accounts);
  const myHandle = useAppStore((s) => s.me?.handle?.toLowerCase() ?? null);
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
    return (
      <span
        key={key}
        data-testid={`mention-${p.handle}`}
        data-self={String(isSelf)}
        // 나를 부른 멘션은 더 강하게. 색만으로 구분하지 않는다(배경 + 굵기).
        className={`rounded px-0.5 font-medium ${
          isSelf ? 'bg-amber-200 text-amber-900' : 'bg-indigo-50 text-indigo-700'
        }`}
      >
        {p.text}
      </span>
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
        return splitLinks(splitMentions(seg.text, handles, accountsMap)).map((p, j) => renderPart(p, `${i}-${j}`));
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

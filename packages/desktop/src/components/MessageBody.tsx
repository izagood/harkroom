import { useMemo } from 'react';
import { useAppStore } from '../state/appStore';
import { splitMentions } from '../lib/mention';
import { splitLinks, type LinkTarget } from '../lib/link';
import { getExternalOpener } from '../lib/openExternal';
import { getController } from '../state/controller';

/**
 * 본문을 그리면서 멘션만 강조한다. 존재하는 handle 만 칠한다 — 오타를 멘션처럼 보여 주면
 * 사용자는 알림이 갔다고 착각한다.
 *
 * 그 위에 링크 인식을 얹는다(#214). 링크가 되는 것은 `classifyLink` 가 허용한 것뿐이고,
 * 나머지 스킴은 막히는 것이 아니라 **애초에 누를 것이 생기지 않는다**.
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

export function MessageBody({ body }: { body: string }) {
  const accounts = useAppStore((s) => s.accounts);
  const myHandle = useAppStore((s) => s.me?.handle?.toLowerCase() ?? null);

  const parts = useMemo(
    () => splitLinks(splitMentions(body, Object.values(accounts).map((a) => a.handle))),
    [body, accounts],
  );

  return (
    <div className="whitespace-pre-wrap break-words" data-testid="message-body">
      {parts.map((p, i) => {
        if (p.kind === 'text') return <span key={i}>{p.text}</span>;
        if (p.kind === 'link') {
          return (
            <a
              key={i}
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
            key={i}
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
      })}
    </div>
  );
}

import { useActiveStore } from '../state/communities';
import { useT } from '../i18n/useT';

/** 이름을 다 늘어놓으면 줄이 길어지고, 그 줄이 늘어나면 메시지 목록이 밀린다. */
const MAX_NAMES = 2;

export function TypingLine() {
  const t = useT();
  const channelId = useActiveStore((s) => s.activeChannelId);
  const typing = useActiveStore((s) => (channelId ? s.typing[channelId] : undefined));
  const accounts = useActiveStore((s) => s.accounts);

  // 이름을 모르는 사람을 '…'로 표시하면 유령이 입력 중인 것처럼 보인다. 디렉터리에 없으면
  // 아직 계정을 못 받은 것이므로, 받을 때까지 말하지 않는다.
  const names = (typing ?? []).map((id) => accounts[id]?.handle).filter((h): h is string => !!h);
  if (!names.length) return null;

  // 두 갈래는 **화면의 판단**이다(`MAX_NAMES`) — 사전에서도 두 키로 갈라 두어
  // 번역자가 `{names}` 와 `{count}` 중 하나를 지우지 않게 한다.
  const label = names.length <= MAX_NAMES
    ? t('message.typing.names', { names: names.join(', ') })
    : t('message.typing.count', { count: names.length });

  return (
    // aria-live 로 스크린리더에 알리되 polite 다 — 입력 중은 끼어들 만한 소식이 아니다.
    <div
      data-testid="typing-line"
      aria-live="polite"
      className="px-4 pb-1 text-meta italic text-fg-subtle"
    >
      {label}
    </div>
  );
}

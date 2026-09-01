import { useAppStore } from '../state/appStore';

/** 이름을 다 늘어놓으면 줄이 길어지고, 그 줄이 늘어나면 메시지 목록이 밀린다. */
const MAX_NAMES = 2;

export function TypingLine() {
  const channelId = useAppStore((s) => s.activeChannelId);
  const typing = useAppStore((s) => (channelId ? s.typing[channelId] : undefined));
  const accounts = useAppStore((s) => s.accounts);

  // 이름을 모르는 사람을 '…'로 표시하면 유령이 입력 중인 것처럼 보인다. 디렉터리에 없으면
  // 아직 계정을 못 받은 것이므로, 받을 때까지 말하지 않는다.
  const names = (typing ?? []).map((id) => accounts[id]?.handle).filter((h): h is string => !!h);
  if (!names.length) return null;

  const label = names.length <= MAX_NAMES
    ? `${names.join(', ')} 입력 중…`
    : `${names.length}명이 입력 중…`;

  return (
    // aria-live 로 스크린리더에 알리되 polite 다 — 입력 중은 끼어들 만한 소식이 아니다.
    <div
      data-testid="typing-line"
      aria-live="polite"
      className="px-4 pb-1 text-[11px] italic text-zinc-500"
    >
      {label}
    </div>
  );
}

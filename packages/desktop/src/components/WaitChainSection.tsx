import { useMemo } from 'react';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import { waitChainFromLinks, type WaitChain } from '../lib/waitChain';
import { elapsedLabel } from '../lib/progressGroup';

/**
 * **지금 누가 누구를 기다리는가** — 인박스의 한 구획(#488 A3-b → C2).
 *
 * ## 사이드바를 떠난 이유
 *
 * 문서는 이것을 사이드바의 `ACTIVE WORK` 자리에 두라고 했다. 만들어 놓고 보니 그
 * 자리가 **틀렸다**: 사이드바의 `nav` 는 `overflow-y-auto` 이고 이 구획은 채널·DM·
 * 에이전트 **다음**이라, 채널이 몇 개만 늘어도 스크롤 밖으로 밀린다. "지금 무엇이
 * 막혀 있는가"를 말하는 자리가 **정작 그것을 알아야 할 때 안 보인다.**
 *
 * 인박스가 그 물음에 답하는 자리다 — 문서 자신이 *"'나를 막는 말'이 모이는 유일한
 * 자리"* 라고 적었다. 사슬은 그 목록이 답하지 못하는 것 하나를 더한다: **나에게 오지
 * 않았지만 무언가를 멈추고 있는 것**(`codex → forge → alpha`).
 *
 * ## 내 차례는 위 구획이 이미 말한다
 *
 * 그래서 여기서는 **정렬만** 남기고 강조는 옅게 간다 — 같은 사실을 두 구획이 같은
 * 세기로 말하면 어느 쪽을 봐야 하는지 알 수 없다.
 */
export function WaitChainSection() {
  const channels = useActiveStore((s) => s.channels);
  const messages = useActiveStore((s) => s.messages);
  const accounts = useActiveStore((s) => s.accounts);
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const online = useActiveStore((s) => s.online);
  const connected = useActiveStore((s) => s.connected);

  /**
   * **아직 안 본 채널이 있는가.** `store.messages` 는 **연 채널만** 채워진다
   * (`controller.openChannel`) — 앱을 막 켰을 때는 거의 비어 있다.
   *
   * 이 구별이 없으면 사슬이 있는데도 "기다리는 것이 없다"가 뜬다(실측 2026-09-06:
   * 서버가 마디를 네 개 실어 보내는데 화면은 없다고 말했다). 그것은 이 작업이 없애려던
   * 바로 그 거짓말 — **열어 보지 않은 것을 없다고 단정하는 것** — 과 같은 모양이다.
   */
  const unseen = useMemo(
    () => channels.some((ch) => messages[ch.id] === undefined),
    [channels, messages],
  );

  const rows = useMemo(() => {
    // 생존은 클라이언트만 안다. 소켓이 끊겼으면 '아무도 없다'가 아니라 **'모른다'** 다
    // (`threadState`·`waitChain` 과 같은 규약) — 그 동안 교착이라 부르지 않는다.
    const live = connected ? new Set(online) : null;
    // DM 은 이름이 없다(`ChannelRow.name` 이 nullable). 없는 이름을 지어내지 않는다.
    const out: { channelId: string; channelName: string | null; rootId: string; chain: WaitChain }[] = [];

    for (const ch of channels) {
      for (const m of messages[ch.id] ?? []) {
        // 루트에만 집계가 실린다(`replyCount` 와 같은 규약). 답글 행은 건너뛴다.
        const chain = waitChainFromLinks({ links: m.openAskLinks ?? null, myAccountId: myId, live });
        if (!chain || chain.end === 'none' || chain.links.length === 0) continue;
        out.push({ channelId: ch.id, channelName: ch.name, rootId: m.id, chain });
      }
    }

    // **나를 막는 것이 먼저다**(규칙 04). 그 다음 교착, 그 다음 남을 기다리는 것.
    const rank = (e: WaitChain['end']) => (e === 'me' ? 0 : e === 'deadlock' ? 1 : 2);
    return out.sort((a, b) => rank(a.chain.end) - rank(b.chain.end));
  }, [channels, messages, myId, online, connected]);

  const name = (id: string | null): string => (id === null ? '사람' : accounts[id]?.handle ?? '…');

  return (
    <div data-testid="wait-chain-section">
      <h3 className="px-2 pb-1 text-meta uppercase tracking-wide text-fg-subtle">
        {/*
          **모를 때는 수를 말하지 않는다**(실측 2026-09-07, 사용자가 화면에서 발견).
          제목이 `(0)` 이고 본문이 "아직 다 보지 못했다"이면 **한 구획이 서로 반대되는
          두 말**을 한다 — 본문은 정직한데 제목이 안 본 것을 0으로 단정한다.
        */}
        기다리는 것{unseen ? '' : ` (${rows.length})`}
      </h3>
      {rows.length === 0 ? (
        // **한 줄로 조용히**(문서). 아무 일도 없는 것이 가장 큰 목소리가 되면 안 된다.
        // 다만 **"없다"와 "아직 안 봤다"는 다른 사실**이다(`docs/design.md` §4) —
        // 안 본 채널이 남아 있으면 없다고 단정하지 않는다.
        <p className="px-2 text-fg-muted">
          {unseen ? '아직 다 보지 못했다' : '기다리는 것이 없다'}
        </p>
      ) : (
        rows.map((r) => {
          const head = r.chain.links[0]!;
          const mine = r.chain.end === 'me';
          const stuck = r.chain.end === 'deadlock';
          return (
            <button
              key={`${r.channelId}:${r.rootId}`}
              data-testid={`wait-chain-${r.rootId}`}
              data-end={r.chain.end}
              // 누르면 **그 스레드로 간다** — 이 줄을 읽고 사람이 하려는 일이 그것 하나다.
              onClick={() => void getController().openThread(r.rootId)}
              // 줄이 **두 단으로** 서 있다: 사슬 한 줄은 본문단(앱 기본값 13px)이고 아래
              // 채널·사유 줄은 이미 아랫단 11px 이다. 둘을 같은 단으로 두면 어느 쪽이
              // 판단 근거인지 눈이 못 가른다 — 사람이 읽는 것은 사슬이다.
              className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1 text-left
                         hover:bg-surface-hover"
            >
              <span className="flex w-full items-center gap-1">
                {/*
                  **강조는 나를 막는 것에만**(규칙 04). 남을 기다리는 사슬까지 강조를
                  받으면 "내 차례"라는 신호가 죽는다 — 사이드바는 그 신호가 가장
                  진해야 하는 자리다.
                */}
                <span className={`truncate ${mine ? 'font-medium text-accent' : stuck ? 'text-state-stuck' : 'text-fg-muted'}`}>
                  {r.chain.links.map((l) => name(l.waiter)).join(' → ')}
                  {' → '}
                  {name(head.blockedBy === null && mine ? myId : r.chain.links[r.chain.links.length - 1]!.blockedBy)}
                </span>
                <span className="ml-auto shrink-0 text-fg-subtle">{elapsedLabel(head.askedAt, Date.now())}</span>
              </span>
              <span className="truncate text-meta text-fg-subtle">
                {r.channelName ? `#${r.channelName}` : 'DM'}
                {mine && r.chain.unblocks > 1 && ` · 답하면 ${r.chain.unblocks}개가 풀린다`}
                {stuck && r.chain.deadlockReason === 'cycle' && ' · 서로를 기다린다'}
                {stuck && r.chain.deadlockReason === 'dead-runner' && ' · 답할 쪽이 멈췄다'}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

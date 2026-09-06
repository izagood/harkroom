import { useMemo } from 'react';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import { waitChainFromLinks, type WaitChain } from '../lib/waitChain';
import { elapsedLabel } from '../lib/progressGroup';

/**
 * **지금 누가 누구를 기다리는가**(#488 A3-a·A3-b).
 *
 * 오류가 비운 자리에 들어간다. 문서: *"컨셉의 대기 사슬이 처음으로 화면에 보이는
 * 곳이다."* 지금까지 사슬은 **스레드를 열어야만** 보였다 — 그런데 "무엇이 멈춰
 * 있는가"는 스레드를 열기 **전에** 묻는 질문이다.
 *
 * ## 왜 이제 가능한가
 *
 * 채널 목록에는 루트만 있고 답글은 스레드를 열 때만 로드된다. 그래서 화면이 사슬을
 * 만들 수 없었다. `openAskLinks`(#490)가 그 구멍을 메운다 — 서버가 마디를
 * `누가 → 누구를` 짝으로 실어 준다.
 *
 * ## 기다리는 것이 없으면 조용히 비어 있는다
 *
 * 문서가 그렇게 적었다. 여기서 "없다"를 크게 말하면, 아무 일도 없는 것이 화면에서
 * 가장 큰 목소리가 된다 — 규칙 06(없는 문은 그리지 않는다)과 같은 결이다.
 *
 * ## 내 것을 먼저 센다
 *
 * 사슬이 여럿일 때 **나를 막는 것**이 위로 온다(규칙 03·04). 그 다음이 교착이고,
 * 남을 기다리는 것은 맨 아래다 — 내가 지금 할 수 있는 일이 맨 위에 있어야 한다.
 */
export function SidebarWaitChain() {
  const channels = useActiveStore((s) => s.channels);
  const messages = useActiveStore((s) => s.messages);
  const accounts = useActiveStore((s) => s.accounts);
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const online = useActiveStore((s) => s.online);
  const connected = useActiveStore((s) => s.connected);

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
    <div data-testid="sidebar-wait-chain">
      <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-fg-subtle">기다리는 것</div>
      {rows.length === 0 ? (
        // **한 줄로 조용히**(문서). 아무 일도 없는 것이 가장 큰 목소리가 되면 안 된다.
        <p className="px-2 text-xs text-fg-muted">기다리는 것이 없다</p>
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
              className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1 text-left
                         text-xs hover:bg-surface-hover"
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
              <span className="truncate text-[11px] text-fg-subtle">
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

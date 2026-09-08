import { useEffect, useRef, useState } from 'react';
import {
  AGENT_HARNESSES, RUNNABLE_HARNESSES,
  type AgentConfig, type AgentDefaults, type AgentView, type MentionPermission, type PatView,
} from '@murmur/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { staleRunners } from '../../lib/runnerVersions';
// 경과 계산은 `lib/` 한 벌이다 — 카드도 같은 값을 쓰는데 그쪽은 이 파일을 import 할 수
// 없다(순환). `lastTurnLabel` 은 그 위에 접두만 붙인다(아래 그 함수 주석).
import { lastTurnAgo } from '../../lib/lastTurn';
// `runnerStatusLabel` 을 **설명 문구에도** 쓴다 — 상태 이름을 이 파일이 제 손으로 적으면
// `RunnerStatus.tsx` 가 바뀔 때 여기만 낡는다. `external` → `adopted`(`#482`) 가 정확히
// 그렇게 어긋났다.
import { RunnerStatusLine, runnerStatusLabel } from '../RunnerStatus';
import { PAT_PLACEHOLDER, runnerCommandClipboardText } from '../../lib/runnerCommand';
import { AgentGrid } from './AgentGrid';
// 띄울 권한 판정은 `lib/` 하나가 낸다 — 레일의 에이전트 칸이 같은 판정을 쓴다
// (`docs/desktop-rail.html` 3단계). 사본을 두면 두 화면이 같은 사람에게 다르게 답한다.
import { canRelaunchAgent } from '../../lib/relaunchGate';
import { Identity } from '../Identity';
import { Button } from './primitives';
import { useAgentPool } from './useAgentPool';

/** #177: 클립보드가 없거나 거부되면 **조용히 실패하지 않는다** — 화면에 있는 그 명령
 *  텍스트를 선택 상태로 만들어 사람이 ⌘C 할 수 있게 하고, 오류를 눈에 보이게 남긴다.
 *  화면 밖 textarea + `document.execCommand('copy')` 는 쓰지 않는다: 사람이 볼 수도
 *  선택할 수도 없는 노드를 곧바로 지우고, execCommand 는 복사에 실패해도 던지지 않고
 *  `false` 만 돌려주므로 "복사됨"을 거짓으로 띄우게 된다.
 *  `target` 은 복사 대상 명령이 그려진 노드다(선택해 줄 대상). */
const copyToClipboard = async (
  text: string,
  target: HTMLElement | null,
  onError: (msg: string) => void,
): Promise<boolean> => {
  // 비보안 컨텍스트에서는 브라우저가 `navigator.clipboard` 를 아예 노출하지 않는다 —
  // 그래서 `isSecureContext` 를 따로 보지 않고 존재 여부만 본다(MessageItem 과 같은 판정).
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 권한 거부 등 → 아래 선택 경로로 내려간다. 성공했다고 하지 않는다.
    }
  }
  const selection = window.getSelection?.();
  if (target && selection) {
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    onError('클립보드를 쓸 수 없다 — 명령을 선택해 두었으니 ⌘C 로 복사한다');
  } else {
    onError('클립보드를 쓸 수 없고 명령을 선택할 수도 없다 — 명령을 손으로 옮겨 적는다');
  }
  return false;
};

/** AGENT_HARNESSES 에조차 없는 harness. 없는 것은 사용자의 CLI 가 아니라 murmur 의 구현이므로
 *  '설치 안 됨'이 아니라 '지원 예정'이다. AGENT_HARNESSES 에는 있지만 아직 못 돌리는 것(RUNNABLE_HARNESSES
 *  밖)은 아래 select 렌더링에서 따로 disabled 처리한다 — 여기 중복해서 적지 않는다. */
const PLANNED = ['cursor', 'goose', 'amp', 'devin'];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * "마지막 활동: N분 전"(`#176`). **접두만 붙이는 껍데기다** — 계산과 규율(`null` 을
 * '없음'으로 말하는 것, 미래 시각을 '방금'으로 뭉개는 것)은 `lib/lastTurn.ts` 에 있다.
 *
 * 왜 나눴나: `docs/desktop-agent-cards.pdf` 2쪽이 이 값을 **카드에도** 올렸는데, 카드는
 * `활동` 라벨을 왼쪽 칸에 이미 세워 두므로 접두가 붙으면 `활동  마지막 활동: 11분 전` 이
 * 된다. 그리고 `AgentGrid` 는 이 파일에서 함수를 가져올 수 없다 — 이 파일이 그것을
 * import 하므로 순환이 된다. 그 두 이유가 `lib/lastTurn.ts` 주석에 적혀 있다.
 *
 * **이름과 반환값은 그대로 남긴다.** 읽는 곳이 셋이고(상세 · `Profile` · 회귀선
 * `agentActivity.test.tsx`) 그 문구는 `#176` 이 정한 것이다 — 계산을 옮기면서 문구까지
 * 바꾸면 이 변경이 만지지 않아야 할 두 화면을 함께 건드린다.
 */
export function lastTurnLabel(iso: string | null, now: number = Date.now()): string {
  const ago = lastTurnAgo(iso, now);
  return iso === null ? '활동 없음' : `마지막 활동: ${ago}`;
}

interface Draft {
  handle: string;
  instructions: string;
  harness: AgentConfig['harness'];
  model: string;
  effort: string;
  workingDir: string;
  mentionPermission: MentionPermission;
  ownerAccountId: string | null;
}

/**
 * 새 에이전트의 초안. harness·model·effort 는 **서버가 준 기본값**에서 온다(#171).
 * 여기에 harness 를 하드코딩하면 운영자가 정한 기본값과 화면이 갈라진다 —
 * 그때 사용자는 자기가 보는 값이 운영자가 정한 것인지 이 컴포넌트가 지어낸 것인지 모른다.
 */
const emptyDraft = (defaults: AgentDefaults): Draft => ({
  handle: '', instructions: '',
  harness: defaults.harness as AgentConfig['harness'],
  model: defaults.model ?? '', effort: defaults.effort ?? '', workingDir: '',
  mentionPermission: 'auto', ownerAccountId: null,
});

const draftOf = (a: AgentView): Draft => ({
  handle: a.handle,
  instructions: a.instructions,
  harness: a.harness,
  model: a.model ?? '',
  effort: a.effort ?? '',
  workingDir: a.workingDir ?? '',
  mentionPermission: a.mentionPermission,
  ownerAccountId: a.ownerAccountId,
});

export function AgentsSettings({ targetId }: { targetId?: string }) {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [selected, setSelected] = useState<AgentView | null>(null);
  /**
   * 지금 무엇을 보고 있는가 — **그리드냐 상세냐**(identity 문서 Task 15).
   *
   * `selected` 로는 이 질문에 답할 수 없다: `null` 이 '아무것도 안 골랐다'와 '새 에이전트를
   * 만드는 중'을 겸하기 때문이다. 그래서 화면 상태를 따로 든다.
   *
   * **두 화면을 나란히 두지 않는 이유**: 문서의 목업이 그리드에는 곁창을 그리지 않았고,
   * 상세에는 `← 에이전트` 로 돌아가는 길을 그렸다 — 즉 **한 번에 한 화면**이다. 나란히 두면
   * 상세의 폭이 좁아져 문서가 세운 세 묶음이 다시 한 줄로 흐른다.
   */
  const [view, setView] = useState<'grid' | 'detail'>('grid');
  /** 에이전트별 계정 풀 배정(기기 로컬). 이 값은 서버로 가지 않는다 — `useAgentPool` 주석. */
  const agentPool = useAgentPool(selected?.id ?? null);

  // 초안이 null 인 것은 '무엇을 기본으로 둘지 아직 모른다'는 뜻이다 — 기본값을 못 읽었는데
  // 조용히 채워 넣으면 화면이 거짓을 말한다(docs/design.md 4절).
  const [draft, setDraft] = useState<Draft | null>(null);
  // #171: 기본값은 **세 상태**다 — null(아직 안 읽음) / 'error'(못 읽음) / 값.
  // 아래 PAT 로더가 실패를 `setPats([])` 로 삼켜 '없음'과 같은 화면을 만드는데, 그것을
  // 따라 하지 않는다. 실패는 사람에게 보인다.
  const [defaults, setDefaults] = useState<AgentDefaults | 'error' | null>(null);
  // null 이면 'harness 기본값 사용'. 되돌릴 때 model·effort 를 명시적 null 로 비워야 한다.
  const [customized, setCustomized] = useState(false);
  const [pat, setPat] = useState<string | null>(null);
  /**
   * #251: PAT 목록도 **세 상태**다 — null(아직 안 읽음) / 'error'(못 읽음) / 목록.
   * 위 `defaults` 주석이 "PAT 로더가 실패를 `setPats([])` 로 삼켜 '없음'과 같은 화면을
   * 만든다"고 적어 둔 그 결함을 여기서 없앤다. #251 이 "0개면 재발급이 필요하다"를
   * 그 자리에서 말하기로 결정했으므로, '못 읽었다'가 0개로 보이면 화면이 있는 PAT 를
   * 없다고 하고 운영자에게 필요 없는 재발급을 권한다.
   */
  const [pats, setPats] = useState<PatView[] | 'error' | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // #139: 메모리는 **세 상태**다 — null(아직 안 읽음) / 'error'(못 읽음) / 목록.
  // 실패를 빈 배열로 삼키면 "기억이 없다" 와 "못 읽었다" 가 구분되지 않는다
  // (docs/design.md 4절). 러너 쪽 MemoryContext 가 같은 이유로 세 상태다.
  type MemoryEntry = { slug: string; value: string; updatedAt: string };
  const [memories, setMemories] = useState<MemoryEntry[] | 'error' | null>(null);
  const [confirmingSlug, setConfirmingSlug] = useState<string | null>(null);
  // #251: 비활성화는 되돌릴 수 없는 작업이므로 확인 단계를 거친다.
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  // 라벨을 하드코딩하면 재발급이 막힌다 — 라벨은 살아 있는 토큰 안에서 유일하고
  // (마이그레이션 010) 서버가 중복을 409 로 거절한다. 토큰을 잃어 폐기한 뒤 같은 이름으로
  // 다시 발급하는 것이 주 사용 흐름이라, 사용자가 이름을 정할 수 있어야 한다.
  const [newPatLabel, setNewPatLabel] = useState('runner');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 복사 성공 시 버튼 문구를 잠깐 "복사됨"으로 바꾼다(2초).
  const [copySuccess, setCopySuccess] = useState<string | null>(null);
  // 클립보드를 못 쓸 때 선택해 줄 명령 노드들. 화면 밖 복제가 아니라 사람이 보고 있는 그 텍스트다.
  const fullCommandRef = useRef<HTMLSpanElement | null>(null);
  const templateCommandRef = useRef<HTMLSpanElement | null>(null);
  // #177: "잃었으면 새로 발급한다" 를 글로만 두면 발급 자리를 찾아야 한다 — 진입점으로 보낸다.
  const newPatLabelRef = useRef<HTMLInputElement | null>(null);
  const isAdmin = useActiveStore((s) => s.me?.isAdmin === true);
  const myId = useActiveStore((s) => s.me?.id);
  // #250: 이 앱이 띄운 러너의 상태. 실행기가 스토어에 밀어 넣고 화면은 읽기만 한다.
  const runnerStates = useActiveStore((s) => s.runnerStates);
  /** 뒤처진 러너를 세는 기준. 컨트롤러가 스토어에 밀어 넣은 값이다(`appStore.ts`). */
  const appVersion = useActiveStore((s) => s.appVersion);
  const [reissuing, setReissuing] = useState(false);
  const accounts = useActiveStore((s) => s.accounts);
  // #176: 생존(presence)과 마지막 활동은 **다른 두 사실**이라 두 자리에서 온다 — presence 는
  // 소켓 이벤트로 살아 있는 목록이고(#124), 마지막 활동은 `AgentView.lastTurnAt` 이다.
  // `connected` 를 함께 보는 이유: 소켓이 끊겼으면 `online` 은 그냥 빈 배열이라, 그것을
  // '오프라인'으로 그리면 실제로는 잘 돌고 있는 러너를 전부 죽은 것으로 표시한다.
  const online = useActiveStore((s) => s.online);
  const connected = useActiveStore((s) => s.connected);
  const humanAccounts = Object.values(accounts).filter((a) => a.kind === 'human');

  const reload = () => {
    void getController().listAgents().then(setAgents).catch(() => setError('에이전트 목록을 받지 못했다'));
  };
  useEffect(reload, []);

  /**
   * #428: 종료 요청 뒤 **수령**(`stopAckedAt`)을 화면에 반영한다.
   *
   * `requestStop` 이 받는 응답은 요청을 건 그 순간의 스냅샷이라 `stopAckedAt` 이 항상
   * `null` 이다 — 러너가 그 값을 채우는 것은 요청을 읽어 간 **그 뒤**(실측 4초)이기
   * 때문이다. 그런데 지금까지는 그 뒤를 다시 읽는 경로가 하나도 없었다: `agents` 는
   * 마운트 시 한 번만 읽고(바로 위 `useEffect(reload, [])`), 사이드바에서 같은 에이전트를
   * 다시 골라도(`pick`) `agents` 안의 그 stale 항목을 그대로 쓴다 — "화면을 다시 열면
   * 새로 읽는가"도 확인해 보니 안 됐다.
   *
   * **폴링 범위를 "요청했지만 아직 못 받음" 상태로 좁힌다.** 세 상태 중 이 하나만 시간이
   * 지나면 값이 바뀔 수 있는 상태다(요청 전은 사람이 버튼을 눌러야 바뀌고, 이미 받아 간
   * 뒤로는 더 바뀔 값이 없다) — 그래서 이 상태를 벗어나는 순간 스스로 멈춘다.
   *
   * **간격 5초.** 실측 수령까지 4초였다 — 25초 프레즌스 폴(#124)만큼 성기면 몇 번의
   * 확인 전에는 "아직 못 봤다"만 보인다. 그렇다고 1초처럼 짧게 하면 이 화면을 열어 둔
   * 사람 수만큼 목록 조회가 늘어 서버 부하만 커지고, 실측 수령 시간(4초)보다 촘촘해 봐야
   * 체감 차이가 없다. `listAgents()` 는 초기 로드에도 쓰는 가벼운 목록 조회라 새 엔드포인트
   * 없이 재사용한다 — 소켓 이벤트(`agent.updated` 류)가 없는 지금, 새로 만드는 것은 이
   * 이슈 범위를 넘는다.
   */
  useEffect(() => {
    if (!selected || !selected.stopRequestedAt || selected.stopAckedAt) return;
    const id = selected.id;
    const timer = window.setInterval(() => {
      void getController().listAgents().then((next) => {
        setAgents(next);
        setSelected((prev) => (prev && prev.id === id ? next.find((a) => a.id === id) ?? prev : prev));
      }).catch(() => { /* 다음 tick 이 다시 시도한다 — 폴링 실패를 화면 오류로 띄우지 않는다 */ });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.stopRequestedAt, selected?.stopAckedAt]);

  /**
   * 멘션에서 이 화면으로 왔다면 그 에이전트를 고른 상태로 시작한다(#279).
   *
   * **한 targetId 에 한 번만** 고른다. `agents` 는 저장·재조회마다 새 배열이라 그것만 보고
   * 다시 고르면, 사람이 다른 에이전트를 고른 뒤 저장한 순간 화면이 원래 대상으로 튀고
   * `pick` 이 초안을 갈아 사람이 쓰던 편집이 사라진다.
   */
  const pickedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!targetId || pickedFor.current === targetId) return;
    const agent = agents.find((a) => a.id === targetId);
    if (!agent) return;
    pickedFor.current = targetId;
    pick(agent);
  }, [targetId, agents]);

  // 기본값은 admin 전용 라우트다(`GET /settings/agent-defaults`). admin 이 아닌 사람에게
  // 부르면 403 이 나고, 그 403 을 오류로 그리면 아무 잘못도 없는 화면에 붉은 글이 뜬다.
  useEffect(() => {
    if (!isAdmin) return;
    void getController().agentDefaults()
      .then((d) => {
        setDefaults(d);
        // 처음 열린 화면은 '새 에이전트'다 — 그 초안을 지금 채운다. 이미 다른 에이전트를
        // 골랐다면 건드리지 않는다.
        setDraft((prev) => prev ?? emptyDraft(d));
        setCustomized((prev) => prev || d.model !== null || d.effort !== null);
      })
      .catch(() => setDefaults('error'));
  }, [isAdmin]);

  /**
   * PAT·메모리를 읽을 수 있는가(#253 의 표: 소유자 또는 admin).
   *
   * **판정을 대상 에이전트에서 직접 뽑는 이유**: 이 값을 `useState` 에 담고 `pick` 안에서
   * 세팅하면, 같은 `pick` 이 곧바로 부르는 아래 두 조회는 아직 **갱신 전 값**을 읽는다
   * (React 의 상태 갱신은 다음 렌더에 보인다). 실측으로 그래서 소유자가 에이전트를 처음
   * 고르면 PAT·메모리 패널은 그려지는데 조회가 한 번도 나가지 않아 영영 비어 있었다.
   */
  const canReadSecrets = (a: AgentView) => isAdmin || (myId !== undefined && a.ownerAccountId === myId);

  /**
   * 지금 고른 에이전트의 소유자인가(admin 은 아니다). **상태가 아니라 파생값**이다 —
   * 상태로 두면 `pick` 이 세팅한 값을 같은 `pick` 안의 조회가 못 본다(위 주석).
   */
  const isOwner = !isAdmin && selected !== null && myId !== undefined && selected.ownerAccountId === myId;

  const loadPats = (a: AgentView) => {
    if (!canReadSecrets(a)) return;
    setPats(null);
    void getController().listPats(a.id).then(setPats).catch(() => setPats('error'));
  };

  const loadMemories = (a: AgentView) => {
    if (!canReadSecrets(a)) return;
    setMemories(null);
    void getController().agentMemory(a.id)
      .then(setMemories)
      .catch(() => setMemories('error'));
  };

  /**
   * 고친 것이 있는가. **서버가 준 값과 지금 초안을 견준다** — 별도 플래그를 두면 어느
   * 시점에 내려야 하는지가 저장·재조회·전환 세 곳에 흩어지고, 그중 하나를 잊는다.
   */
  const dirty = selected !== null && draft !== null
    && JSON.stringify(draft) !== JSON.stringify(draftOf(selected));

  const avatarPick = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  /** 사진을 걸거나(파일) 지운다(null). `ProfileSettings` 의 선례와 같은 모양이다. */
  const applyAvatar = async (file: File | null): Promise<void> => {
    if (!selected) return;
    setAvatarBusy(true);
    setError(null);
    try {
      await getController().setAgentAvatar(selected.id, file);
    } catch {
      // 서버가 거절하는 가장 흔한 경우는 이미지가 아닌 파일이다(매직 바이트로 판정한다) —
      // 확장자를 믿지 않으므로 `.png` 라는 이름만으로는 통과하지 못한다.
      setError('이미지 파일만 사진으로 쓸 수 있다');
    } finally {
      setAvatarBusy(false);
      // 같은 파일을 다시 고를 수 있게 비운다 — 안 비우면 change 가 안 난다.
      if (avatarPick.current) avatarPick.current.value = '';
    }
  };

  const pick = (a: AgentView) => {
    setSelected(a);
    setView('detail');
    setDraft(draftOf(a));
    setCustomized(a.model !== null || a.effort !== null);
    setPat(null);
    setPats(null);
    setRevoking(null);
    setError(null);
    setConfirmingSlug(null);
    setConfirmingDisable(false);
    loadPats(a);
    loadMemories(a);
  };

  const startNew = () => {
    setSelected(null);
    setView('detail');
    // 기본값을 모르면 초안도 만들지 않는다 — 지어낸 값으로 채우면 그것이 운영자가 정한
    // 기본값인지 구분할 수 없다.
    const known = defaults !== null && defaults !== 'error' ? defaults : null;
    setDraft(known ? emptyDraft(known) : null);
    setCustomized(known !== null && (known.model !== null || known.effort !== null));
    setPat(null);
    setPats(null);
    setRevoking(null);
    setError(null);
    setConfirmingDisable(false);
  };

  /** 'harness 기본값 사용'이면 명시적 null 로 비운다 — 필드를 안 보내면 서버가 기존 값을 유지한다. */
  /**
   * 저장 본문. **admin 전용 필드(`mentionPermission`·`ownerAccountId`)는 admin 일 때만
   * 싣는다**(#253·#299).
   *
   * 서버는 키의 **존재**로 판정한다 — 값이 바뀌지 않았어도 키가 있으면 403 이고 아무것도
   * 저장되지 않는다(`accountRoutes.ts` 의 `ADMIN_ONLY_FIELDS` 주석: 부분 적용 금지).
   * 그래서 이 두 키를 늘 싣던 동안 소유자의 저장 버튼은 **무엇을 고치든 반드시 실패**했다 —
   * 화면은 그저 "저장하지 못했다" 만 띄웠다. 실측으로 나온 결함이다.
   */
  const configPatch = (d: Draft): Partial<AgentConfig> => ({
    instructions: d.instructions,
    harness: d.harness,
    model: customized && d.model ? d.model : null,
    effort: customized && d.effort ? d.effort : null,
    workingDir: d.workingDir || null,
    ...(isAdmin ? { mentionPermission: d.mentionPermission, ownerAccountId: d.ownerAccountId } : {}),
  });

  const submit = async () => {
    setError(null);
    if (!draft) return;
    if (selected) {
      setBusy(true);
      try {
        const updated = await getController().updateAgent(selected.id, configPatch(draft));
        setSelected(updated);
        reload();
      } catch {
        setError('저장하지 못했다');
      } finally { setBusy(false); }
      return;
    }
    if (!/^[a-z0-9_-]{2,32}$/.test(draft.handle)) {
      setError('이름은 소문자·숫자·-·_ 2~32자여야 한다 (채널에서 @이름 으로 부른다)');
      return;
    }
    setBusy(true);
    try {
      const { pat: minted } = await getController().createAgent({
        handle: draft.handle, displayName: draft.handle, ...configPatch(draft),
      });
      setPat(minted);
      reload();
    } catch {
      setError('만들지 못했다 (이미 있는 이름일 수 있다)');
    } finally { setBusy(false); }
  };

  /**
   * 화면의 **중지** 버튼(#129, 어휘는 #493). 러너를 지금 끊는 것이 아니라 "진행 중인 턴을
   * 끝내고 스스로 물러나 달라"는 요청이고, 서버 API 도 그대로 `requestAgentStop` 이다 —
   * 바뀐 것은 버튼에 쓰인 말뿐이다.
   *
   * 목록 전체를 다시 받지 않고 응답으로 온 정의만 갈아끼운다 — 방금 누른 사람이 자기
   * 조작의 결과(요청 시각)를 곧바로 봐야 한다.
   */
  const requestStop = async () => {
    if (!selected) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await getController().requestAgentStop(selected.id);
      setSelected(updated);
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch {
      setError('종료를 요청하지 못했다');
    } finally { setBusy(false); }
  };

  /**
   * 화면의 **실행** 버튼(#427, 어휘는 #493). 서버 API 는 그대로 `undoAgentStopRequest` 다 —
   * 서버 정의에서 시각 둘을 지우면 `startAll` 이 다음에 도는 순간 이 에이전트를 다시 고르고,
   * `#431` 2단계 뒤로는 그 뒤를 daemon 이 실제로 spawn 한다(#482). 그래서 화면에 "실행"이라고
   * 써도 거짓이 아니다 — 자세한 근거는 아래 UI 절의 `#129 → #427 → #493` 주석에 있다.
   *
   * **이 함수가 지금 프로세스를 띄우지는 않는다.** 하는 일은 "자동 기동 대상에 다시 넣는다"
   * 까지이고, 그래서 화면 문구도 "다음 기동부터"라고 적는다.
   *
   * `requestStop` 과 같은 이유로 응답으로 온 정의만 갈아끼운다 — 누른 사람이 자기 조작의
   * 결과(중지가 풀렸다)를 곧바로 봐야 한다. 그리고 그 갱신이 위 폴링(#428)도 멈춘다:
   * 폴은 "중지했으나 러너가 아직 못 받음" 상태에서만 도는데 이 조작이 그 상태를 벗어나게 한다.
   */
  const undoStopRequest = async () => {
    if (!selected) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await getController().undoAgentStopRequest(selected.id);
      setSelected(updated);
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch {
      setError('종료 요청을 되돌리지 못했다');
    } finally { setBusy(false); }
  };

  /** #251: 에이전트를 비활성화하거나 다시 활성화한다. 비활성화는 되돌릴 수 없는 작업이므로
   * 확인 단계가 필요하고, 그 문구에 PAT 폐기·재발급 필요를 적어야 한다. */
  const toggleDisabled = async () => {
    if (!selected) return;
    const willDisable = !selected.disabled;
    if (willDisable && !confirmingDisable) {
      setConfirmingDisable(true);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const updated = await getController().setAgentDisabled(selected.id, willDisable);
      setSelected(updated);
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      // **양쪽 다** 다시 읽는다. 켤 때는 0개라는 사실이 재발급 안내의 근거이고, 끌 때는
      // 확인 문구가 "모든 PAT 가 폐기된다"고 말한 것이 화면에도 나타나야 한다 — 안 읽으면
      // 방금 폐기된 토큰이 살아 있는 것처럼 남는다.
      loadPats(selected);
    } catch {
      setError(willDisable ? '비활성화하지 못했다' : '활성화하지 못했다');
    } finally {
      setBusy(false);
      setConfirmingDisable(false);
    }
  };

  const revokePat = async (label: string) => {
    if (!selected) return;
    setError(null);
    try {
      await getController().revokePat(selected.id, label);
      loadPats(selected);
    } catch {
      setError('PAT 를 폐기하지 못했다');
    }
    setRevoking(null);
  };

  const mintNewPat = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getController().mintPat(selected.id, newPatLabel.trim());
      setPat(token);
      loadPats(selected);
    } catch (e) {
      // 서버가 왜 거절했는지 그대로 보여야 한다 — 특히 '이 라벨은 이미 쓰인다'(409)는
      // 사용자가 라벨만 바꾸면 해결되는 것이라, 뭉개면 막힌 것처럼 보인다.
      setError(e instanceof Error ? e.message : 'PAT 를 새로 발급하지 못했다');
    } finally { setBusy(false); }
  };

  const field = 'w-full rounded border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle';
  const label = 'block text-xs font-medium text-fg-muted';

  /**
   * **한 번에 한 화면이다**(identity 문서). 그리드를 보거나 상세를 보거나 — 나란히 두지
   * 않는다. 문서의 목업이 그리드에는 곁창을 그리지 않았고 상세에는 `← 에이전트` 로 돌아가는
   * 길을 그렸다. 나란히 두면 상세의 폭이 좁아져 세 묶음이 다시 한 줄로 흐른다.
   */
  if (view === 'grid') {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-raised p-5">
        <div className="mb-4">
          <h2 className="text-base font-bold">에이전트</h2>
          <p className="text-[11px] text-fg-subtle">
            채널에서 @이름 으로 부른다. 카드를 누르면 설정이 열린다.
          </p>
        </div>
        {error && <p role="alert" className="mb-2 text-[11px] text-danger">{error}</p>}
        <StaleRunnerBar
          agents={agents}
          runnerStates={runnerStates}
          appVersion={appVersion}
          onError={setError}
        />
        <AgentGrid
          agents={agents}
          selectedId={null}
          runnerStates={runnerStates}
          online={online}
          connected={connected}
          onPick={pick}
          onCreate={startNew}
          canCreate={isAdmin}
          onRelaunch={(a) => {
            /*
              **판정이 `lib/relaunchGate.ts` 하나다**(`docs/desktop-rail.html` 3단계).
              3단계가 레일의 에이전트 칸에도 ▶ 를 세우면서 이 판정을 보는 화면이 둘이 됐다 —
              여기 사본을 남기면 한쪽만 고치는 순간 같은 사람이 한 화면에서는 띄울 수 있고
              다른 화면에서는 못 띄운다(`faceState` 가 나온 것과 같은 이유).

              **이 화면의 모양은 그대로다.** 사이드바는 `canRelaunch` 술어로 권한 없는 카드의
              ▶ 자체를 그리지 않는데, 여기서는 그 술어를 넘기지 않아 예전처럼 ▶ 가 서고
              콜백이 조용히 물러난다. 그 차이를 지금 통일하지 않는 이유는 범위다 — 이 화면의
              모양을 바꾸지 않는 것이 3단계의 전제이고(카드를 두 번 그리지 않기 위해 설정이
              먼저 들어갔다), 여기 ▶ 를 없애는 것은 별개의 판단이다.
            */
            if (!canRelaunchAgent(a, myId ? { id: myId, isAdmin } : null)) return;
            void getController().reissueRunnerPat(a.id).catch((err: unknown) => setError(
              `러너를 띄우지 못했다: ${err instanceof Error ? err.message : String(err)}`,
            ));
          }}
          /*
            **`■` 가 부르는 것**(`docs/desktop-agent-cards.pdf` 2쪽 하단). 상세의 `중지`
            버튼과 **같은 API** 다(`requestAgentStop`) — 격자에서 누르는 것과 상세에서
            누르는 것이 다른 일을 하면 사람이 어느 쪽을 믿을지 고르게 된다.

            권한 술어는 `▶` 와 같은 것을 본다: 러너를 띄울 수 있는 사람이 멈출 수도 있다.
            위 `onRelaunch` 와 같은 이유로 콜백 **안에서** 거른다 — 이 화면은 `canRelaunch`
            를 넘기지 않는 것이 계약이고(그 prop 주석), 여기만 술어를 넘기면 이 변경이
            건드리지 않아야 할 `▶` 의 모양까지 바꾼다.

            **목록만 갈아끼운다.** 상세의 `requestStop` 은 응답을 `setSelected` 에도 넣는데
            여기서는 상세를 안 열고 있다(`view === 'grid'`). 그리고 이 갱신이 위 폴링(`#428`)
            을 켜지 않는다 — 그 폴은 `selected` 를 보고, 격자에서 멈춘 카드는 `selected` 가
            아니다. 카드의 `멈추는 중` 표시는 이 응답이 담은 `stopRequestedAt` 하나로 서고,
            수령 뒤 사라지는 것은 사람이 상세를 열거나 화면을 다시 열 때 갱신된다 — 격자
            전체를 5초마다 다시 읽는 것은 이 변경의 범위가 아니다(`#428` 이 그 범위를 상세
            하나로 좁힌 근거가 그 주석에 있다).
          */
          onStop={(a) => {
            if (!canRelaunchAgent(a, myId ? { id: myId, isAdmin } : null)) return;
            void getController().requestAgentStop(a.id)
              .then((updated) => setAgents(
                (prev) => prev.map((x) => (x.id === updated.id ? updated : x)),
              ))
              .catch(() => setError('종료를 요청하지 못했다'));
          }}
          /* 버전 칩의 기준값. `StaleRunnerBar` 가 읽는 그 값이다 — 띠와 카드가 같은 기준을
             봐야 "3대"가 격자에서 어느 셋인지 맞는다(문서 2쪽 「러너 버전」). */
          appVersion={appVersion}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-surface-raised">


        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-border px-5 py-3">
            {/*
              **돌아가는 길**(문서의 목업이 `← 에이전트` 로 그린 것). 한 번에 한 화면이므로
              이것이 없으면 상세에 들어간 사람이 목록으로 나올 방법이 없다.
            */}
            <button
              data-testid="agent-back"
              className="rounded px-1.5 py-0.5 text-[13px] text-fg-muted hover:bg-surface-hover"
              onClick={() => { setView('grid'); setSelected(null); setError(null); }}
            >
              ← 에이전트
            </button>
            <h2 className="text-base font-bold">{selected ? `Edit ${selected.handle}` : 'Add agent'}</h2>
            {/*
              **생존·마지막 활동·러너 실패는 여기로 내려온다**(Task 15-2). 카드에서는 뺐지만
              (문서: "카드는 조용하다") **없애면 안 되는 사실들**이다 — #124 는 러너 없는
              에이전트가 정상으로 보이던 것을, #176 은 생존과 활동이 서로를 대체하던 것을,
              #368 은 기동 실패가 presence 문구에 묻히던 것을 각각 닫았다. 셋을 나란히 둔다.
            */}
            {selected && (
              <span className="flex flex-wrap items-center gap-2 text-[11px]">
                <span
                  data-testid={`agent-presence-${selected.id}`}
                  data-online={connected ? String(online.includes(selected.id)) : 'unknown'}
                  className={connected && online.includes(selected.id) ? 'text-success' : 'text-fg-muted'}
                >
                  {connected ? (online.includes(selected.id) ? '온라인' : '오프라인') : '연결 끊김 — 알 수 없음'}
                </span>
                {/*
                  #181 소유자. **세 경우를 구별한다** — 없다 / 있고 디렉터리에 있다 / 있는데
                  디렉터리에 없다. 마지막을 빈 칸으로 그리면 "없다"와 구분되지 않고,
                  그것이 design.md 4절이 금지하는 형태의 거울상이다.
                */}
                <span className={accounts[selected.ownerAccountId ?? '']?.handle ? 'text-accent' : 'text-fg-muted'}>
                  {selected.ownerAccountId === null
                    ? '없음'
                    : (accounts[selected.ownerAccountId]?.handle ?? '알 수 없는 계정')}
                </span>
                <span
                  data-testid={`agent-last-turn-${selected.id}`}
                  title={selected.lastTurnAt ? new Date(selected.lastTurnAt).toLocaleString() : undefined}
                  className="text-fg-subtle"
                >
                  {lastTurnLabel(selected.lastTurnAt)}
                </span>
                {runnerStates[selected.id]?.status === 'failed' && (
                  <span
                    data-testid={`agent-runner-failed-${selected.id}`}
                    className="whitespace-normal text-danger"
                  >
                    기동 실패{runnerStates[selected.id]?.message ? ` — ${runnerStates[selected.id]!.message}` : ''}
                  </span>
                )}
              </span>
            )}
          </header>

          <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
            {/* #171 의 '새 에이전트 기본값' 편집 절은 **설정 › Agent defaults 로 옮겼다**
                (identity 문서 원칙 04). 개별 에이전트를 고치는 이 화면에 워크스페이스 전체에
                걸리는 값이 앉아 있으면 지금 무엇을 고치고 있는지가 사라진다.
                읽기는 여기 남는다 — 새 에이전트 초안(`emptyDraft`)을 채우는 서식이기 때문이다. */}
            {draft === null ? (
              // 기본값을 못 읽은 것은 **오류**다 — `role="alert"` 로 알린다. 불러오는 중이거나
              // 권한이 없는 것은 오류가 아니므로 같은 역할을 주지 않는다(붉은 글이 뜬다).
              <div
                role={defaults === 'error' ? 'alert' : undefined}
                className={`rounded border border-border p-3 text-xs ${defaults === 'error' ? 'text-danger' : 'text-fg-subtle'}`}
              >
                {defaults === 'error'
                  ? '기본값을 불러오지 못했다 — 새 에이전트 초안을 만들 수 없다'
                  : (isAdmin ? '기본값을 불러오는 중…' : '에이전트를 만들 수 있는 것은 admin 뿐이다')}
              </div>
            ) : (
            <>
            {/*
              **상세는 세 묶음이다**(identity 문서 Task 15-3): 프로필 · 실행 · 권한.
              전에는 아홉 필드가 한 줄로 흘러 무엇이 무엇과 묶이는지 알 수 없었다.
            */}
            <FieldGroup title="프로필" note="채널에서 어떻게 보이고 무엇을 하는가.">
            {/*
              사진(identity 문서 Task 15-4). **에이전트는 자기 사진을 올릴 손이 없다** —
              소유자가 대신 올려 주지 않으면 영원히 색 하나로 남는다. 문서가 이 화면의 성패를
              여기에 걸었다: "결국 이 화면의 성패는 사람이 사진을 올리게 만드는 것에 달린다."
              (`handleColor()` 의 12색은 26개 밀도에서 이미 시끄럽고, 색은 **사진이 없을 때의
              임시값**이라는 뜻이다.)

              새 에이전트에는 그리지 않는다 — 아직 계정이 없어 걸 대상이 없다.
            */}
            {selected && (
              <div className="flex items-center gap-3">
                <Identity account={selected} className="h-12 w-12 text-base" variant="avatar" />
                <input
                  ref={avatarPick}
                  type="file"
                  data-testid="agent-avatar-file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void applyAvatar(f); }}
                />
                <Button disabled={avatarBusy} onClick={() => avatarPick.current?.click()}>
                  사진 올리기
                </Button>
                {selected.avatarAttachmentId && (
                  <Button variant="danger" disabled={avatarBusy} onClick={() => void applyAvatar(null)}>
                    지우기
                  </Button>
                )}
                <span className="text-[11px] text-fg-subtle">비우면 이름에서 색을 뽑는다</span>
              </div>
            )}
            <label className={label}>
              Agent name
              <input
                className={field}
                aria-label="Agent name"
                placeholder="fizz"
                value={draft.handle}
                disabled={selected !== null}
                onChange={(e) => setDraft({ ...draft, handle: e.target.value })}
              />
              {!selected && <span className="text-[11px] text-fg-subtle">채널에서 @이름 으로 부른다. 나중에 바꿀 수 없다.</span>}
            </label>

            <label className={label}>
              Agent instructions
              <textarea
                className={`${field} resize-y`}
                aria-label="Agent instructions"
                rows={6}
                placeholder="이 에이전트가 무엇을 하는지 적는다."
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              />
            </label>

            </FieldGroup>

            <FieldGroup title="실행" note="무엇으로 도는가.">
            <div>
              <div className={label}>AI configuration</div>
              <div className="mt-1 flex gap-1">
                <button
                  className={`flex-1 rounded px-3 py-2 ${customized ? 'bg-surface-sunken text-fg-muted' : 'bg-surface-raised shadow ring-1 ring-border'}`}
                  onClick={() => setCustomized(false)}
                >
                  Use harness defaults
                </button>
                <button
                  className={`flex-1 rounded px-3 py-2 ${customized ? 'bg-surface-raised shadow ring-1 ring-border' : 'bg-surface-sunken text-fg-muted'}`}
                  onClick={() => setCustomized(true)}
                >
                  Customize for this agent
                </button>
              </div>
            </div>

            <label className={label}>
              Agent harness
              <select
                className={field}
                aria-label="Agent harness"
                value={draft.harness}
                onChange={(e) => setDraft({ ...draft, harness: e.target.value as AgentConfig['harness'] })}
              >
                {AGENT_HARNESSES.map((h) =>
                  (RUNNABLE_HARNESSES as readonly string[]).includes(h)
                    ? <option key={h} value={h}>{h} (default)</option>
                    : <option key={h} value={h} disabled>{h} (지원 예정)</option>,
                )}
                {PLANNED.map((h) => (
                  <option key={h} value={h} disabled>{h} (지원 예정)</option>
                ))}
              </select>
            </label>

            {/* 계정 풀 — **이 기기에만 저장된다.** 위 필드들과 저장 경로가 다르므로
                (서버 PATCH 가 아니라 로컬 데몬) 고르는 즉시 쓰고, 그 사실을 적는다.
                표면이 없으면 아예 그리지 않는다 — 그려 두면 고를 수 있는데 아무 일도 안 난다.

                **읽는 중·읽기 실패는 "없음"이 아니다.** 그때도 칸은 그리고 잠그기만 한다 —
                감추면 아래 `agentPool.error` 를 그릴 자리도 같이 사라져, 데몬이 대답을 못 한
                것뿐인데 사람은 "이 앱에 그런 기능이 없다"고 읽는다. */}
            {agentPool.available && (
              <label className={label}>
                Account pool
                <select
                  className={field}
                  aria-label="Account pool"
                  disabled={!agentPool.ready}
                  value={agentPool.assigned}
                  onChange={(e) => void agentPool.assign(e.target.value)}
                >
                  <option value="">
                    {agentPool.defaultPool
                      ? `Use the default pool (${agentPool.defaultPool})`
                      : 'Use the default pool'}
                  </option>
                  {agentPool.pools.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <span className="mt-1 block text-[11px] text-fg-subtle">
                  This machine only — pools are local directories, so this is not shared
                  with other devices. Restart the runner for a change to take effect.
                </span>
                {agentPool.error && (
                  <span className="mt-1 block text-[11px] text-danger">{agentPool.error}</span>
                )}
              </label>
            )}

            </FieldGroup>

            <FieldGroup title="권한" note="누가 조종하고 무엇을 할 수 있는가.">
            {/* #253 의 표에서 `mentionPermission` 은 **admin 전용**이다. 소유자에게는 비활성
                입력이 아니라 **아예 그리지 않는다** — 눌러도 안 되는 것을 보여 주면 사람은
                자기가 뭘 잘못했다고 생각한다(#299). 값 자체는 아래 읽기 전용 칸에 적는다. */}
            {isAdmin && (
              <label className={label}>
                Mention permission
                <select
                  className={field}
                  aria-label="Mention permission"
                  value={draft.mentionPermission}
                  onChange={(e) => setDraft({ ...draft, mentionPermission: e.target.value as MentionPermission })}
                >
                  <option value="auto">auto — 멘션 턴에서 도구를 모두 허용</option>
                  <option value="readonly">readonly — 읽기만 (상담 전용)</option>
                </select>
                <span className="text-[11px] text-fg-subtle">
                  사람이 터미널로 직접 조종할 때는 이 설정과 무관하게 하네스가 물어본다.
                </span>
              </label>
            )}

            {customized && (
              <div className="grid grid-cols-2 gap-3">
                <label className={label}>
                  Model
                  <input
                    className={field}
                    aria-label="Model"
                    placeholder="harness 기본값"
                    value={draft.model}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  />
                </label>
                <label className={label}>
                  Effort
                  <select
                    className={field}
                    aria-label="Effort"
                    value={draft.effort}
                    onChange={(e) => setDraft({ ...draft, effort: e.target.value })}
                  >
                    <option value="">harness 기본값</option>
                    {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                </label>
              </div>
            )}

            <label className={label}>
              Working directory
              <input
                className={field}
                aria-label="Working directory"
                placeholder="/Users/me/some-repo — 비우면 스레드 전용 빈 디렉터리를 새로 만든다"
                value={draft.workingDir}
                onChange={(e) => setDraft({ ...draft, workingDir: e.target.value })}
              />
            </label>

            {selected && isAdmin && (
              <label className={label}>
                소유자
                <select
                  className={field}
                  aria-label="Owner"
                  value={draft.ownerAccountId ?? ''}
                  onChange={(e) => setDraft({ ...draft, ownerAccountId: e.target.value || null })}
                >
                  <option value="">없음 — attach 불가</option>
                  {humanAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.handle}</option>
                  ))}
                </select>
                <span className="text-[11px] text-fg-subtle">
                  소유자만 이 에이전트에 attach 할 수 있다.
                </span>
              </label>
            )}

            {!isAdmin && selected && (
              <div className="rounded border border-border bg-surface p-3">
                <div className="text-xs text-fg-subtle">
                  {draft.ownerAccountId
                    ? `소유자: @${accounts[draft.ownerAccountId]?.handle ?? '?'}`
                    : '소유자: 없음 — attach 불가'}
                </div>
                {/* admin 전용 필드의 **값**은 숨길 것이 아니다 — 숨기면 소유자는 자기 에이전트가
                    읽기 전용인지도 모른 채 부른다. 바꿀 수 없다는 것만 분명히 한다. */}
                <div className="mt-1 text-xs text-fg-subtle">
                  {`Mention permission: ${draft.mentionPermission} (admin 만 바꾼다)`}
                </div>
              </div>
            )}

            </FieldGroup>
            </>
            )}

            {selected && (isAdmin || isOwner) && (
              <div className="rounded border border-border p-3">
                <div className="text-xs font-medium text-fg-muted">기억 (memory)</div>
                {/* 읽기·삭제만이다. 편집을 넣지 않는 이유(#139): 사람이 고쳐도 에이전트가
                    다음 턴에 덮어쓰면 **사람은 자기 수정이 왜 사라졌는지 알 수 없다.** */}
                <div className="mt-2 space-y-2">
                  {memories === null && <div className="text-[11px] text-fg-muted">불러오는 중…</div>}
                  {memories === 'error' && (
                    <div role="alert" className="text-[11px] text-danger">기억을 불러오지 못했다</div>
                  )}
                  {Array.isArray(memories) && memories.length === 0 && (
                    <div className="text-[11px] text-fg-muted">기억이 없다</div>
                  )}
                  {Array.isArray(memories) && memories.map((m) => (
                    <div key={m.slug} className="rounded bg-surface px-2 py-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">{m.slug}</span>
                        {confirmingSlug === m.slug ? (
                          <span className="flex gap-1">
                            {/* 되돌릴 수 없으니 한 번 더 묻는다 — MessageItem 의 삭제 확인과 같은 규칙. */}
                            <button
                              className="rounded border border-danger-border bg-danger-surface px-1.5 text-[11px] text-danger"
                              onClick={() => {
                                setConfirmingSlug(null);
                                void getController().deleteAgentMemory(selected.id, m.slug)
                                  .then(() => loadMemories(selected))
                                  .catch(() => setError('기억을 지우지 못했다'));
                              }}
                            >
                              정말 지운다
                            </button>
                            <button
                              className="rounded border border-border px-1.5 text-[11px] text-fg-muted"
                              onClick={() => setConfirmingSlug(null)}
                            >
                              두기
                            </button>
                          </span>
                        ) : (
                          <button
                            className="rounded border border-border px-1.5 text-[11px] text-fg-muted"
                            aria-label={`${m.slug} 기억 지우기`}
                            onClick={() => setConfirmingSlug(m.slug)}
                          >
                            지우기
                          </button>
                        )}
                      </div>
                      {/* 값은 최대 8000자다 — 설정 화면이 그것 때문에 무한히 길어지면 안 된다. */}
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-fg-muted">
                        {m.value}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* #251: 에이전트 비활성화/활성화. 관리 행위이므로 admin 만 보인다. */}
            {selected && isAdmin && (
              <div className={`rounded border p-3 ${selected.disabled ? 'border-border bg-surface' : 'border-danger-border bg-danger-surface'}`}>
                <div className="text-xs font-medium text-fg-muted">
                  {selected.disabled ? '비활성화된 에이전트' : '에이전트 활성화'}
                </div>
                {selected.disabled ? (
                  <div className="mt-2">
                    <p className="text-[11px] text-fg-subtle mb-2">
                      이 에이전트는 비활성화되어 있습니다. 다시 활성화하면 PAT 가 없다(재발급 필요)고
                      안내가 뜹니다 — 비활성화 시 모든 PAT 가 폐기되었기 때문입니다.
                    </p>
                    <button
                      className="rounded border border-accent bg-accent-surface px-2 py-1 text-xs font-medium text-accent hover:bg-surface-hover disabled:opacity-50"
                      aria-label="에이전트 활성화"
                      disabled={busy}
                      onClick={() => void toggleDisabled()}
                    >
                      활성화
                    </button>
                  </div>
                ) : confirmingDisable ? (
                  <div className="mt-2">
                    <p className="text-[11px] text-danger mb-2">
                      <strong>이 에이전트의 모든 PAT 가 폐기</strong>되어 러너가 멈춥니다.
                      다시 활성화해도 PAT 는 돌아오지 않으며, <strong>새로 발급</strong>해야 합니다.
                    </p>
                    <div className="flex gap-1">
                      <button
                        className="rounded border border-danger-border bg-danger-surface px-2 py-1 text-xs font-medium text-danger hover:bg-danger-surface-strong disabled:opacity-50"
                        aria-label="정말 비활성화"
                        disabled={busy}
                        onClick={() => void toggleDisabled()}
                      >
                        정말 비활성화
                      </button>
                      <button
                        className="rounded border border-border px-2 py-1 text-xs text-fg-muted hover:bg-surface-sunken"
                        onClick={() => setConfirmingDisable(false)}
                      >
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2">
                    <p className="text-[11px] text-fg-subtle mb-2">
                      에이전트를 비활성화하면 <strong>모든 PAT 가 폐기</strong>되고, 다시 활성화해도
                      PAT 는 복구되지 않아 <strong>새로 발급</strong>해야 합니다.
                    </p>
                    <button
                      className="rounded border border-danger-border bg-danger-surface px-2 py-1 text-xs font-medium text-danger hover:bg-danger-surface-strong disabled:opacity-50"
                      aria-label="에이전트 비활성화"
                      disabled={busy}
                      onClick={() => void toggleDisabled()}
                    >
                      비활성화
                    </button>
                  </div>
                )}
              </div>
            )}

            {selected && isAdmin && (
              <div className="rounded border border-border p-3">
                {/* #129 → #427 → #493: "재시작"을 금지한 원칙은 그대로 살아 있고, **사실관계만
                    바뀌었다.** 지우지 말고 이 이력을 읽어라 — 그러지 않으면 다음 사람이 이
                    자리를 또 뒤집는다.

                    `#129`(2026-08) 이 못박은 것: *"재시작"이라고 쓰지 않는다. murmur 는 러너를
                    띄우지 않으므로 재시작은 murmur 가 할 수 있는 일이 아니고, **할 수 없는 일을
                    버튼 이름으로 약속하면 그것이 곧 거짓 신호다**(docs/design.md 4절).*
                    그때는 참이었다 — murmur 는 "외부 접속형"이었고 러너를 띄우는 것은 사람과
                    그 머신의 launchd/systemd 감독의 몫이었다.

                    **무엇이 바뀌었나**: `#431` 2단계에서 **daemon 이 러너의 오퍼레이터가 됐고,
                    이 앱이 그 daemon 을 통해 실제로 러너를 띄운다**(`#482`).
                    `controller.startRunners` → `runnerLauncher.startAll` → `daemon_spawn_runner`
                    → daemon 의 `spawn(detached)` 까지 실제 경로가 있다. 그래서 "실행"은 이제
                    이 앱이 못 하는 일을 약속하는 말이 아니다. `#129` 의 원칙(할 수 없는 일을
                    이름으로 약속하지 마라)은 그대로 지켜지고, 그 원칙이 걸러 내던 대상이
                    사라졌을 뿐이다.

                    **다만 이 버튼이 프로세스를 지금 띄우지는 않는다.** `startAll` 은 앱 기동 뒤
                    첫 `presence.snapshot` 에서 한 번만 돈다(`controller.ts` 의
                    `runnerAutoStartDone` 플래그) — 주기 타이머가 아니다. 이 버튼이 하는 일은
                    "자동 기동 대상에 다시 넣는다"까지고, 실제 spawn 은 **다음 기동**이다.
                    그래서 아래 문구도 "다음 기동에서 뜬다"라고 쓴다 — "지금 뜬다"라고 쓰면
                    `#129` 가 금지한 그 거짓 신호를 이름만 바꿔 되살리는 셈이 된다.

                    **`#141` 재기동이 그 위에 하나를 더 얹었다.** 그리드의 [뒤처진 러너 전체
                    재기동]과 프로필의 [새 버전으로 재기동]은 **실제로 죽이고 다시 띄운다**
                    (`RunnerLauncher.restart` → daemon 의 `killRunner` → 종료 확인 → spawn).
                    이 절의 [실행]과 갈라 두는 이유: 그것은 "자동 기동 대상에 넣는다"이고
                    저것은 "지금 도는 러너를 갈아 준다"다 — 하나로 뭉치면 어느 쪽도 정확히
                    말하지 못한다. 그리고 **"새 버전으로"는 뒤처졌다고 확인된 때만** 쓴다:
                    버전을 모르는 러너에는 그냥 [러너 재기동]이다(`runnerVersions.ts`).

                    **그래도 여전히 금지인 것**: "멈췄다"·"종료됨" 류의 **생사 단정**. 러너가
                    종료하면 다음 GET /agent/config 자체가 오지 않아 서버는 프로세스가 실제로
                    죽었는지 영원히 모른다(019_agent_stop_request.sql). daemon 이 생사를 아는
                    문제는 `#443` 의 자리이고, 이 절이 답하는 질문이 아니다 — 이 절은
                    "이 에이전트가 자동 기동 대상에 들어와 있는가"에만 답한다. */}
                <div className="text-xs font-medium text-fg-muted">러너 실행 · 중지</div>
                {/* #493: 버튼이 "종료 요청"/"요청 되돌리기" 둘에서 **한 자리 토글**로 접혔다.
                    "요청"·"되돌리기"는 서버 API 의 대칭(`stop` ↔ `stop/undo`)에서 온 **내부
                    어휘**였다. 사람은 "내가 보낸 요청을 취소한다"고 생각하지 않는다 —
                    "이 에이전트를 다시 켠다"고 생각한다.

                    버튼 이름이 짧아진 만큼 **잃으면 안 되는 뉘앙스가 이 문단으로 왔다**:
                    중지는 즉시 죽이는 것이 아니라 **진행 중인 턴을 마친 뒤 스스로 물러나는**
                    것이고, 턴 중간에 끊기지 않는다. 버튼만 보면 "중지 = 지금 끊긴다"로 읽히므로
                    이 사실은 반드시 글로 남아 있어야 한다.

                    **여기서 daemon 의 생사를 말하지는 않는다** — `#443` 의 자리다. */}
                <p className="mt-1 text-[11px] text-fg-subtle">
                  <strong>중지</strong>는 러너를 지금 끊지 않는다 — 러너가
                  <strong> 진행 중인 턴을 마친 뒤 스스로 종료</strong>한다. 턴 중간에 끊지 않는 것은
                  사람이 기다리는 답을 잃지 않기 위해서다. 중지해 둔 동안 이 에이전트는
                  <strong> 자동 기동에서 빠진다</strong>. <strong>실행</strong>을 누르면 다시 대상에
                  들어와 <strong>다음 기동에서 러너가 뜬다</strong> — 지금 이 자리에서 띄우지는
                  않는다. 둘 다 언제든 되돌릴 수 있는 조작이다.
                </p>
                {/* #493: **세 상태를 버튼이 아니라 이 상태 표시로 옮겼다.**

                    버튼 자리는 하나여야 한다 — 사람이 답해야 하는 질문은 "지금 켤까 끌까" 하나뿐이고,
                    그 질문에 버튼 둘을 내밀면 어느 쪽이 지금 상태인지를 사람이 역산해야 한다.
                    그러나 **세 상태는 접으면 안 된다.** 특히 `stopAckedAt` 이 없는 동안은
                    "중지를 걸었는데 그 요청이 아직 러너에게 닿지 않았다"는 뜻이고, 이것은 사람이
                    알아야 할 사실이다 — 러너가 붙어 있지 않으면 읽어 갈 쪽이 없어 요청은 계속
                    미수령으로 남는다. 접어 버리면 사람은 "눌렀는데 왜 안 멈추지"를 알 길이 없다.

                    그래서 **버튼은 이분(실행/중지), 상태 표시는 삼분**으로 나눈다. 둘은 같은 값을
                    다른 해상도로 읽는다: 버튼은 `stopRequestedAt` 의 유무만, 상태 표시는 거기에
                    `stopAckedAt` 을 더해 셋을 가른다.

                    **'멈췄다'고 쓰지 않는다** — 위 주석과 019 마이그레이션이 그 이유를 적었다. */}
                <div className="mt-2 text-[11px]" role="status">
                  {!selected.stopRequestedAt && (
                    <span className="text-fg-muted">
                      자동 기동 대상이다 — 중지를 걸어 둔 적이 없다.
                    </span>
                  )}
                  {selected.stopRequestedAt && !selected.stopAckedAt && (
                    <span className="text-warning">
                      중지함 ({new Date(selected.stopRequestedAt).toLocaleString()}) —
                      러너가 아직 읽어 가지 않았다. 러너가 붙어 있지 않으면 읽어 갈 쪽도 없다.
                    </span>
                  )}
                  {selected.stopRequestedAt && selected.stopAckedAt && (
                    <span className="text-fg-muted">
                      러너가 요청을 읽어 갔다 (중지 {new Date(selected.stopRequestedAt).toLocaleString()}
                      {' '}· 수령 {new Date(selected.stopAckedAt).toLocaleString()}).
                      진행 중이던 턴을 마치고 종료한다 — 실제로 종료했는지는 murmur 가 알 수 없다.
                      {/* #427 → #493: 러너가 이미 읽어 간 뒤가 오히려 다시 켤 필요가 생기는
                          자리다 — 그 뒤로는 자동 기동이 이 에이전트를 영영 건너뛴다. 실행을
                          누른다고 이미 물러난 러너가 그 자리에서 되살아나지는 않으므로
                          '다음 기동부터'라고 쓴다. */}
                      {' '}실행을 누르면 다음 기동부터 다시 자동 기동 대상이 된다.
                    </span>
                  )}
                </div>
                {/* #493: 켜는 길과 끄는 길을 **한 자리**에 겹쳐 둔다. `#427` 이 "되돌리는 길을
                    요청과 같은 자리에 둔다"고 한 것을 한 걸음 더 민 것이다 — 다른 자리로 보내면
                    "설정에서 껐으니 설정에서 켜겠지"로 읽는 사람이 그것을 못 찾고, 못 찾으면
                    DB 를 고치러 간다(#427 이 실제로 밟힌 경로다).

                    한 자리이므로 "누를 것이 없는 버튼"이 애초에 생기지 않는다 — 이 자리에는
                    항상 지금 할 수 있는 조작 하나만 서 있다.

                    서버 API 는 그대로다 — 실행은 `undoAgentStopRequest`, 중지는 `requestAgentStop`.
                    화면 어휘만 사람의 어휘로 바꿨고 장부·라우트는 건드리지 않았다. */}
                <div className="mt-2 flex gap-2">
                  {selected.stopRequestedAt ? (
                    <button
                      className="rounded border border-border px-2 py-1 text-xs font-medium text-fg-default hover:bg-surface-sunken disabled:opacity-50"
                      aria-label="러너 실행"
                      disabled={busy}
                      onClick={() => void undoStopRequest()}
                    >
                      실행
                    </button>
                  ) : (
                    <button
                      className="rounded border border-warning-border bg-warning-surface px-2 py-1 text-xs font-medium text-warning hover:bg-warning-surface-strong disabled:opacity-50"
                      aria-label="러너 중지"
                      disabled={busy}
                      onClick={() => void requestStop()}
                    >
                      중지
                    </button>
                  )}
                </div>
              </div>
            )}

            {selected && (isAdmin || isOwner) && (
              <div className="rounded border border-border p-3">
                <div className="text-xs font-medium text-fg-muted">PAT (Personal Access Token)</div>
                <div className="mt-2 space-y-2">
                  {pats === null ? (
                    <div className="text-[11px] text-fg-muted">PAT 를 읽고 있다…</div>
                  ) : pats === 'error' ? (
                    // 실패를 '없음'으로 그리면 살아 있는 PAT 를 없다고 하고, 그 위에서
                    // "새로 발급해야 한다"까지 말하게 된다(docs/design.md 4절).
                    <div className="text-[11px] text-danger" role="alert">PAT 목록을 읽지 못했다</div>
                  ) : pats.length === 0 ? (
                    /* #251: 켜진 에이전트에 PAT 가 0개면 러너가 뜰 수 없다 — 비활성화가
                       PAT 를 전부 폐기하고 다시 켜도 되살리지 않으므로(서버가 해시만
                       보관한다), 재발급이 필요하다는 것을 이 자리에서 말한다. 꺼진
                       에이전트에서는 0개가 정상 상태라 권하지 않는다. */
                    <div className={`text-[11px] ${selected.disabled ? 'text-fg-muted' : 'text-warning'}`}>
                      {selected.disabled
                        ? 'PAT 가 없다'
                        : 'PAT 가 없다 — 새로 발급해야 한다(비활성화 시 전부 폐기됨)'}
                    </div>
                  ) : (
                    pats.map((p) => (
                      <div key={`${p.label}:${p.createdAt}`} className="flex items-center justify-between rounded bg-surface px-2 py-1.5">
                        <div className="text-xs">
                          <span className="font-medium">{p.label}</span>
                          {p.revokedAt && (
                            <span className="ml-2 text-danger">(폐기됨)</span>
                          )}
                          <span className="ml-2 text-fg-muted">
                            {new Date(p.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        {!p.revokedAt && (
                          revoking === p.label ? (
                            <div className="flex items-center gap-1">
                              <button
                                className="rounded border border-danger-border bg-danger-surface px-1.5 py-0.5 text-[11px] text-danger"
                                onClick={() => void revokePat(p.label)}
                              >
                               Really revoke
                              </button>
                              <button
                                className="px-1.5 py-0.5 text-[11px] text-fg-subtle"
                                onClick={() => setRevoking(null)}
                              >
                               Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              className="text-[11px] text-danger hover:underline"
                              onClick={() => setRevoking(p.label)}
                            >
                              Revoke
                            </button>
                          )
                        )}
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    ref={newPatLabelRef}
                    className="w-40 rounded border border-border bg-field px-2 py-1 text-xs"
                    aria-label="New PAT label"
                    placeholder="runner"
                    value={newPatLabel}
                    onChange={(e) => setNewPatLabel(e.target.value)}
                  />
                  <button
                    className="rounded bg-surface-sunken px-2 py-1 text-xs font-medium text-fg hover:bg-surface-hover disabled:opacity-50"
                    disabled={busy || newPatLabel.trim() === ''}
                    onClick={() => void mintNewPat()}
                  >
                    + New PAT
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-fg-muted">
                  라벨은 살아 있는 토큰 안에서 유일합니다. 폐기하면 같은 라벨을 다시 쓸 수 있습니다.
                </p>
              </div>
            )}

            {/* #176: 목록 조회가 실패하면 마지막 활동도 presence 도 알 수 없다 — 그때 빈 화면을
                그리면 '에이전트가 없다'와 '못 읽었다'가 같아진다. 위 PAT 로더가 실패를
                `setPats([])` 로 삼키는데, 그것을 따라 하지 않는다. role 을 주는 이유: 색만으로
                는 스크린리더에 아무 말도 하지 않는다. */}
            {error && <p role="alert" className="text-xs text-danger">{error}</p>}

            {pat && (
              // 서버가 해시만 보관하므로 지금 놓치면 다시 볼 수 없다.
              <div className="rounded border border-warning-border bg-warning-surface p-3">
                <div className="text-xs font-semibold text-warning">
                  이 토큰은 지금만 보인다 — 서버가 해시만 보관하므로 다시 볼 수 없다
                </div>
                <code className="mt-1 block break-all rounded bg-surface-raised p-2 text-[11px]">{pat}</code>
                {/* #125: 이 명령의 토큰을 자르고 말줄임표를 붙여 두면, 그대로 복사해 실행했을 때
                    인증이 실패한다 — "완성된 명령"처럼 보이는데 아니었다. 전체 토큰을 싣는다.
                    바로 위 코드 블록에 이미 전체 토큰이 있으므로 중복 노출이 새 위험은 아니다.

                    **명령 자체는 `runnerCommand.ts` 가 만든다**(`#431` 1단계·`#494`). 여기서
                    문자열을 짓지 않는 이유는 이 자리가 정확히 그렇게 낡았기 때문이다 — 러너가
                    사이드카 배포로 바뀌었는데 화면에는 `pnpm --filter @murmur/agent start` 가
                    남아, 저장소를 클론하지 않은 사람에게 **붙여넣는 순간 실패하는 명령**을
                    복사시키고 있었다. 근거 전문은 그 파일 머리말에 있다. */}
                <div className="mt-2 flex flex-col gap-1 break-all font-mono text-[11px] text-warning">
                  <span ref={fullCommandRef} className="whitespace-pre-wrap">
                    {runnerCommandClipboardText(pat)}
                  </span>
                  <button
                    className="self-start shrink-0 rounded border border-warning-border bg-warning-surface-strong px-1.5 py-0.5 text-[11px] text-warning hover:bg-warning-border"
                    aria-label="명령 복사"
                    onClick={async () => {
                      // #125: 토큰을 자르거나 말줄임표를 붙이지 않는다 — 클립보드에도 명령 전체가 들어간다.
                      const cmd = runnerCommandClipboardText(pat);
                      setError(null);
                      const ok = await copyToClipboard(cmd, fullCommandRef.current, setError);
                      if (ok) {
                        setCopySuccess('full');
                        setTimeout(() => setCopySuccess((s) => s === 'full' ? null : s), 2000);
                      }
                    }}
                  >
                    {copySuccess === 'full' ? '복사됨' : '복사'}
                  </button>
                </div>
                {/* #125: 등록만으로는 아무 일도 일어나지 않는다. 실측으로 에이전트 6개 중 4개가
                    러너를 가져본 적이 없고 그중 2개는 미읽음 멘션이 쌓인 채였다. 사용자의 기대는
                    "UI 로 등록했으면 러너도 같이 떴어야 하는 것 아닌가"였다 — 그 기대를 바로잡는다.

                    #250 이 그 기대의 절반을 실제로 만족시켰다: **이 데스크탑 앱은** 내가
                    소유한 에이전트의 러너를 띄운다. 그래서 문구를 고친다 — 옛 문구("murmur 는
                    러너를 띄우지 않는다")를 그대로 두면 아래의 "러너 (이 앱)" 절과 정면으로
                    어긋나고, 어느 쪽을 믿어야 할지 사람이 알 수 없다. 서버는 여전히 러너를
                    띄우지 않는다(design.md §1 외부 접속형) — 띄우는 것은 앱이다. */}
                {/* 마지막 문장이 낡아 있었다: *"murmur 저장소를 체크아웃한 머신에서
                    실행한다"* 는 러너가 소스로 돌던 시절의 조건이다. 사이드카 배포
                    (`#431` 1단계·`#494`) 뒤로는 **앱이 설치된 머신**이면 된다 —
                    저장소는 개발 갈래에서만 필요하다. */}
                <p className="mt-2 text-[11px] text-warning">
                  murmur <strong>서버</strong>는 러너를 띄우지 않는다. 이 데스크탑 앱은
                  <strong> 내가 소유한</strong> 에이전트만 띄운다 — 남이 소유했거나 소유자가
                  없는 에이전트는 <strong>위 명령을 직접 실행해 러너를 붙이기 전까지 멘션에
                  답하지 않는다</strong>(멘션은 쌓이기만 한다). 러너는 앱과 함께 배포되므로
                  murmur 앱이 설치된 머신이면 된다 — 저장소는 아래 개발용 갈래에만 필요하다.
                </p>
              </div>
            )}

            {/* #250: 이 앱이 띄운 러너의 상태와 회전 버튼. **소유자에게도 보인다** —
                실행기의 대상 판정이 `ownerAccountId === 내 id` 이므로, admin 에게만 보이면
                자기 러너를 띄운 소유자가 그 상태를 볼 수도 재발급할 수도 없다.

                이 절은 위 "러너 실행" 명령 틀(#177)과 **둘 다** 남는다: 앱이 띄우는 것은
                내가 소유한 에이전트뿐이고, 남의 머신에서 손으로 띄우는 길은 그대로 있다.

                **앞 판본은 여기에 "그렇게 뜬 러너는 '외부에서 실행 중'으로 보인다"고
                적어 뒀었다. 두 군데가 틀렸다**(`#482`, `#430`):

                1. `external` 이라는 상태가 없어졌다 — 지금 값은 `adopted` 이고 화면 문구는
                   `RunnerStatus.tsx::runnerStatusLabel` 이 정한다.
                2. 더 중요하게, **손으로 띄운 러너는 그렇게 보이지 않는다.** `adopted` 는
                   *"이 daemon 의 장부에 있고 `kill(pid, 0)` 으로 살아 있음을 확인했다"* 이고,
                   장부에는 **이 daemon 이 spawn 한 것만** 들어간다. 남이 띄운 러너는 장부에
                   없으므로 daemon 은 그 존재를 모른다 — 서버 presence 에 보이면 그 어긋남을
                   사유 한 줄로 말할 뿐 상태로 삼지 않는다(`runnerLauncher.ts::STRANGER_ATTACHED`).
                   판정을 presence 추측에서 daemon 관측으로 옮긴 것이 `#430` 의 핵심이었다. */}
            {selected && (isAdmin || (myId !== undefined && selected.ownerAccountId === myId)) && (
              <div className="rounded border border-border p-3">
                <div className="text-xs font-medium text-fg-muted">러너 (이 앱)</div>
                {/* 상태 문구를 여기 하드코딩하지 않는다 — `runnerStatusLabel` 에서 받아 온다.
                    이 설명이 낡았던 이유가 정확히 그 하드코딩이었다: `#482` 가 `external` 을
                    `adopted` 로 바꾸며 `RunnerStatus.tsx` 의 문구를 고쳤는데, 같은 말을 제 손으로
                    적어 둔 이 문장은 따라오지 않아 화면 두 자리가 서로 다른 말을 했다.
                    같은 출처에서 내면 다음 개명도 저절로 따라온다. */}
                <p className="mt-1 text-[11px] text-fg-subtle">
                  이 앱은 <strong>내가 소유한</strong> 에이전트의 러너를 띄운다.{' '}
                  <strong>daemon 이 이미 들고 있는</strong> 러너가 살아 있으면 새로 띄우지 않고
                  &apos;{runnerStatusLabel({ agentId: '', status: 'adopted', exitCode: null, message: null })}&apos;
                  으로 표시한다 — 같은 에이전트에 러너가 둘이면 멘션을 두 러너가 나눠 집어 간다.
                </p>
                {/* 남이 띄운 러너를 이 화면이 못 본다는 것은 **한계 고백**이라 따로 적는다.
                    앞 문장에 "누가 띄웠든"으로 뭉쳐 두면 사람은 손으로 띄운 러너도 여기
                    나타날 것으로 읽고, 안 나타나면 앱이 고장 났다고 판단한다. */}
                <p className="mt-1 text-[11px] text-fg-subtle">
                  daemon 은 <strong>자기가 띄운 러너만</strong> 안다. 다른 머신이나 손으로 띄운
                  러너는 이 목록에 없어서 여기 나타나지 않는다 — 그때는 서버에 붙어 있다는
                  사실만 사유로 붙고, 이 앱은 자기 러너를 그대로 띄운다.
                </p>
                <div className="mt-2">
                  <RunnerStatusLine state={runnerStates[selected.id]} />
                </div>
                {/* 재발급은 순서가 요점이다: 새 발급 → 옛 폐기 → 재실행. 폐기가 먼저면
                    발급 실패 한 번에 쓸 수 있는 PAT 가 사라진다(runnerLauncher.ts 주석). */}
                <button
                  className="mt-2 rounded border border-warning-border bg-warning-surface px-2 py-1 text-xs font-medium text-warning hover:bg-warning-surface-strong disabled:opacity-50"
                  aria-label="PAT 재발급"
                  disabled={reissuing}
                  onClick={() => {
                    const id = selected.id;
                    setReissuing(true);
                    setError(null);
                    void getController().reissueRunnerPat(id)
                      .catch((err: unknown) => setError(
                        `PAT 재발급에 실패했다: ${err instanceof Error ? err.message : String(err)}`,
                      ))
                      .finally(() => setReissuing(false));
                  }}
                >
                  {reissuing ? '재발급 중…' : 'PAT 재발급'}
                </button>
                <p className="mt-1 text-[11px] text-fg-subtle">
                  새 PAT 를 발급하고 <strong>옛 PAT 를 폐기한 뒤</strong> 러너를 다시 띄운다.
                  옛 PAT 로 돌던 러너(다른 머신의 것도)는 다음 호출에서 401 을 받고 종료 코드
                  78 로 스스로 물러난다.
                </p>
              </div>
            )}

            {/* #177: 러너 실행 명령 틀은 **항상** 보인다 — PAT 를 막 발급한 직후만이 아니다.
                토큰은 해시만 저장하므로 재노출이 불가능하다(design.md §4). 그래서 여기서는
                자리표시가 든 틀만 보이고, 전체 토큰이 든 명령은 위의 발급 직후 화면에만 있다.
                PAT 개수로 이 절을 가리지 않는다: PAT 가 0 개인 에이전트야말로 "무엇을 실행해야
                하는가"를 알아야 하고, 틀에는 비밀이 없다.

                **이 절은 남는다** — `#482` 로 앱이 daemon 을 먼저 세우고 러너를 spawn 하게
                됐지만, 앱이 띄우는 대상은 `ownerAccountId` 가 내 계정인 에이전트뿐이다.
                남이 소유했거나 소유자가 없는 에이전트, 그리고 이 앱이 안 도는 머신에 붙일
                러너는 지금도 사람이 띄운다. 낡은 것은 절의 존재 이유가 아니라 **명령**이었다
                (`runnerCommand.ts` 머리말). */}
            {selected && (isAdmin || isOwner) && (
              <div className="rounded border border-border p-3">
                <div className="text-xs font-medium text-fg-muted">러너 실행</div>
                <div className="mt-2 flex flex-col gap-1 break-all font-mono text-[11px] text-fg">
                  <span ref={templateCommandRef} className="whitespace-pre-wrap">
                    {runnerCommandClipboardText(PAT_PLACEHOLDER)}
                  </span>
                  <button
                    className="self-start shrink-0 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-fg hover:bg-surface-sunken"
                    aria-label="명령 복사"
                    onClick={async () => {
                      // 틀은 자리표시까지 통째로 복사한다 — 사람이 그 자리만 토큰으로 바꿔 쓴다.
                      const cmd = runnerCommandClipboardText(PAT_PLACEHOLDER);
                      setError(null);
                      const ok = await copyToClipboard(cmd, templateCommandRef.current, setError);
                      if (ok) {
                        setCopySuccess('template');
                        setTimeout(() => setCopySuccess((s) => s === 'template' ? null : s), 2000);
                      }
                    }}
                  >
                    {copySuccess === 'template' ? '복사됨' : '복사'}
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-fg-subtle">
                  토큰은 발급 순간에만 보인다. 잃었으면 새로 발급한다.{' '}
                  <button
                    className="text-accent underline"
                    onClick={() => {
                      newPatLabelRef.current?.scrollIntoView({ block: 'center' });
                      newPatLabelRef.current?.focus();
                    }}
                  >
                    PAT 발급으로 이동
                  </button>
                </p>
              </div>
            )}
          </div>

          {/*
            **저장은 한 쌍이다**(문서 원칙 05). 전에는 저장 버튼이 카드 안 회색 하나와 화면
            아래 파란 하나로 갈려 있었다 — 어느 것이 무엇을 저장하는지 알 수 없었다.
            회색 쪽(워크스페이스 기본값)은 Task 16 이 다른 화면으로 뺐고, 여기 남은 하나에
            **되돌리기**를 짝지어 하단에만 둔다.
          */}
          <footer className="flex w-full max-w-2xl gap-2 border-t border-border px-5 py-3">
            <Button
              variant="primary"
              disabled={busy || draft === null}
              onClick={() => void submit()}
            >
              {selected ? 'Save changes' : 'Create agent'}
            </Button>
            {/* 되돌리기는 **고친 것이 있을 때만** 선다 — 누를 것이 없는 버튼을 그리지 않는다.
                고른 에이전트를 다시 고르면 서버 값으로 초안이 다시 채워진다(`pick`). */}
            {selected && dirty && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => pick(selected)}
              >
                되돌리기
              </Button>
            )}
          </footer>
        </div>
    </div>
  );
}

/**
 * 상세의 한 묶음(identity 문서 Task 15-3). 프로필 · 실행 · 권한 셋뿐이다.
 *
 * 전에는 아홉 필드가 한 줄로 흘러 **무엇이 무엇과 묶이는지** 알 수 없었다 — 문서가
 * "이 화면 위계 혼란"이라고 부른 것의 절반이 여기서 나온다(나머지 절반이 워크스페이스
 * 기본값이었고 그것은 Task 16 이 뺐다).
 */
function FieldGroup({ title, note, children }: {
  title: string; note: string; children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        <p className="text-[11px] text-fg-subtle">{note}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * 뒤처진 러너를 **한 번에** 새 번들로 갈아 띄우는 자리.
 *
 * ## 왜 이것이 필요한가
 *
 * 러너는 daemon 이 소유하고 앱의 수명을 넘어 산다(`#431`). 앱을 새로 설치해도 도는 러너는
 * 옛 번들 그대로이고, `RunnerLauncher.doStartOne` 은 장부에 살아 있는 러너를 보면
 * `adopted` 로 두고 새로 띄우지 않는다(중복 금지). 그래서 번들에 담긴 수정이 도는 러너에
 * 닿는 길은 **그 러너를 한 번 종료시키는 것** 하나뿐이고, 에이전트가 여럿이면 그것을
 * 하나씩 누르는 것이 곧 이 화면의 일이 된다.
 *
 * ## 개수를 이름에 넣는 이유
 *
 * "전체 재기동"만 적으면 몇 대가 끊길지 모르고 누른다. 그리고 이 조작은 진행 중인 턴을
 * 기다리므로(SIGTERM 은 graceful 이다) 되돌리기 어렵다 — 개수가 곧 영향 범위다.
 *
 * ## 0 이어도 버튼을 없애지 않는다
 *
 * 사라지면 "이 기능이 없다"로 읽힌다. 비활성 버튼 + 이유가 "전부 최신이다"라는 **사실**을
 * 말한다 — 없는 것과 할 일이 없는 것은 다르다(docs/design.md §4).
 */
function StaleRunnerBar({ agents, runnerStates, appVersion, onError }: {
  agents: AgentView[];
  runnerStates: Record<string, { status: string } | undefined>;
  appVersion: string | null;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // 러너가 **있다고 보는** 에이전트만 대상이다. `runnerStates` 는 이 앱의 실행기가 관리하는
  // (즉 소유한) 에이전트만 담으므로, 이 한 줄이 소유 판정도 겸한다 — 그래도 컨트롤러가
  // 같은 술어를 한 번 더 본다(`restartStaleRunners`).
  const live = new Set(
    agents
      .filter((a) => {
        const status = runnerStates[a.id]?.status;
        return status === 'running' || status === 'adopted';
      })
      .map((a) => a.id),
  );
  const { stale, unknown } = staleRunners({ agents, live, appVersion });

  return (
    <div className="mb-3 rounded border border-border p-3">
      <div className="flex items-center gap-2">
        <button
          data-testid="restart-stale-runners"
          disabled={stale.length === 0 || busy}
          className="rounded border border-border px-2 py-1 text-xs text-fg
                     hover:bg-surface-sunken disabled:opacity-50"
          onClick={() => {
            setBusy(true);
            void getController().restartStaleRunners()
              .catch((err: unknown) => onError(
                `재기동하지 못했다: ${err instanceof Error ? err.message : String(err)}`,
              ))
              .finally(() => setBusy(false));
          }}
        >
          뒤처진 러너 전체 재기동 ({stale.length})
        </button>
        {stale.length === 0 && (
          <span className="text-[11px] text-fg-subtle">
            {appVersion === null
              // 앱 버전을 못 얻었으면 비교 기준이 없다. "전부 최신이다"로 적으면 확인하지
              // 않은 것을 단정하는 셈이다.
              ? '앱 버전을 얻지 못해 뒤처짐을 판정할 수 없다.'
              : '도는 러너가 전부 이 번들이다.'}
          </span>
        )}
      </div>
      {/* **모르는 것을 뒤처졌다고 하지 않는다**(`runnerVersions.ts` 의 판정). 대신 그
          사실을 적어 사람이 개별 재기동으로 값을 채우게 한다 — 재기동 한 번이면
          `AGENT_VERSION` 이 심긴 러너가 뜨고 그 뒤로는 판정에 든다. */}
      {unknown.length > 0 && (
        <p className="mt-1 text-[11px] text-fg-subtle">
          버전을 모르는 러너 {unknown.length}대 — 뒤처졌는지 알 수 없어 대상에서 뺐다.
          한 번 재기동하면 그 뒤로는 버전이 보인다.
        </p>
      )}
      {/* 진행 중인 턴을 끊지 않는다는 사실이 **누르기 전에** 있어야 한다. 이 조작은
          예약이고, 실제 교체는 그 턴이 끝난 뒤다(실측 5분 넘는 턴도 있다). */}
      <p className="mt-1 text-[11px] text-fg-subtle">
        재기동은 <strong>진행 중인 턴을 끊지 않는다</strong> — 턴을 마친 뒤 새 번들로 다시 뜬다.
      </p>
    </div>
  );
}

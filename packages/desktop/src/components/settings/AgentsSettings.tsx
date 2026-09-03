import { useEffect, useRef, useState } from 'react';
import {
  AGENT_HARNESSES, RUNNABLE_HARNESSES,
  type AgentConfig, type AgentDefaults, type AgentView, type MentionPermission, type PatView,
} from '@murmur/shared';
import { getController } from '../../state/controller';
import { useAppStore } from '../../state/appStore';
import { RunnerStatusLine } from '../RunnerStatus';

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
 * "마지막 활동: N분 전"(#176). `null` 은 **'활동 없음'**이다 — '죽었다'가 아니다.
 * murmur 는 러너 프로세스를 보지 못하므로(docs/design.md §1 외부 접속형) 한 번도 턴을
 * 돌리지 않았다는 것과 죽었다는 것을 구분할 수단이 없고, 구분할 수 없는 것을 단정하면
 * 그것이 §4 가 금지하는 거짓 신호다. 오래된 값도 '멈췄다'가 아니다 — 아무도 부르지
 * 않았으면 활동이 없는 것이 정상이다.
 *
 * 절대 시각을 그대로 쓰지 않는 이유: 운영자가 알고 싶은 것은 "얼마나 됐나"이고, 그것을
 * 사람이 시계와 뺄셈으로 계산하게 만들 이유가 없다. 대신 title 로 절대 시각을 함께 준다.
 */
export function lastTurnLabel(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return '활동 없음';
  const ms = now - new Date(iso).getTime();
  // 미래 시각은 서버가 now() 로 찍으므로 정상적으로는 오지 않는다(러너가 보낸 값을 저장하지
  // 않는 이유가 그것이다). 그래도 시계 보정이나 왕복 지연으로 음수가 될 수 있어, "N분 후"
  // 같은 말을 만들지 않고 '방금'으로 뭉갠다.
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return '마지막 활동: 방금';
  if (mins < 60) return `마지막 활동: ${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `마지막 활동: ${hours}시간 전`;
  return `마지막 활동: ${Math.floor(hours / 24)}일 전`;
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
  // 초안이 null 인 것은 '무엇을 기본으로 둘지 아직 모른다'는 뜻이다 — 기본값을 못 읽었는데
  // 조용히 채워 넣으면 화면이 거짓을 말한다(docs/design.md 4절).
  const [draft, setDraft] = useState<Draft | null>(null);
  // #171: 기본값은 **세 상태**다 — null(아직 안 읽음) / 'error'(못 읽음) / 값.
  // 아래 PAT 로더가 실패를 `setPats([])` 로 삼켜 '없음'과 같은 화면을 만드는데, 그것을
  // 따라 하지 않는다. 실패는 사람에게 보인다.
  const [defaults, setDefaults] = useState<AgentDefaults | 'error' | null>(null);
  // 기본값 편집 절의 입력 상태. 빈 문자열은 '지우기'로 해석해 저장할 때 null 로 보낸다.
  const [defaultsForm, setDefaultsForm] = useState<{ harness: string; model: string; effort: string } | null>(null);
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
  // #299: 소유자 판정. 목록이 이미 필터되어 있어도 UI 에서 명시적으로 쓴다 — admin 전용
  // 필드(ownerAccountId, disabled, mentionPermission)와 일반 필드(PAT, memory)를 가린다.
  const [isOwner, setIsOwner] = useState(false);
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
  const isAdmin = useAppStore((s) => s.me?.isAdmin === true);
  const myId = useAppStore((s) => s.me?.id);
  // #250: 이 앱이 띄운 러너의 상태. 실행기가 스토어에 밀어 넣고 화면은 읽기만 한다.
  const runnerStates = useAppStore((s) => s.runnerStates);
  const [reissuing, setReissuing] = useState(false);
  const accounts = useAppStore((s) => s.accounts);
  // #176: 생존(presence)과 마지막 활동은 **다른 두 사실**이라 두 자리에서 온다 — presence 는
  // 소켓 이벤트로 살아 있는 목록이고(#124), 마지막 활동은 `AgentView.lastTurnAt` 이다.
  // `connected` 를 함께 보는 이유: 소켓이 끊겼으면 `online` 은 그냥 빈 배열이라, 그것을
  // '오프라인'으로 그리면 실제로는 잘 돌고 있는 러너를 전부 죽은 것으로 표시한다.
  const online = useAppStore((s) => s.online);
  const connected = useAppStore((s) => s.connected);
  const humanAccounts = Object.values(accounts).filter((a) => a.kind === 'human');

  const reload = () => {
    void getController().listAgents().then(setAgents).catch(() => setError('에이전트 목록을 받지 못했다'));
  };
  useEffect(reload, []);

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
        setDefaultsForm({ harness: d.harness, model: d.model ?? '', effort: d.effort ?? '' });
        // 처음 열린 화면은 '새 에이전트'다 — 그 초안을 지금 채운다. 이미 다른 에이전트를
        // 골랐다면 건드리지 않는다.
        setDraft((prev) => prev ?? emptyDraft(d));
        setCustomized((prev) => prev || d.model !== null || d.effort !== null);
      })
      .catch(() => setDefaults('error'));
  }, [isAdmin]);

  const loadPats = (agentId: string) => {
    if (!isAdmin && !isOwner) return;
    setPats(null);
    void getController().listPats(agentId).then(setPats).catch(() => setPats('error'));
  };

  const loadMemories = (agentId: string) => {
    if (!isAdmin && !isOwner) return;
    setMemories(null);
    void getController().agentMemory(agentId)
      .then(setMemories)
      .catch(() => setMemories('error'));
  };

  const pick = (a: AgentView) => {
    setSelected(a);
    setDraft(draftOf(a));
    setCustomized(a.model !== null || a.effort !== null);
    setPat(null);
    setPats(null);
    setRevoking(null);
    setError(null);
    setConfirmingSlug(null);
    setConfirmingDisable(false);
    // #299: 소유자 판정. isAdmin 이면 무조건 false(_ADMIN_ONLY_FIELDS 가 admin 전용).
    // isAdmin 이 아니면 ownerAccountId 가 자기 id 인지만 보면 된다 — 목록이 이미 필터되어
    // 있지만 UI 에서 명시적으로 판정하면 admin 전용 필드 가리기가 정확해진다.
    setIsOwner(!isAdmin && a.ownerAccountId === myId);
    loadPats(a.id);
    loadMemories(a.id);
  };

  const startNew = () => {
    setSelected(null);
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
  const configPatch = (d: Draft): Partial<AgentConfig> => ({
    instructions: d.instructions,
    harness: d.harness,
    model: customized && d.model ? d.model : null,
    effort: customized && d.effort ? d.effort : null,
    workingDir: d.workingDir || null,
    mentionPermission: d.mentionPermission,
    ownerAccountId: d.ownerAccountId,
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
   * 기본값을 저장한다. **이미 만들어진 에이전트는 하나도 바뀌지 않는다** — 이 값은
   * 다음에 만들 것의 서식이다. 지금 타이핑 중인 초안도 건드리지 않는다: 저장 시점에
   * 화면에 있던 값이 그대로 쓰이는 편이 예측 가능하고, 새 기본값은 다음에
   * '+ Create agent' 를 누를 때부터 쓰인다.
   */
  const saveDefaults = async () => {
    if (!defaultsForm) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await getController().updateAgentDefaults({
        harness: defaultsForm.harness,
        // 빈 문자열은 '지우기'다 — **명시적 null 로 보낸다.** undefined 로 보내면
        // JSON.stringify 가 그 키를 통째로 버려 '손대지 않음'이 되고, 지우려는 조작이
        // 조용히 무시된다.
        model: defaultsForm.model || null,
        effort: defaultsForm.effort || null,
      });
      setDefaults(saved);
      setDefaultsForm({ harness: saved.harness, model: saved.model ?? '', effort: saved.effort ?? '' });
    } catch {
      setError('기본값을 저장하지 못했다');
    } finally { setBusy(false); }
  };

  /**
   * 러너에게 종료를 요청한다(#129). **재시작 버튼이 아니다** — murmur 는 러너를 띄우지
   * 않으므로 여기서 할 수 있는 것은 "지금 턴을 끝내고 물러나 달라"는 요청까지다.
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
      loadPats(selected.id);
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
      loadPats(selected.id);
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
      loadPats(selected.id);
    } catch (e) {
      // 서버가 왜 거절했는지 그대로 보여야 한다 — 특히 '이 라벨은 이미 쓰인다'(409)는
      // 사용자가 라벨만 바꾸면 해결되는 것이라, 뭉개면 막힌 것처럼 보인다.
      setError(e instanceof Error ? e.message : 'PAT 를 새로 발급하지 못했다');
    } finally { setBusy(false); }
  };

  const field = 'w-full rounded border border-zinc-300 px-3 py-2';
  const label = 'block text-xs font-medium text-zinc-600';

  return (
    <div className="flex h-full min-h-0 bg-white">
        <aside className="w-56 shrink-0 border-r border-zinc-200 p-3">
          <button
            className="mb-3 w-full rounded bg-zinc-900 px-3 py-2 text-left text-white"
            onClick={startNew}
          >
            + Create agent
          </button>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Agents</div>
          {agents.length === 0 && <div className="px-1 py-2 text-zinc-400">아직 없다</div>}
{agents.map((a) => {
              const owner = a.ownerAccountId ? accounts[a.ownerAccountId]?.handle : null;
              return (
                <button
                  key={a.id}
                  className={`w-full rounded px-2 py-1.5 text-left ${selected?.id === a.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}
                  onClick={() => pick(a)}
                >
                  {a.handle}
                  <span className="ml-1 text-[10px] text-zinc-400">{a.harness}</span>
                  {/* 세 경우다: 소유자가 없다 / 있고 디렉터리에 있다 / 있는데 디렉터리에
                      없다. 마지막을 빈 칸으로 그리면 "없다"와 구분되지 않는다 —
                      docs/design.md 4절이 금지하는 형태의 거울상이다. */}
                  <span className={`ml-1 text-[10px] ${owner ? 'text-indigo-600' : 'text-zinc-400'}`}>
                    {a.ownerAccountId === null ? '없음' : (owner ?? '알 수 없는 계정')}
                  </span>
                  {/* #176: 생존과 마지막 활동을 **나란히** 그린다. 하나로 합치면 #124 가 닫은
                      결함(러너 없는 에이전트가 정상으로 보임)이 되살아난다 — 온라인인데
                      마지막 활동이 두 시간 전인 것은 정상이고(아무도 부르지 않았다), 그
                      반대(활동 기록은 있는데 지금 붙어 있지 않다)도 봐야 하는 사실이다.
                      색 점만 두지 않고 글자를 함께 두는 이유: 색은 스크린리더에 아무 말도
                      하지 않고, 두 사실 중 하나가 사라졌는지 테스트도 볼 수 없다. */}
                  <span className="mt-0.5 block text-[10px]">
                    <span
                      data-testid={`agent-presence-${a.id}`}
                      data-online={connected ? String(online.includes(a.id)) : 'unknown'}
                      className={connected
                        ? (online.includes(a.id) ? 'text-green-600' : 'text-zinc-400')
                        : 'text-zinc-400'}
                    >
                      {connected ? (online.includes(a.id) ? '온라인' : '오프라인') : '연결 끊김 — 알 수 없음'}
                    </span>
                    <span
                      data-testid={`agent-last-turn-${a.id}`}
                      title={a.lastTurnAt ? new Date(a.lastTurnAt).toLocaleString() : undefined}
                      className="ml-1 text-zinc-500"
                    >
                      {lastTurnLabel(a.lastTurnAt)}
                    </span>
                  </span>
                </button>
              );
            })}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center border-b border-zinc-200 px-5 py-3">
            <h2 className="text-base font-bold">{selected ? `Edit ${selected.handle}` : 'Add agent'}</h2>
          </header>

          <div className="w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-5">
            {/* #171: 새 에이전트의 기본값. 여기서 정한 값은 **다음에 만들 에이전트**에
                복사된다 — 이미 있는 에이전트는 하나도 바뀌지 않는다. 참조가 아니라 복사인
                이유: harness 는 러너가 매 턴 읽어 프로세스를 띄우는 값이라, 참조로 두면
                기본값을 고치는 순간 돌고 있는 에이전트의 하네스가 중간에 바뀐다.
                그래서 좌측 목록에 '기본값을 물려받았다' 같은 표시도 두지 않는다 —
                만들어진 뒤에는 더 이상 참이 아니어서 거짓말이 된다. */}
            {isAdmin && !selected && (
              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">새 에이전트 기본값</div>
                {defaults === null && (
                  <div className="mt-1 text-[11px] text-zinc-400">불러오는 중…</div>
                )}
                {defaults === 'error' && (
                  <div role="alert" className="mt-1 text-[11px] text-red-600">
                    기본값을 불러오지 못했다
                  </div>
                )}
                {defaultsForm && defaults !== 'error' && (
                  <div className="mt-2 space-y-2">
                    <label className={label}>
                      기본 harness
                      <select
                        className={field}
                        aria-label="기본 harness"
                        value={defaultsForm.harness}
                        onChange={(e) => setDefaultsForm({ ...defaultsForm, harness: e.target.value })}
                      >
                        {RUNNABLE_HARNESSES.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className={label}>
                        기본 model
                        <input
                          className={field}
                          aria-label="기본 model"
                          placeholder="harness 기본값"
                          value={defaultsForm.model}
                          onChange={(e) => setDefaultsForm({ ...defaultsForm, model: e.target.value })}
                        />
                      </label>
                      <label className={label}>
                        기본 effort
                        <select
                          className={field}
                          aria-label="기본 effort"
                          value={defaultsForm.effort}
                          onChange={(e) => setDefaultsForm({ ...defaultsForm, effort: e.target.value })}
                        >
                          <option value="">harness 기본값</option>
                          {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
                        </select>
                      </label>
                    </div>
                    <button
                      className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void saveDefaults()}
                    >
                      기본값 저장
                    </button>
                    <p className="text-[11px] text-zinc-400">
                      다음에 만드는 에이전트에만 적용된다. 이미 있는 에이전트는 바뀌지 않는다.
                    </p>
                  </div>
                )}
              </div>
            )}

            {draft === null ? (
              <div className="rounded border border-zinc-200 p-3 text-xs text-zinc-500">
                {defaults === 'error'
                  ? '기본값을 몰라 새 에이전트 초안을 만들 수 없다'
                  : (isAdmin ? '기본값을 불러오는 중…' : '에이전트를 만들 수 있는 것은 admin 뿐이다')}
              </div>
            ) : (
            <>
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
              {!selected && <span className="text-[11px] text-zinc-500">채널에서 @이름 으로 부른다. 나중에 바꿀 수 없다.</span>}
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

            <div>
              <div className={label}>AI configuration</div>
              <div className="mt-1 flex gap-1">
                <button
                  className={`flex-1 rounded px-3 py-2 ${customized ? 'bg-zinc-100 text-zinc-600' : 'bg-white shadow ring-1 ring-zinc-300'}`}
                  onClick={() => setCustomized(false)}
                >
                  Use harness defaults
                </button>
                <button
                  className={`flex-1 rounded px-3 py-2 ${customized ? 'bg-white shadow ring-1 ring-zinc-300' : 'bg-zinc-100 text-zinc-600'}`}
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
              <span className="text-[11px] text-zinc-500">
                사람이 터미널로 직접 조종할 때는 이 설정과 무관하게 하네스가 물어본다.
              </span>
            </label>

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
                <span className="text-[11px] text-zinc-500">
                  소유자만 이 에이전트에 attach 할 수 있다.
                </span>
              </label>
            )}

            {!isAdmin && selected && (
              <div className="rounded border border-zinc-100 bg-zinc-50 p-3">
                <div className="text-xs text-zinc-500">
                  {draft.ownerAccountId
                    ? `소유자: @${accounts[draft.ownerAccountId]?.handle ?? '?'}`
                    : '소유자: 없음 — attach 불가'}
                </div>
              </div>
            )}

            </>
            )}

            {selected && (isAdmin || isOwner) && (
              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">기억 (memory)</div>
                {/* 읽기·삭제만이다. 편집을 넣지 않는 이유(#139): 사람이 고쳐도 에이전트가
                    다음 턴에 덮어쓰면 **사람은 자기 수정이 왜 사라졌는지 알 수 없다.** */}
                <div className="mt-2 space-y-2">
                  {memories === null && <div className="text-[11px] text-zinc-400">불러오는 중…</div>}
                  {memories === 'error' && (
                    <div role="alert" className="text-[11px] text-red-600">기억을 불러오지 못했다</div>
                  )}
                  {Array.isArray(memories) && memories.length === 0 && (
                    <div className="text-[11px] text-zinc-400">기억이 없다</div>
                  )}
                  {Array.isArray(memories) && memories.map((m) => (
                    <div key={m.slug} className="rounded bg-zinc-50 px-2 py-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">{m.slug}</span>
                        {confirmingSlug === m.slug ? (
                          <span className="flex gap-1">
                            {/* 되돌릴 수 없으니 한 번 더 묻는다 — MessageItem 의 삭제 확인과 같은 규칙. */}
                            <button
                              className="rounded border border-red-300 bg-red-50 px-1.5 text-[11px] text-red-700"
                              onClick={() => {
                                setConfirmingSlug(null);
                                void getController().deleteAgentMemory(selected.id, m.slug)
                                  .then(() => loadMemories(selected.id))
                                  .catch(() => setError('기억을 지우지 못했다'));
                              }}
                            >
                              정말 지운다
                            </button>
                            <button
                              className="rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600"
                              onClick={() => setConfirmingSlug(null)}
                            >
                              두기
                            </button>
                          </span>
                        ) : (
                          <button
                            className="rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600"
                            aria-label={`${m.slug} 기억 지우기`}
                            onClick={() => setConfirmingSlug(m.slug)}
                          >
                            지우기
                          </button>
                        )}
                      </div>
                      {/* 값은 최대 8000자다 — 설정 화면이 그것 때문에 무한히 길어지면 안 된다. */}
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-600">
                        {m.value}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* #251: 에이전트 비활성화/활성화. 관리 행위이므로 admin 만 보인다. */}
            {selected && isAdmin && (
              <div className={`rounded border p-3 ${selected.disabled ? 'border-zinc-200 bg-zinc-50' : 'border-red-200 bg-red-50'}`}>
                <div className="text-xs font-medium text-zinc-600">
                  {selected.disabled ? '비활성화된 에이전트' : '에이전트 활성화'}
                </div>
                {selected.disabled ? (
                  <div className="mt-2">
                    <p className="text-[11px] text-zinc-500 mb-2">
                      이 에이전트는 비활성화되어 있습니다. 다시 활성화하면 PAT 가 없다(재발급 필요)고
                      안내가 뜹니다 — 비활성화 시 모든 PAT 가 폐기되었기 때문입니다.
                    </p>
                    <button
                      className="rounded border border-indigo-300 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
                      aria-label="에이전트 활성화"
                      disabled={busy}
                      onClick={() => void toggleDisabled()}
                    >
                      활성화
                    </button>
                  </div>
                ) : confirmingDisable ? (
                  <div className="mt-2">
                    <p className="text-[11px] text-red-700 mb-2">
                      <strong>이 에이전트의 모든 PAT 가 폐기</strong>되어 러너가 멈춥니다.
                      다시 활성화해도 PAT 는 돌아오지 않으며, <strong>새로 발급</strong>해야 합니다.
                    </p>
                    <div className="flex gap-1">
                      <button
                        className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                        aria-label="정말 비활성화"
                        disabled={busy}
                        onClick={() => void toggleDisabled()}
                      >
                        정말 비활성화
                      </button>
                      <button
                        className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                        onClick={() => setConfirmingDisable(false)}
                      >
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2">
                    <p className="text-[11px] text-zinc-500 mb-2">
                      에이전트를 비활성화하면 <strong>모든 PAT 가 폐기</strong>되고, 다시 활성화해도
                      PAT 는 복구되지 않아 <strong>새로 발급</strong>해야 합니다.
                    </p>
                    <button
                      className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
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
              <div className="rounded border border-zinc-200 p-3">
                {/* #129: "재시작"이라고 쓰지 않는다. murmur 는 러너를 띄우지 않으므로
                    재시작은 murmur 가 할 수 있는 일이 아니고, 할 수 없는 일을 버튼 이름으로
                    약속하면 그것이 곧 거짓 신호다(docs/design.md 4절). */}
                <div className="text-xs font-medium text-zinc-600">러너 종료 요청</div>
                <p className="mt-1 text-[11px] text-zinc-500">
                  러너에게 <strong>진행 중인 턴을 마친 뒤 스스로 종료</strong>해 달라고 요청한다.
                  턴 중간에 끊지 않는다 — 사람이 기다리는 답을 잃지 않기 위해서다.
                  murmur 는 러너를 띄우지 않으므로 <strong>다시 띄우는 것은 사람</strong>(또는
                  그 머신의 launchd/systemd 감독)의 몫이다. 감독이 없으면 이 요청은 정지로 끝난다.
                </p>
                {/* 세 상태를 구분해 그린다: 요청 없음 / 요청했으나 러너가 아직 못 봄 /
                    러너가 읽어 감. **'멈췄다'고 쓰지 않는다** — 러너가 종료하면 다음
                    GET /agent/config 자체가 오지 않아, murmur 는 프로세스의 생사를 모른다. */}
                <div className="mt-2 text-[11px]" role="status">
                  {!selected.stopRequestedAt && (
                    <span className="text-zinc-400">종료를 요청한 적이 없다</span>
                  )}
                  {selected.stopRequestedAt && !selected.stopAckedAt && (
                    <span className="text-amber-700">
                      종료 요청함 ({new Date(selected.stopRequestedAt).toLocaleString()}) —
                      러너가 아직 읽어 가지 않았다. 러너가 붙어 있지 않으면 읽어 갈 사람도 없다.
                    </span>
                  )}
                  {selected.stopRequestedAt && selected.stopAckedAt && (
                    <span className="text-zinc-600">
                      러너가 요청을 읽어 갔다 (요청 {new Date(selected.stopRequestedAt).toLocaleString()}
                      {' '}· 수령 {new Date(selected.stopAckedAt).toLocaleString()}).
                      진행 중이던 턴을 마치고 종료한다 — 실제로 종료했는지는 murmur 가 알 수 없다.
                    </span>
                  )}
                </div>
                <button
                  className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  aria-label="러너 종료 요청"
                  disabled={busy}
                  onClick={() => void requestStop()}
                >
                  종료 요청
                </button>
              </div>
            )}

            {selected && (isAdmin || isOwner) && (
              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">PAT (Personal Access Token)</div>
                <div className="mt-2 space-y-2">
                  {pats === null ? (
                    <div className="text-[11px] text-zinc-400">PAT 를 읽고 있다…</div>
                  ) : pats === 'error' ? (
                    // 실패를 '없음'으로 그리면 살아 있는 PAT 를 없다고 하고, 그 위에서
                    // "새로 발급해야 한다"까지 말하게 된다(docs/design.md 4절).
                    <div className="text-[11px] text-red-600" role="alert">PAT 목록을 읽지 못했다</div>
                  ) : pats.length === 0 ? (
                    /* #251: 켜진 에이전트에 PAT 가 0개면 러너가 뜰 수 없다 — 비활성화가
                       PAT 를 전부 폐기하고 다시 켜도 되살리지 않으므로(서버가 해시만
                       보관한다), 재발급이 필요하다는 것을 이 자리에서 말한다. 꺼진
                       에이전트에서는 0개가 정상 상태라 권하지 않는다. */
                    <div className={`text-[11px] ${selected.disabled ? 'text-zinc-400' : 'text-amber-600'}`}>
                      {selected.disabled
                        ? 'PAT 가 없다'
                        : 'PAT 가 없다 — 새로 발급해야 한다(비활성화 시 전부 폐기됨)'}
                    </div>
                  ) : (
                    pats.map((p) => (
                      <div key={`${p.label}:${p.createdAt}`} className="flex items-center justify-between rounded bg-zinc-50 px-2 py-1.5">
                        <div className="text-xs">
                          <span className="font-medium">{p.label}</span>
                          {p.revokedAt && (
                            <span className="ml-2 text-red-600">(폐기됨)</span>
                          )}
                          <span className="ml-2 text-zinc-400">
                            {new Date(p.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        {!p.revokedAt && (
                          revoking === p.label ? (
                            <div className="flex items-center gap-1">
                              <button
                                className="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700"
                                onClick={() => void revokePat(p.label)}
                              >
                               Really revoke
                              </button>
                              <button
                                className="px-1.5 py-0.5 text-[11px] text-zinc-500"
                                onClick={() => setRevoking(null)}
                              >
                               Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              className="text-[11px] text-red-600 hover:underline"
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
                    className="w-40 rounded border border-zinc-300 px-2 py-1 text-xs"
                    aria-label="New PAT label"
                    placeholder="runner"
                    value={newPatLabel}
                    onChange={(e) => setNewPatLabel(e.target.value)}
                  />
                  <button
                    className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
                    disabled={busy || newPatLabel.trim() === ''}
                    onClick={() => void mintNewPat()}
                  >
                    + New PAT
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-zinc-400">
                  라벨은 살아 있는 토큰 안에서 유일합니다. 폐기하면 같은 라벨을 다시 쓸 수 있습니다.
                </p>
              </div>
            )}

            {/* #176: 목록 조회가 실패하면 마지막 활동도 presence 도 알 수 없다 — 그때 빈 화면을
                그리면 '에이전트가 없다'와 '못 읽었다'가 같아진다. 위 PAT 로더가 실패를
                `setPats([])` 로 삼키는데, 그것을 따라 하지 않는다. role 을 주는 이유: 색만으로
                는 스크린리더에 아무 말도 하지 않는다. */}
            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}

            {pat && (
              // 서버가 해시만 보관하므로 지금 놓치면 다시 볼 수 없다.
              <div className="rounded border border-amber-300 bg-amber-50 p-3">
                <div className="text-xs font-semibold text-amber-900">
                  이 토큰은 지금만 보인다 — 서버가 해시만 보관하므로 다시 볼 수 없다
                </div>
                <code className="mt-1 block break-all rounded bg-white p-2 text-[11px]">{pat}</code>
                {/* #125: 이 명령의 토큰을 자르고 말줄임표를 붙여 두면, 그대로 복사해 실행했을 때
                    인증이 실패한다 — "완성된 명령"처럼 보이는데 아니었다. 전체 토큰을 싣는다.
                    바로 위 코드 블록에 이미 전체 토큰이 있으므로 중복 노출이 새 위험은 아니다. */}
                <div className="mt-2 flex items-center gap-2 break-all font-mono text-[11px] text-amber-900">
                  <span ref={fullCommandRef}>MURMUR_PAT={pat} pnpm --filter @murmur/agent start</span>
                  <button
                    className="shrink-0 rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900 hover:bg-amber-200"
                    aria-label="명령 복사"
                    onClick={async () => {
                      // #125: 토큰을 자르거나 말줄임표를 붙이지 않는다 — 클립보드에도 명령 전체가 들어간다.
                      const cmd = `MURMUR_PAT=${pat} pnpm --filter @murmur/agent start`;
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
                <p className="mt-2 text-[11px] text-amber-900">
                  murmur <strong>서버</strong>는 러너를 띄우지 않는다. 이 데스크탑 앱은
                  <strong> 내가 소유한</strong> 에이전트만 띄운다 — 남이 소유했거나 소유자가
                  없는 에이전트는 <strong>위 명령을 직접 실행해 러너를 붙이기 전까지 멘션에
                  답하지 않는다</strong>(멘션은 쌓이기만 한다). murmur 저장소를 체크아웃한
                  머신에서 실행한다.
                </p>
              </div>
            )}

            {/* #250: 이 앱이 띄운 러너의 상태와 회전 버튼. **소유자에게도 보인다** —
                실행기의 대상 판정이 `ownerAccountId === 내 id` 이므로, admin 에게만 보이면
                자기 러너를 띄운 소유자가 그 상태를 볼 수도 재발급할 수도 없다.

                이 절은 위 "러너 실행" 명령 틀(#177)과 **둘 다** 남는다: 앱이 띄우는 것은
                내가 소유한 에이전트뿐이고, 남의 머신에서 손으로 띄우는 길은 그대로 있다.
                그렇게 뜬 러너는 여기서 '외부에서 실행 중'으로 보인다. */}
            {selected && (isAdmin || (myId !== undefined && selected.ownerAccountId === myId)) && (
              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">러너 (이 앱)</div>
                <p className="mt-1 text-[11px] text-zinc-500">
                  이 앱은 <strong>내가 소유한</strong> 에이전트의 러너를 띄운다. 러너가 이미
                  붙어 있으면(누가 띄웠든) 띄우지 않고 '외부에서 실행 중'으로 표시한다 —
                  같은 에이전트에 러너가 둘이면 멘션을 두 러너가 나눠 집어 간다.
                </p>
                <div className="mt-2">
                  <RunnerStatusLine state={runnerStates[selected.id]} />
                </div>
                {/* 재발급은 순서가 요점이다: 새 발급 → 옛 폐기 → 재실행. 폐기가 먼저면
                    발급 실패 한 번에 쓸 수 있는 PAT 가 사라진다(runnerLauncher.ts 주석). */}
                <button
                  className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
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
                <p className="mt-1 text-[11px] text-zinc-500">
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
                하는가"를 알아야 하고, 틀에는 비밀이 없다. */}
            {selected && (isAdmin || isOwner) && (
              <div className="rounded border border-zinc-200 p-3">
                <div className="text-xs font-medium text-zinc-600">러너 실행</div>
                <div className="mt-2 flex items-center gap-2 break-all font-mono text-[11px] text-zinc-700">
                  <span ref={templateCommandRef}>MURMUR_PAT=&lt;발급한 토큰&gt; pnpm --filter @murmur/agent start</span>
                  <button
                    className="shrink-0 rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-700 hover:bg-zinc-100"
                    aria-label="명령 복사"
                    onClick={async () => {
                      // 틀은 자리표시까지 통째로 복사한다 — 사람이 그 자리만 토큰으로 바꿔 쓴다.
                      const cmd = 'MURMUR_PAT=<발급한 토큰> pnpm --filter @murmur/agent start';
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
                <p className="mt-2 text-[11px] text-zinc-500">
                  토큰은 발급 순간에만 보인다. 잃었으면 새로 발급한다.{' '}
                  <button
                    className="text-indigo-600 underline"
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

          <footer className="w-full max-w-2xl border-t border-zinc-200 px-5 py-3">
            <button
              className="w-full rounded bg-indigo-600 py-2 font-medium text-white disabled:opacity-50"
              disabled={busy || draft === null}
              onClick={() => void submit()}
            >
              {selected ? 'Save changes' : 'Create agent'}
            </button>
          </footer>
        </div>
    </div>
  );
}

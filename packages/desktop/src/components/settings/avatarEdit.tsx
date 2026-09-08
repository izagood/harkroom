import { useCallback, useEffect, useRef, useState } from 'react';
import { avatarErrorMessage } from '../../lib/avatar';

/**
 * 사진 바꾸기의 **상태 하나**다(#159 · Task 15-4 후속).
 *
 * 전에는 `busy` 불리언뿐이었다. 그래서 사진을 고른 뒤 화면에 생기는 변화가 **버튼이
 * 흐려지는 것 하나**였고, 큰 파일에서는 그것마저 눈에 안 띄어 사람이 "안 먹었다"로
 * 읽었다(실제로는 가는 중이었다). 반대편도 같았다 — 지우기는 확인 한 번 없이 즉시
 * 지우고, 지운 뒤에도 아무 말이 없어 눌린 것인지 알 수 없었다.
 *
 * 그래서 단계를 이름으로 가진다. 화면은 이 이름을 그리기만 하고 스스로 판단하지 않는다.
 */
export type AvatarPhase =
  | { kind: 'idle' }
  /** 바이트가 가는 중. `fraction` 은 0~1 — 서버가 total 을 안 주면 `null` 이다. */
  | { kind: 'uploading'; fraction: number | null }
  /** 바이트는 다 갔고 계정에 잇는 중이다(PUT). 여기서 막대는 꽉 찬 상태로 기다린다. */
  | { kind: 'applying' }
  | { kind: 'removing' }
  | { kind: 'done'; removed: boolean }
  | { kind: 'error'; message: string };

/** 끝난 말이 남는 시간. 짧으면 못 보고, 길면 다음 조작 옆에 낡은 말이 붙어 있다. */
const DONE_MS = 3000;

export type AvatarEdit = {
  phase: AvatarPhase;
  /** 조작 중인가 — 버튼을 잠그는 자리. */
  busy: boolean;
  /** 지우기 확인을 묻는 중인가. */
  confirmingRemove: boolean;
  pickRef: React.RefObject<HTMLInputElement | null>;
  openPicker(): void;
  onPicked(e: React.ChangeEvent<HTMLInputElement>): void;
  askRemove(): void;
  cancelRemove(): void;
  confirmRemove(): void;
};

/**
 * `apply` 는 이 화면이 아는 쓰기 경로다(사람은 `setAvatar`, 에이전트는 `setAgentAvatar`).
 * 두 화면이 같은 단계를 각자 세면 한쪽만 고치는 날이 오므로 상태는 여기 한 벌만 둔다.
 *
 * 실패 문장은 **받지 않는다** — `lib/avatar.ts` 의 `avatarErrorMessage` 하나가 원인별로
 * 낸다. 화면마다 문장을 넘기던 동안은 무엇이 실패했든 "이미지 파일만 쓸 수 있습니다" 였고,
 * 서버가 죽어 있어도 사람이 자기 파일을 의심했다. 받아 주는 형식이 늘 때 고칠 자리도 하나다.
 */
export function useAvatarEdit(
  apply: (file: File | null, onProgress?: (fraction: number) => void) => Promise<void>,
): AvatarEdit {
  const [phase, setPhase] = useState<AvatarPhase>({ kind: 'idle' });
  const pickRef = useRef<HTMLInputElement | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  /** 끝난 말을 내리는 타이머. 언마운트 후에 setState 하면 경고가 난다. */
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => () => {
    alive.current = false;
    if (clearTimer.current) clearTimeout(clearTimer.current);
  }, []);

  const settle = useCallback((next: AvatarPhase) => {
    if (!alive.current) return;
    setPhase(next);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    // 오류는 스스로 내려가지 않는다 — 읽히지 않은 실패는 없던 일이 된다.
    if (next.kind !== 'done') return;
    clearTimer.current = setTimeout(() => {
      if (alive.current) setPhase({ kind: 'idle' });
    }, DONE_MS);
  }, []);

  const run = useCallback(async (file: File | null) => {
    setConfirmingRemove(false);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setPhase(file ? { kind: 'uploading', fraction: null } : { kind: 'removing' });
    try {
      await apply(file, file
        ? (fraction) => {
          if (!alive.current) return;
          // 1 에 닿으면 **막대를 멈추고 문구를 바꾼다** — 바이트는 갔고 서버가 저장하는
          // 중이다. 100% 인데 아직 안 끝난 상태를 말로 설명하지 않으면 멈춘 것으로 보인다.
          setPhase(fraction >= 1 ? { kind: 'applying' } : { kind: 'uploading', fraction });
        }
        : undefined);
      settle({ kind: 'done', removed: file === null });
    } catch (e) {
      // 원인을 그대로 문장으로 옮긴다 — 확장자를 믿지 않는 서버 거절(`not_an_image`)과
      // 네트워크 끊김은 사람이 해야 할 다음 행동이 다르다.
      settle({ kind: 'error', message: avatarErrorMessage(e) });
    } finally {
      // 같은 파일을 다시 고를 수 있게 비운다 — 안 비우면 change 가 안 난다.
      if (pickRef.current) pickRef.current.value = '';
    }
  }, [apply, settle]);

  const busy = phase.kind === 'uploading' || phase.kind === 'applying' || phase.kind === 'removing';

  return {
    phase,
    busy,
    confirmingRemove,
    pickRef,
    openPicker: () => pickRef.current?.click(),
    onPicked: (e) => { const f = e.target.files?.[0]; if (f) void run(f); },
    askRemove: () => setConfirmingRemove(true),
    cancelRemove: () => setConfirmingRemove(false),
    confirmRemove: () => { void run(null); },
  };
}

/**
 * 단계를 **한 줄로** 그린다. 막대는 진행 중일 때만 있고, 끝나면 문장 하나만 남는다 —
 * 다 찬 막대를 남겨 두면 다음 조작 옆에서 "지금 올리는 중"으로 읽힌다.
 *
 * 눈에 보이게 낸다. `sr-only` 로만 두면 스크린리더가 아닌 사람에게는 **아무 일도 일어나지
 * 않은 것**과 구분되지 않는다 — 그것이 이 고침의 출발점이었다.
 */
export function AvatarStatus({ phase }: { phase: AvatarPhase }) {
  if (phase.kind === 'idle') return null;

  if (phase.kind === 'error') {
    return <p role="alert" data-testid="avatar-error" className="mt-1 text-meta text-danger">{phase.message}</p>;
  }

  if (phase.kind === 'done') {
    return (
      <p
        role="status"
        data-testid="avatar-done"
        className="mt-1 text-meta text-fg-muted"
      >
        {phase.removed ? '사진을 지웠습니다' : '사진을 바꿨습니다'}
      </p>
    );
  }

  // 지우기는 올릴 바이트가 없다 — 막대 대신 말만 둔다. 있지도 않은 진행을 그리지 않는다.
  if (phase.kind === 'removing') {
    return <p role="status" data-testid="avatar-removing" className="mt-1 text-meta text-fg-muted">사진을 지우는 중…</p>;
  }

  const pct = phase.kind === 'applying' ? 100 : Math.round((phase.fraction ?? 0) * 100);
  /** total 을 모르면 비율을 못 쓴다 — 그때는 막대를 채우지 않고 문구로만 알린다. */
  const unknown = phase.kind === 'uploading' && phase.fraction === null;

  return (
    <div className="mt-1 flex items-center gap-2" data-testid="avatar-uploading">
      <div
        role="progressbar"
        data-testid="avatar-progress"
        aria-label="사진 업로드 진행"
        aria-valuemin={0}
        aria-valuemax={100}
        // 비율을 모르는 구간에서는 valuenow 를 비운다(불확정) — 0 으로 두면 스크린리더가
        // "0%" 라고 읽고, 그건 모른다는 것과 다른 말이다.
        aria-valuenow={unknown ? undefined : pct}
        className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className={`h-full rounded-full bg-accent transition-[width] duration-150 ${unknown ? 'animate-pulse' : ''}`}
          style={{ width: unknown ? '15%' : `${pct}%` }}
        />
      </div>
      <span className="text-meta text-fg-muted">
        {phase.kind === 'applying' ? '프로필에 적용 중…'
          : unknown ? '사진 올리는 중…'
            : `사진 올리는 중… ${pct}%`}
      </span>
    </div>
  );
}

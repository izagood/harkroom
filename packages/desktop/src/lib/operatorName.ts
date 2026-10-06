import type { OperatorView } from '@harkroom/shared';

/**
 * 오퍼레이터를 사람에게 보일 이름 — 사람이 붙인 `label`, 없으면 등록 때의 호스트명(`name`).
 * 오퍼레이터 이름을 그리는 자리는 **모두 이것을 거친다**(설정 › Operators·배정 고르개·Runs on·
 * 이 기기·관문 터미널 문구). 한 자리라도 `name` 을 바로 읽으면 바꾼 이름이 거기서만 옛 이름으로 남는다.
 */
export function operatorDisplayName(op: Pick<OperatorView, 'name' | 'label'>): string {
  return op.label ?? op.name;
}

/** 찾지 못했을 수도 있는 오퍼레이터의 이름 — 없으면 `undefined`(부르는 쪽이 「알 수 없는 오퍼레이터」로 물러난다). */
export function operatorNameOf(op: Pick<OperatorView, 'name' | 'label'> | null | undefined): string | undefined {
  return op ? operatorDisplayName(op) : undefined;
}

/**
 * 고르개(배정 select)용 이름. 보이는 이름이 **겹칠 때만** 「— 호스트명」을 붙인다 — 원격 VM 한 대에
 * work·personal 둘을 올리면 이름이 같을 수 있고, 겹치지 않을 때까지 늘 붙이면 줄만 길어진다.
 */
export function operatorPickerLabels(ops: readonly Pick<OperatorView, 'id' | 'name' | 'label'>[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const o of ops) counts.set(operatorDisplayName(o), (counts.get(operatorDisplayName(o)) ?? 0) + 1);
  return new Map(ops.map((o) => {
    const shown = operatorDisplayName(o);
    return [o.id, (counts.get(shown) ?? 0) > 1 && shown !== o.name ? `${shown} — ${o.name}` : shown];
  }));
}

/** 이름 상한 — 서버(`PATCH /operators/:id`)와 등록 이름 상한이 같다. */
export const OPERATOR_LABEL_MAX = 64;

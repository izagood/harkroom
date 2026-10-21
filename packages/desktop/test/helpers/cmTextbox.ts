import { EditorView } from '@codemirror/view';

/**
 * 입력창 편집기(CodeMirror 6, `ComposerEditor`)를 **textarea 처럼 다루게** 하는 시험 어댑터.
 *
 * 입력창 시험들은 `getByRole('textbox')` 로 칸을 잡고 `fireEvent.change(box, { target: { value,
 * selectionStart } })` 로 글을 넣고 `box.value` 를 읽는다. 편집기가 textarea 에서 CM6 로 바뀌어도
 * 시험이 지키는 것(멘션·보내기·붙여넣기·보냄 취소)은 그대로라, 시험 25개를 고치는 대신 여기 한
 * 곳에서 CM6 의 글 칸(`.cm-content`)에 textarea 의 `value`·`selectionStart`·`selectionEnd`·
 * `setSelectionRange` 를 붙인다. 값을 넣으면 편집기에 트랜잭션으로 들어가 제품과 같은 길
 * (`updateListener` → `onChange`/`onSelect`)로 `Composer` 에 닿는다.
 *
 * `.cm-content` 가 아닌 div 에는 아무 일도 하지 않는다(평범한 속성처럼 저장만 한다).
 */
const plain = new WeakMap<HTMLElement, Record<string, unknown>>();
/**
 * `fireEvent.change(box, { target: { value, selectionStart } })` 는 값을 **act 밖에서** 먼저 넣고
 * 이벤트만 act 안에서 쏜다. 넣는 순간 편집기에 보내면 `Composer` 의 상태 갱신이 act 밖에서 일어나
 * 그려지지 않는다. 그래서 값은 여기 맡겨 두고, 이벤트(`change`·`input`)가 올 때 편집기에 넣는다 —
 * textarea 의 onChange 가 불리던 바로 그 자리다.
 */
const staged = new WeakMap<HTMLElement, { value?: string; start?: number; end?: number }>();
const viewOf = (el: HTMLElement): EditorView | null =>
  el.classList?.contains('cm-content') ? EditorView.findFromDOM(el) : null;

function prop(name: 'value' | 'selectionStart' | 'selectionEnd', get: (v: EditorView) => unknown) {
  Object.defineProperty(HTMLDivElement.prototype, name, {
    configurable: true,
    get(this: HTMLElement) {
      const v = viewOf(this);
      if (!v) return plain.get(this)?.[name];
      const s = staged.get(this);
      const key = name === 'value' ? 'value' : name === 'selectionStart' ? 'start' : 'end';
      return s?.[key] ?? get(v);
    },
    set(this: HTMLElement, value: never) {
      if (viewOf(this)) {
        const s = staged.get(this) ?? {};
        if (name === 'value') s.value = value; else if (name === 'selectionStart') s.start = value; else s.end = value;
        staged.set(this, s);
        return;
      }
      const bag = plain.get(this) ?? {};
      bag[name] = value;
      plain.set(this, bag);
    },
  });
}

function flush(e: Event) {
  const el = e.target as HTMLElement;
  const s = el instanceof HTMLElement ? staged.get(el) : undefined;
  const v = s && viewOf(el);
  if (!s || !v) return;
  staged.delete(el);
  const doc = s.value ?? v.state.doc.toString();
  const anchor = Math.min(s.start ?? doc.length, doc.length);
  const head = Math.min(s.end ?? Math.max(anchor, s.value === undefined ? v.state.selection.main.to : anchor), doc.length);
  v.dispatch({
    ...(s.value === undefined ? {} : { changes: { from: 0, to: v.state.doc.length, insert: doc } }),
    selection: { anchor, head },
  });
}

export function installCmTextbox(): void {
  // CM6 는 커서 자리를 재려고 Range 의 상자를 묻는다. jsdom 에는 배치가 없어 이 둘이 없다 — 빈 상자를 준다.
  const empty = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects ??= function getClientRects() {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect ??= function getBoundingClientRect() { return empty as DOMRect; };
  prop('value', (v) => v.state.doc.toString());
  prop('selectionStart', (v) => v.state.selection.main.from);
  prop('selectionEnd', (v) => v.state.selection.main.to);
  Object.defineProperty(HTMLDivElement.prototype, 'setSelectionRange', {
    configurable: true,
    value(this: HTMLElement, start: number, end: number) {
      viewOf(this)?.dispatch({ selection: { anchor: start, head: end } });
    },
  });
  // 붙잡기 단계에서 먼저 넣는다 — 같은 이벤트를 듣는 제품 처리기가 있으면 새 값을 보게.
  document.addEventListener('change', flush, true);
  document.addEventListener('input', flush, true);
}

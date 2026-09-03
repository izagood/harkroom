import { describe, it, expect } from 'vitest';
import { mentionedHandles, splitCode } from '@murmur/shared';

describe('코드 블록 제외(#298)', () => {
  describe('splitCode', () => {
    it('펜스 블록을 인식한다', () => {
      const segs = splitCode('앞\n```\n코드\n```\n뒤');
      expect(segs.length).toBe(3);
      expect(segs[0]!.kind).toBe('plain');
      expect(segs[1]!).toEqual({ kind: 'codeBlock', code: '코드', lang: null });
      expect(segs[2]!.kind).toBe('plain');
    });

    it('인라인 코드를 인식한다', () => {
      const segs = splitCode('이것은 `inline` 은 된다');
      expect(segs.length).toBe(3);
      expect(segs[0]!.kind).toBe('plain');
      expect(segs[1]!).toEqual({ kind: 'inlineCode', code: 'inline' });
      expect(segs[2]!.kind).toBe('plain');
    });

    it('닫히지 않은 펜스는 평문으로 둔다', () => {
      const segs = splitCode('```\n닫히지 않음');
      expect(segs.length).toBe(1);
      const first = segs[0]!;
      expect(first.kind).toBe('plain');
      expect((first as { text: string }).text).toContain('```');
    });
  });

  describe('mentionedHandles - 코드 블록 안 무시', () => {
    it('펜스 블록 안의 @handle 은 무시된다', () => {
      const handles = mentionedHandles('```\n@fizz\n```');
      expect(handles).toEqual([]);
    });

    it('인라인 코드 안의 @handle 도 무시된다', () => {
      const handles = mentionedHandles('이것은 `@fizz` 다');
      expect(handles).toEqual([]);
    });

    it('코드 밖의 @handle 은 정상 추출', () => {
      const handles = mentionedHandles('안녕하세요 @fizz 님');
      expect(handles).toEqual(['fizz']);
    });

    it('같은 메시지에 코드 안·밖이 있으면 밖만 추출', () => {
      const handles = mentionedHandles('@fizz\n```\n@fizz\n```\n@fizz');
      expect(handles).toEqual(['fizz']);
    });

    it('그룹 핸들이 코드 블록 안에 있으면 무시된다', () => {
      const handles = mentionedHandles('```\n@myteam\n```');
      expect(handles).toEqual([]);
    });

    it('중첩된 코드 블록', () => {
      const handles = mentionedHandles('```\n`@fizz`\n```');
      expect(handles).toEqual([]);
    });

    it('여러 코드 블록', () => {
      const handles = mentionedHandles('`@a` 이것은 ```\n@b\n``` 그리고 `@c`');
      expect(handles).toEqual([]);
    });
  });
});
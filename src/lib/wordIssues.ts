import type { DictationWord, WordIssue, WordIssueKind } from "../types";

export const wordIssueKinds: WordIssueKind[] = ["wording", "pronunciation"];

export const wordIssueLabels: Record<WordIssueKind, string> = {
  wording: "组词不合适",
  pronunciation: "读音不准",
};

// 组词可能沿用生字 ID，因此同时比较当时的题词、拼音和课次。
export const findWordIssue = (issues: WordIssue[], word: DictationWord) => issues.find((issue) =>
  issue.word.lessonId === word.lessonId && issue.word.text === word.text && issue.word.pinyin === word.pinyin,
);

export const toggleWordIssue = (
  issues: WordIssue[],
  word: DictationWord,
  lessonLabel: string,
  kind: WordIssueKind,
): WordIssue[] => {
  const existing = findWordIssue(issues, word);
  const previousKinds = existing && !existing.resolvedAt ? existing.kinds : [];
  const kinds = previousKinds.includes(kind) ? previousKinds.filter((item) => item !== kind) : [...previousKinds, kind];
  if (kinds.length === 0) return issues.filter((issue) => issue.id !== existing?.id);
  const next: WordIssue = {
    id: existing?.id ?? crypto.randomUUID(),
    word: { ...word, chars: [...word.chars] },
    lessonLabel,
    kinds,
    createdAt: existing && !existing.resolvedAt ? existing.createdAt : new Date().toISOString(),
  };
  return existing ? issues.map((issue) => issue.id === existing.id ? next : issue) : [next, ...issues];
};

export const normalizeWordIssues = (value: unknown): WordIssue[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue: WordIssue) => {
    const word = issue?.word;
    if (!issue || typeof issue.id !== "string" || !issue.id || !word
      || typeof word.id !== "string" || typeof word.text !== "string" || !word.text
      || typeof word.pinyin !== "string" || typeof word.lessonId !== "string"
      || typeof word.lessonTitle !== "string" || ![1, 2, 3, 4, 5].includes(word.grade)
      || (word.category !== "一类" && word.category !== "二类")
      || typeof issue.createdAt !== "string" || !Number.isFinite(Date.parse(issue.createdAt))) return [];
    const kinds = wordIssueKinds.filter((kind) => Array.isArray(issue.kinds) && issue.kinds.includes(kind));
    if (kinds.length === 0) return [];
    return [{
      id: issue.id,
      word: { ...word, chars: Array.isArray(word.chars) ? word.chars.filter((char) => typeof char === "string") : [] },
      lessonLabel: typeof issue.lessonLabel === "string" ? issue.lessonLabel : word.lessonTitle,
      kinds,
      createdAt: issue.createdAt,
      resolvedAt: typeof issue.resolvedAt === "string" && Number.isFinite(Date.parse(issue.resolvedAt)) ? issue.resolvedAt : undefined,
    }];
  });
};

export const exportWordIssues = (issues: WordIssue[]) => JSON.stringify({
  exportedAt: new Date().toISOString(),
  issues: issues.map((issue) => ({ ...issue, problems: issue.kinds.map((kind) => wordIssueLabels[kind]) })),
}, null, 2);

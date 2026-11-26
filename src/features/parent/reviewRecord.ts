import { hanChars, reviewCharsForWord } from "../../../shared/domain/characters.ts";
import type { ClassicalText, DictationWord, LessonSummary, ReviewLog } from "../../../shared/types.ts";
import { lessonLabel, shortBookLabel } from "../../lib/lessonPresentation";

interface ReviewRecordQuestion {
  word: Pick<DictationWord, "id" | "text" | "pinyin" | "textbookHint">;
  lessonSource: string;
  textbookExcerpt?: boolean;
  poem?: ClassicalText;
  editableChars: ReadonlySet<string>;
  result: string;
  unavailableLabel: string;
}

export const reviewRecordModeLabel = (log: ReviewLog) =>
  log.practiceMode === "lesson" ? "当课复习" : log.practiceMode === "history" ? "历史复习" : "旧记录";

export function reviewRecordLessonText(log: ReviewLog, lessons: readonly LessonSummary[]) {
  const references = log.lessons ?? [];
  if (references.length === 0) return "课文信息未记录";
  const titles = references.slice(0, 2).map((reference) => {
    const lesson = lessons.find(({ id }) => id === reference.id);
    return lesson ? lessonLabel(lesson, reference.title || lesson.title) : reference.title || "课文信息未记录";
  });
  return titles.join("、") + (references.length > 2 ? ` 等 ${references.length} 课` : "");
}

function archivedPoem(wordId: string, text: string): ClassicalText | undefined {
  if (!wordId.startsWith("poem-") || !text) return undefined;
  const [title, ...lines] = text.split("\n");
  return { id: wordId, title, titlePinyin: "", lines: lines.map((line) => ({ text: line, pinyin: "" })) };
}

export function reviewRecordQuestions(
  log: ReviewLog,
  wordById: ReadonlyMap<string, DictationWord>,
  lessons: readonly LessonSummary[],
): ReviewRecordQuestion[] {
  const snapshots = new Map((log.reviewedItems ?? []).map((item) => [item.wordId, item]));
  const wrongWords = new Set(log.wrongWordIds);
  const detailedWrongWords = new Set((log.wrongChars ?? []).map(({ wordId }) => wordId));
  const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const lessonReferences = new Map((log.lessons ?? []).map((lesson) => [lesson.id, lesson]));
  const onlyLesson = log.lessons?.length === 1 ? log.lessons[0] : undefined;

  return log.wordIds.map((wordId) => {
    const snapshot = snapshots.get(wordId);
    const currentWord = wordById.get(wordId);
    const matchingWord = !snapshot || snapshot.wordText === currentWord?.text ? currentWord : undefined;
    const text = snapshot?.wordText ?? currentWord?.text ?? "";
    const textChars = new Set(hanChars(text));
    const legacyTargets = snapshots.size === 0 && currentWord ? reviewCharsForWord(currentWord) : [];
    const reviewedChars = new Set((snapshot?.reviewedChars ?? legacyTargets).filter((char) => textChars.has(char)));
    const hasDetailedMistake = detailedWrongWords.has(wordId);
    const hasUndetailedMistake = wrongWords.has(wordId) && !hasDetailedMistake;
    const isLegacyWholeWordMistake = snapshots.size === 0 && hasUndetailedMistake;
    let result = reviewedChars.size === 0 ? "计分范围未记录" : reviewedChars.size === textChars.size ? "全部正确" : "计分字正确";
    if (hasDetailedMistake) result = "有错字";
    if (hasUndetailedMistake) result = "已有整题错误";

    const reference = lessonReferences.get(currentWord?.lessonId ?? "") ?? onlyLesson;
    const lesson = lessonsById.get(reference?.id ?? currentWord?.lessonId ?? "");
    const sourceTitle = matchingWord?.lessonTitle ?? reference?.title ?? lesson?.title ?? "课次信息缺失";

    return {
      word: { id: wordId, text, pinyin: matchingWord?.pinyin ?? "", textbookHint: matchingWord?.textbookHint },
      lessonSource: lesson ? `${shortBookLabel(lesson)} · ${sourceTitle}` : sourceTitle,
      textbookExcerpt: matchingWord?.textbookExcerpt,
      poem: matchingWord?.poem ?? archivedPoem(wordId, text),
      editableChars: isLegacyWholeWordMistake ? new Set() : reviewedChars,
      result,
      unavailableLabel: isLegacyWholeWordMistake ? "无逐字记录" : snapshot && reviewedChars.size > 0 ? "未计分" : "无法确认",
    };
  });
}

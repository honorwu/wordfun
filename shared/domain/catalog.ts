import type { Lesson, Progress } from "../types.ts";

export const lessonOrder = (lesson: Pick<Lesson, "grade" | "unit" | "number" | "sortOrder">) =>
  lesson.grade * 10000 + lesson.unit * 1000 + (lesson.sortOrder ?? lesson.number);

export const isVocabularyLesson = (lesson: Pick<Lesson, "lessonKind">) =>
  lesson.lessonKind !== "classical_poetry";

export const progressOrder = (progress: Progress, lessons: Lesson[]) => {
  const selected = lessons.find((lesson) => lesson.id === progress.lessonId);
  return selected ? lessonOrder(selected) : progress.grade * 1000;
};

export const getDictationWords = (lessons: Lesson[]) => lessons.flatMap((lesson) => lesson.dictationWords ?? []);

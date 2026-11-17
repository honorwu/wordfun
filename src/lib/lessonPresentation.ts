import type { Grade, LessonSummary } from "../../shared/types.ts";
import { gradeNames } from "../data/metadata";

export const termLabel = (term: number) => (term === 2 ? "下册" : "上册");

export const lessonNumberLabel = (lesson: LessonSummary, title = lesson.title) => {
  if (lesson.title.startsWith("语文园地")) return title;
  return Number.isInteger(lesson.number) ? `第${lesson.number}课·${title}` : title;
};

export const lessonLabel = (lesson: LessonSummary, title = lesson.title) => `${gradeNames[lesson.grade]}${termLabel(lesson.unit)} · ${lessonNumberLabel(lesson, title)}`;

export const availableGrades = (lessons: LessonSummary[]) =>
  Array.from(new Set(lessons.map((lesson) => lesson.grade))).sort((a, b) => a - b) as Grade[];

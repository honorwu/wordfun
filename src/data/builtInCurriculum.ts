import tongbianLessons from "./tongbianCurriculum.json";
import gardenLessons from "./gardenCurriculum.json";
import type { Lesson } from "../types";

export const builtInLessons = [...(tongbianLessons as unknown as Lesson[]), ...(gardenLessons as unknown as Lesson[])].sort(
  (a, b) => a.grade - b.grade || a.unit - b.unit || a.number - b.number,
);

export const builtInLessonCount = builtInLessons.length;

export const builtInWordCount = builtInLessons.reduce((sum, lesson) => sum + lesson.words.length, 0);

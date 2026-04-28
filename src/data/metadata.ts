import type { CharacterCategory, Grade } from "../types";

export const gradeNames: Record<Grade, string> = {
  1: "一年级",
  2: "二年级",
  3: "三年级",
  4: "四年级",
  5: "五年级",
};

export const categoryWeights: Record<CharacterCategory, number> = {
  "一类": 9,
  "二类": 7,
};

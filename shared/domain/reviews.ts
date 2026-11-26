import type { AppState, DictationWord, PracticeItem, ReviewLog } from "../types.ts";
import { fullDictationCharsForWord, hanChars, reviewCharsForWord, charReviewKey } from "./characters.ts";
import { canSupplementReview, uniqueTexts } from "./reviewPolicy.ts";

export const applyReviewResult = (
  state: AppState,
  items: PracticeItem[],
  wrongCharKeys: Set<string>,
  context?: { practiceMode: "lesson" | "history"; lessons: Array<{ id: string; title: string }> },
): AppState => {
  const now = new Date().toISOString();
  const words = new Map(items.map(({ word }) => [word.id, word]));
  const reviewedItems = [...words.values()].map((word) => {
    const reviewedChars = fullDictationCharsForWord(word);
    const wrongChars = reviewedChars.filter((char) => wrongCharKeys.has(charReviewKey(word.id, char)));
    return { word, wrongChars, reviewedChars };
  });
  const reviewLogs =
    reviewedItems.length > 0
      ? [
          {
            id: crypto.randomUUID(),
            date: now,
            practiceMode: context?.practiceMode,
            lessons: context?.lessons,
            wordIds: reviewedItems.map(({ word }) => word.id),
            wrongWordIds: reviewedItems.filter(({ wrongChars }) => wrongChars.length > 0).map(({ word }) => word.id),
            wrongChars: reviewedItems.flatMap(({ word, wrongChars }) => wrongChars.map((char) => ({ wordId: word.id, char }))),
            reviewedItems: reviewedItems.map(({ word, reviewedChars }) => ({
              wordId: word.id,
              wordText: word.text,
              reviewedChars,
            })),
          },
        ]
      : [];
  const next: AppState = {
    ...state,
    wordStats: { ...state.wordStats },
    charStats: { ...state.charStats },
    logs: [...reviewLogs, ...state.logs],
  };
  const sessionCharReviews = new Map<string, { isWrong: boolean; correctWordTexts: Set<string>; wrongWordTexts: Set<string> }>();

  for (const { word, wrongChars, reviewedChars } of reviewedItems) {
    const isWrong = wrongChars.length > 0;
    const previous = next.wordStats[word.id] ?? { attempts: 0, mistakes: 0, streak: 0 };
    next.wordStats[word.id] = {
      attempts: previous.attempts + 1,
      mistakes: previous.mistakes + (isWrong ? 1 : 0),
      streak: isWrong ? 0 : previous.streak + 1,
      lastReviewedAt: now,
      lastMistakeAt: isWrong ? now : previous.lastMistakeAt,
    };

    for (const char of reviewedChars) {
      const isCharWrong = wrongChars.includes(char);
      const sessionReview = sessionCharReviews.get(char) ?? {
        isWrong: false,
        correctWordTexts: new Set<string>(),
        wrongWordTexts: new Set<string>(),
      };
      sessionReview.isWrong ||= isCharWrong;
      (isCharWrong ? sessionReview.wrongWordTexts : sessionReview.correctWordTexts).add(word.text);
      sessionCharReviews.set(char, sessionReview);
    }
  }

  // 同一场默写里，同一个字无论出现于多少个词，都只累计一次作答；任一处写错则本场记错一次。
  for (const [char, sessionReview] of sessionCharReviews) {
    const charPrevious = state.charStats[char] ?? { attempts: 0, mistakes: 0, streak: 0 };
    next.charStats[char] = {
      attempts: charPrevious.attempts + 1,
      mistakes: charPrevious.mistakes + (sessionReview.isWrong ? 1 : 0),
      streak: sessionReview.isWrong ? 0 : charPrevious.streak + 1,
      correctWordTexts: uniqueTexts([...(charPrevious.correctWordTexts ?? []), ...sessionReview.correctWordTexts]),
      wrongWordTexts: uniqueTexts([...(charPrevious.wrongWordTexts ?? []), ...sessionReview.wrongWordTexts]),
      lastReviewedAt: now,
      lastMistakeAt: sessionReview.isWrong ? now : charPrevious.lastMistakeAt,
    };
  }

  return next;
};

export interface MissedWrongCharCorrection {
  wordId: string;
  char: string;
}

const logWrongWordIds = (log: AppState["logs"][number]) =>
  new Set([...(log.wrongWordIds ?? []), ...(log.wrongChars ?? []).map((item) => item.wordId)]);

const hasPartialSnapshot = (snapshot?: NonNullable<ReviewLog["reviewedItems"]>[number]) =>
  Boolean(snapshot?.wordText && hanChars(snapshot.wordText).some((char) => !snapshot.reviewedChars.includes(char)));

const logReviewedChars = (
  log: AppState["logs"][number],
  wordById: ReadonlyMap<string, DictationWord>,
) => {
  if (log.reviewedItems && log.reviewedItems.length > 0) {
    return new Set(log.reviewedItems.flatMap((item) => item.reviewedChars));
  }
  return new Set(
    log.wordIds.flatMap((wordId) => {
      const word = wordById.get(wordId);
      return word ? reviewCharsForWord(word) : [];
    }),
  );
};

const trailingWordStreak = (logs: AppState["logs"], wordId: string) => {
  let streak = 0;
  for (const log of logs) {
    if (!log.wordIds.includes(wordId)) continue;
    if (logWrongWordIds(log).has(wordId)) break;
    if (hasPartialSnapshot(log.reviewedItems?.find((item) => item.wordId === wordId))) continue;
    streak += 1;
  }
  return streak;
};

const trailingCharStreak = (
  logs: AppState["logs"],
  char: string,
  wordById: ReadonlyMap<string, DictationWord>,
) => {
  let streak = 0;
  for (const log of logs) {
    if ((log.wrongChars ?? []).some((item) => item.char === char)) break;
    const isLegacyLog = !log.reviewedItems || log.reviewedItems.length === 0;
    const wrongWordsWithCharDetails = new Set((log.wrongChars ?? []).map((item) => item.wordId));
    const hasUndetailedLegacyWrongWordContainingChar = isLegacyLog && log.wrongWordIds.some((wordId) => {
      if (wrongWordsWithCharDetails.has(wordId)) return false;
      const word = wordById.get(wordId);
      return word ? reviewCharsForWord(word).includes(char) : false;
    });
    if (!logReviewedChars(log, wordById).has(char) && !hasUndetailedLegacyWrongWordContainingChar) continue;
    if (hasUndetailedLegacyWrongWordContainingChar) break;
    streak += 1;
  }
  return streak;
};

const laterDate = (left: string | undefined, right: string) => !left || right > left ? right : left;

export const addMissedWrongChars = (
  state: AppState,
  logId: string,
  requestedCorrections: readonly MissedWrongCharCorrection[],
  wordById: ReadonlyMap<string, DictationWord>,
  now = Date.now(),
): AppState => {
  const targetLog = state.logs.find((log) => log.id === logId);
  if (!targetLog || !canSupplementReview(targetLog, now)) return state;

  const hasReviewSnapshot = Boolean(targetLog.reviewedItems && targetLog.reviewedItems.length > 0);
  const loggedWordIds = new Set(targetLog.wordIds);
  const partialWordIds = new Set((targetLog.reviewedItems ?? []).filter(hasPartialSnapshot).map((item) => item.wordId));
  const reviewedCharsByWordId = new Map(
    hasReviewSnapshot
      ? (targetLog.reviewedItems ?? []).map((item) => [item.wordId, new Set(item.reviewedChars)] as const)
      : targetLog.wordIds.map((wordId) => {
        const word = wordById.get(wordId);
        // 旧记录没有逐题计分快照；同场其他题也可能更新字的时间戳，不能据此推断本题的提示字曾被计分。
        const safelyRecoverableChars = word ? reviewCharsForWord(word) : [];
        return [wordId, new Set(safelyRecoverableChars)] as const;
      }),
  );
  const wordTextByWordId = new Map(
    hasReviewSnapshot
      ? (targetLog.reviewedItems ?? []).map((item) => [item.wordId, item.wordText] as const)
      : targetLog.wordIds.map((wordId) => [wordId, wordById.get(wordId)?.text ?? ""] as const),
  );
  const existingKeys = new Set((targetLog.wrongChars ?? []).map((item) => charReviewKey(item.wordId, item.char)));
  const previouslyWrongWords = logWrongWordIds(targetLog);
  const wrongWordsWithCharDetails = new Set((targetLog.wrongChars ?? []).map((item) => item.wordId));
  const isLegacyLog = !hasReviewSnapshot;
  const undetailedLegacyWrongWordIds = new Set(
    isLegacyLog
      ? targetLog.wrongWordIds.filter((wordId) => !wrongWordsWithCharDetails.has(wordId))
      : [],
  );
  const inferredLegacyWrongChars = [...undetailedLegacyWrongWordIds].flatMap((wordId) => {
    const word = wordById.get(wordId);
    return word ? reviewCharsForWord(word) : [];
  });
  const previouslyWrongChars = new Set([
    ...(targetLog.wrongChars ?? []).map((item) => item.char),
    ...inferredLegacyWrongChars,
  ]);
  const corrections = requestedCorrections.map((correction) => ({
    ...correction,
    wordText: wordTextByWordId.get(correction.wordId) ?? "",
  })).filter((correction, index, all) => {
    if (!loggedWordIds.has(correction.wordId) || !/^\p{Script=Han}$/u.test(correction.char)) return false;
    // 逐字明细上线前，整词错误已把全部目标字计错，无法再安全区分实际错字；保留原统计且不开放补记。
    if (undetailedLegacyWrongWordIds.has(correction.wordId)) return false;
    if (!reviewedCharsByWordId.get(correction.wordId)?.has(correction.char)) return false;
    if (!correction.wordText.includes(correction.char)) return false;
    const key = charReviewKey(correction.wordId, correction.char);
    if (existingKeys.has(key) || all.findIndex((item) => charReviewKey(item.wordId, item.char) === key) !== index) return false;
    const wordStat = state.wordStats[correction.wordId];
    const charStat = state.charStats[correction.char];
    if (!wordStat || !charStat) return false;
    if (previouslyWrongWords.has(correction.wordId) && wordStat.mistakes === 0) return false;
    if (!previouslyWrongWords.has(correction.wordId) && !partialWordIds.has(correction.wordId) && wordStat.mistakes >= wordStat.attempts) return false;
    if (previouslyWrongChars.has(correction.char) && charStat.mistakes === 0) return false;
    if (!previouslyWrongChars.has(correction.char) && charStat.mistakes >= charStat.attempts) return false;
    return true;
  });
  if (corrections.length === 0) return state;

  const nextWrongChars = [
    ...(targetLog.wrongChars ?? []),
    ...corrections.map(({ wordId, char }) => ({ wordId, char })),
  ];
  const nextWrongWordIdSet = new Set([
    ...targetLog.wrongWordIds,
    ...corrections.map((correction) => correction.wordId),
  ]);
  const nextWrongWordIds = targetLog.wordIds.filter((wordId) => nextWrongWordIdSet.has(wordId));
  const nextLogs = state.logs.map((log) => log.id === logId
    ? { ...log, wrongWordIds: nextWrongWordIds, wrongChars: nextWrongChars }
    : log);
  const next: AppState = {
    ...state,
    wordStats: { ...state.wordStats },
    charStats: { ...state.charStats },
    logs: nextLogs,
  };

  const correctedWordIds = Array.from(new Set(corrections.map((correction) => correction.wordId)));
  for (const wordId of correctedWordIds) {
    const previous = state.wordStats[wordId];
    if (!previous) continue;
    const becomesWrongThisSession = !previouslyWrongWords.has(wordId);
    next.wordStats[wordId] = {
      ...previous,
      attempts: previous.attempts + Number(becomesWrongThisSession && partialWordIds.has(wordId)),
      mistakes: previous.mistakes + (becomesWrongThisSession ? 1 : 0),
      streak: becomesWrongThisSession ? trailingWordStreak(nextLogs, wordId) : previous.streak,
      lastMistakeAt: laterDate(previous.lastMistakeAt, targetLog.date),
    };
  }

  const correctionsByChar = new Map<string, Array<MissedWrongCharCorrection & { wordText: string }>>();
  for (const correction of corrections) {
    correctionsByChar.set(correction.char, [...(correctionsByChar.get(correction.char) ?? []), correction]);
  }
  for (const [char, charCorrections] of correctionsByChar) {
    const previous = state.charStats[char];
    if (!previous) continue;
    const wordTexts = charCorrections.map((correction) => correction.wordText.trim()).filter(Boolean);
    const becomesWrongThisSession = !previouslyWrongChars.has(char);
    next.charStats[char] = {
      ...previous,
      mistakes: becomesWrongThisSession
        ? previous.mistakes + 1
        : previous.mistakes,
      streak: becomesWrongThisSession ? trailingCharStreak(nextLogs, char, wordById) : previous.streak,
      // 词语证据表示“历史上曾出现过”，缺少逐次计数时不能安全删除已有的正确证据。
      wrongWordTexts: uniqueTexts([...(previous.wrongWordTexts ?? []), ...wordTexts]),
      lastMistakeAt: laterDate(previous.lastMistakeAt, targetLog.date),
    };
  }

  return next;
};

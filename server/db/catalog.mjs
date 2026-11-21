import { allRows, hasTable } from "./query.mjs";

export const normalizeCategory = (category) => (category === "一类" ? "一类" : "二类");

export const getLessons = (catalogDb) => {
  const hasContexts = hasTable(catalogDb, "textbook_word_contexts");
  const storedQuestions = hasTable(catalogDb, "catalog_meta")
    && catalogDb.prepare("SELECT value FROM catalog_meta WHERE key = 'source_format'").get()?.value === "dictation-textbook-v3";
  const lessons = allRows(
    catalogDb,
    `SELECT id, grade, term AS unit, lesson_number AS number, sort_order, title, lesson_kind, direct_dictation
     FROM lessons
     WHERE EXISTS (
       SELECT 1
       FROM lesson_characters lc
       WHERE lc.lesson_id = lessons.id
     )
        OR EXISTS (
          SELECT 1
          FROM classical_texts ct
          WHERE ct.lesson_id = lessons.id
        )
        OR EXISTS (
          SELECT 1 FROM lesson_words lw WHERE lw.lesson_id = lessons.id AND lw.source_column = '词语表'
        )
     ORDER BY grade, term, sort_order`,
  );
  const words = allRows(
    catalogDb,
    `SELECT
       lc.lesson_id,
       lc.char,
       COALESCE(MAX(CASE WHEN lc.category = '一类' THEN '一类' END), '二类') AS category,
       COALESCE(
         MAX(CASE WHEN lc.category = '一类' THEN lc.pinyin END),
         MAX(lc.pinyin),
         ''
       ) AS pinyin,
       MIN(lc.char_order) AS word_order,
       l.grade,
       l.title AS lesson_title
     FROM lesson_characters lc
     JOIN lessons l ON l.id = lc.lesson_id
     GROUP BY lc.lesson_id, lc.char
     ORDER BY lc.lesson_id, word_order`,
  );
  const companionRows = allRows(
    catalogDb,
    "SELECT lesson_id, char, word, pinyin FROM char_companion_words ORDER BY lesson_id, char, companion_rank",
  );
  const targetRows = storedQuestions
    ? allRows(catalogDb, "SELECT lesson_word_id, char FROM lesson_word_targets ORDER BY lesson_word_id, target_order")
    : [];
  const wordRows = allRows(
    catalogDb,
    `SELECT
       lw.id,
       lw.lesson_id,
       w.text,
       w.pinyin,
       lw.word_order,
       lw.source_column,
       COALESCE(${hasContexts ? "context.hint_text" : "NULL"}, ${storedQuestions ? "supplement.hint_text" : "NULL"}) AS hint_text,
       l.grade,
       l.title AS lesson_title,
       CASE
         WHEN EXISTS (
           SELECT 1
           FROM word_characters wc
           JOIN lesson_characters lc
             ON lc.lesson_id = lw.lesson_id
            AND lc.char = wc.char
            AND lc.category = '一类'
           WHERE wc.word_id = lw.word_id
         ) THEN '一类'
         ELSE '二类'
       END AS category
     FROM lesson_words lw
     JOIN words w ON w.id = lw.word_id
     JOIN lessons l ON l.id = lw.lesson_id
     ${hasContexts ? "LEFT JOIN textbook_word_contexts context ON context.lesson_word_id = lw.id" : ""}
     ${storedQuestions ? "LEFT JOIN lesson_supplement_contexts supplement ON supplement.lesson_word_id = lw.id" : ""}
     WHERE lw.source_column IN (${storedQuestions ? "'词语表', '未覆盖生字组词', '古诗词整篇'" : "'词语表'"})
    ORDER BY lw.lesson_id, lw.word_order`,
  );
  const classicalTextRows = allRows(
    catalogDb,
    `SELECT id, lesson_id, title, title_pinyin, author, dynasty, text_order
     FROM classical_texts
     WHERE lesson_id IS NOT NULL
     ORDER BY lesson_id, text_order`,
  );
  const classicalLineRows = allRows(
    catalogDb,
    `SELECT text_id, line_order, text, pinyin
     FROM classical_lines
     ORDER BY text_id, line_order`,
  );
  const wordsByLesson = new Map();
  const writingCharsByLesson = new Map();
  for (const row of words) {
    const word = {
      id: `${row.lesson_id}-char-${row.char}`,
      text: row.char,
      pinyin: row.pinyin,
      chars: [row.char],
      grade: row.grade,
      lessonId: row.lesson_id,
      lessonTitle: row.lesson_title,
      category: normalizeCategory(row.category),
    };
    wordsByLesson.set(row.lesson_id, [...(wordsByLesson.get(row.lesson_id) || []), word]);
    if (word.category === "一类") {
      const writingChars = writingCharsByLesson.get(row.lesson_id) ?? new Set();
      writingChars.add(row.char);
      writingCharsByLesson.set(row.lesson_id, writingChars);
    }
  }
  const textbookWordsByLesson = new Map();
  const storedWordsByLesson = new Map();
  const targetsByWord = Map.groupBy(targetRows, (row) => row.lesson_word_id);
  for (const row of wordRows) {
    const isPoem = row.source_column === "古诗词整篇";
    const targets = targetsByWord.get(row.id);
    const category = targets
      ? (targets.some(({ char }) => writingCharsByLesson.get(row.lesson_id)?.has(char)) ? "一类" : "二类")
      : isPoem ? "一类" : normalizeCategory(row.category);
    const word = {
      id: row.id,
      text: row.text,
      pinyin: row.pinyin,
      chars: targets?.map(({ char }) => char) ?? [...new Set(Array.from(row.text).filter((char) => /\p{Script=Han}/u.test(char)))],
      ...(row.hint_text ? { textbookHint: row.hint_text } : {}),
      grade: row.grade,
      lessonId: row.lesson_id,
      lessonTitle: isPoem ? row.text.split("\n", 1)[0] : row.lesson_title,
      category,
    };
    storedWordsByLesson.set(row.lesson_id, [...(storedWordsByLesson.get(row.lesson_id) ?? []), word]);
    if (row.source_column === "词语表") {
      textbookWordsByLesson.set(row.lesson_id, [...(textbookWordsByLesson.get(row.lesson_id) ?? []), word]);
    }
  }
  const indexCompanions = (rows) => {
    const byLesson = new Map();
    for (const row of rows) {
      const entry = byLesson.get(row.lesson_id) ?? {};
      (entry[row.char] ??= []).push({
        text: row.word, pinyin: row.pinyin, chars: Array.from(row.word).filter((char) => /\p{Script=Han}/u.test(char)),
      });
      byLesson.set(row.lesson_id, entry);
    }
    return byLesson;
  };
  const companionsByLesson = indexCompanions(companionRows);
  const classicalLinesByText = new Map();
  for (const row of classicalLineRows) {
    classicalLinesByText.set(row.text_id, [
      ...(classicalLinesByText.get(row.text_id) || []),
      { text: row.text, pinyin: row.pinyin },
    ]);
  }
  const classicalTextsByLesson = new Map();
  for (const row of classicalTextRows) {
    const text = {
      id: row.id,
      title: row.title,
      titlePinyin: row.title_pinyin,
      author: row.author || undefined,
      dynasty: row.dynasty || undefined,
      lines: classicalLinesByText.get(row.id) || [],
    };
    classicalTextsByLesson.set(row.lesson_id, [...(classicalTextsByLesson.get(row.lesson_id) || []), text]);
  }
  return lessons.map((lesson) => ({
    id: lesson.id,
    grade: lesson.grade,
    unit: lesson.unit,
    number: lesson.number,
    sortOrder: lesson.sort_order,
    title: lesson.title,
    lessonKind: lesson.lesson_kind,
    directDictation: Boolean(lesson.direct_dictation),
    words: wordsByLesson.get(lesson.id) || [],
    textbookWords: textbookWordsByLesson.get(lesson.id) || [],
    ...(storedQuestions ? { dictationWords: storedWordsByLesson.get(lesson.id) ?? [] } : {}),
    textCompanions: companionsByLesson.get(lesson.id) || {},
    classicalTexts: classicalTextsByLesson.get(lesson.id) || [],
  }));
};

export const getCompanionWords = (catalogDb) => {
  const rows = allRows(catalogDb, "SELECT char, word, pinyin FROM char_companion_words ORDER BY char, companion_rank");
  const companions = {};
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.char}\u0000${row.word}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    companions[row.char] = [...(companions[row.char] || []), { text: row.word, pinyin: row.pinyin, chars: Array.from(row.word) }];
  }
  return companions;
};

import { allRows } from "./query.mjs";

export const normalizeCategory = (category) => (category === "一类" ? "一类" : "二类");

export const getLessons = (catalogDb) => {
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
  const textbookRows = allRows(
    catalogDb,
    `SELECT
       lw.id,
       lw.lesson_id,
       w.text,
       w.pinyin,
       lw.word_order,
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
     WHERE lw.source_column = '词语表'
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
  }
  const textbookWordsByLesson = new Map();
  for (const row of textbookRows) {
    const word = {
      id: row.id,
      text: row.text,
      pinyin: row.pinyin,
      chars: Array.from(row.text).filter((char) => /\p{Script=Han}/u.test(char)),
      grade: row.grade,
      lessonId: row.lesson_id,
      lessonTitle: row.lesson_title,
      category: normalizeCategory(row.category),
    };
    textbookWordsByLesson.set(row.lesson_id, [...(textbookWordsByLesson.get(row.lesson_id) || []), word]);
  }
  const companionsByLesson = new Map();
  for (const row of companionRows) {
    const lessonCompanions = companionsByLesson.get(row.lesson_id) || {};
    lessonCompanions[row.char] = [
      ...(lessonCompanions[row.char] || []),
      { text: row.word, pinyin: row.pinyin, chars: Array.from(row.word).filter((char) => /\p{Script=Han}/u.test(char)) },
    ];
    companionsByLesson.set(row.lesson_id, lessonCompanions);
  }
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

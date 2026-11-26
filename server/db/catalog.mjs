import { allRows } from "./query.mjs";

export const getLessons = (catalogDb) => {
  // 接口的 unit 对应数据库的 term。教材单元使用 unit_index 和 unit_name。
  const lessons = allRows(catalogDb,
    `SELECT id, grade, term AS unit, lesson_number AS number, sort_order, title, lesson_kind
     FROM lessons
     WHERE EXISTS (SELECT 1 FROM lesson_characters WHERE lesson_id = lessons.id)
        OR EXISTS (SELECT 1 FROM questions WHERE lesson_id = lessons.id)
     ORDER BY grade, term, sort_order`);
  const charactersByLesson = Map.groupBy(allRows(catalogDb,
    `SELECT lesson_id, char,
       COALESCE(MAX(CASE WHEN category = '一类' THEN '一类' END), '二类') AS category,
       COALESCE(MAX(CASE WHEN category = '一类' THEN pinyin END), MAX(pinyin)) AS pinyin,
       MIN(char_order) AS position
     FROM lesson_characters
     GROUP BY lesson_id, char
     ORDER BY lesson_id, position`), (row) => row.lesson_id);
  const questionsByLesson = Map.groupBy(allRows(catalogDb,
    `SELECT id, lesson_id, kind, text, pinyin, target_chars, hint_text, poem
     FROM questions
     ORDER BY lesson_id, position`), (row) => row.lesson_id);

  return lessons.map((lesson) => {
    const { id, grade, title } = lesson;
    const characters = charactersByLesson.get(id) ?? [];
    const shared = { grade, lessonId: id, lessonTitle: title };
    const words = characters.map((row) => ({
      ...shared,
      id: `${id}-char-${row.char}`,
      text: row.char,
      pinyin: row.pinyin,
      chars: [row.char],
      category: row.category,
    }));
    const writingChars = new Set(characters.filter((row) => row.category === "一类").map((row) => row.char));
    const textbookWords = [];
    const classicalTexts = [];
    const dictationWords = (questionsByLesson.get(id) ?? []).map((row) => {
      const chars = JSON.parse(row.target_chars);
      const word = {
        ...shared,
        id: row.id,
        text: row.text,
        pinyin: row.pinyin,
        chars,
        category: chars.some((char) => writingChars.has(char)) ? "一类" : "二类",
        ...(row.hint_text ? { textbookHint: row.hint_text } : {}),
      };
      if (row.kind === "textbook") textbookWords.push(word);
      if (row.kind === "poem") {
        const { title, titlePinyin, author, dynasty } = JSON.parse(row.poem);
        const linePinyin = row.pinyin.split("\n");
        const lines = row.text.split("\n").map((text, index) => ({ text, pinyin: linePinyin[index] ?? "" }));
        word.poem = { id: row.id.slice("poem-".length), title, titlePinyin, ...(author && { author }), ...(dynasty && { dynasty }), lines };
        classicalTexts.push(word.poem);
        word.text = [title, dynasty, author, row.text].filter(Boolean).join("\n");
        word.pinyin = [titlePinyin, row.pinyin].filter(Boolean).join("\n");
        word.lessonTitle = title;
        word.category = "一类";
      }
      return word;
    });

    return {
      id,
      grade,
      unit: lesson.unit,
      number: lesson.number,
      sortOrder: lesson.sort_order,
      title,
      lessonKind: lesson.lesson_kind,
      directDictation: lesson.lesson_kind === "classical_poetry",
      words,
      textbookWords,
      dictationWords,
      classicalTexts,
    };
  });
};

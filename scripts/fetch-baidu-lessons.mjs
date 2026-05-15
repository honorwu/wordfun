import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://xiaodu.baidu.com/edu-gateway/gateway/index';
const DETAIL_URL = 'https://xiaodu.baidu.com/saiya/superapp/poem.html#/detail?pid=';
const CLIENT_ID = '479f8fe8402b1fb093c912772295132b';
const DEVICE_ID = crypto.randomUUID().replaceAll('-', '');
const SIGN_SECRET = '29@2KD983mx';
const OUTPUT_DIR = path.resolve("textbook", "baidu_lesson");
const XUEZHI = '54';
const GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级'];
const TERMS = ['上册', '下册'];

function createHeaders() {
  const timestamp = Date.now().toString();
  const signature = crypto
    .createHash('sha1')
    .update(`${CLIENT_ID}-${DEVICE_ID}-${timestamp}-${SIGN_SECRET}`)
    .digest('hex');

  return {
    'content-type': 'application/json;charset=UTF-8',
    referer: 'https://xiaodu.baidu.com/saiya/superapp/poem.html',
    origin: 'https://xiaodu.baidu.com',
    'user-agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 xiaoduapp/3.9.0',
    'client-id': CLIENT_ID,
    'device-id': DEVICE_ID,
    'saiya-logid': crypto.randomUUID().replaceAll('-', ''),
    'access-token': `${timestamp}-${signature}`,
    'Acs-Token': '',
  };
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callApi(url, params, attempt = 1) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: createHeaders(),
    body: JSON.stringify({ url, params }),
  });

  if (!response.ok) {
    if (attempt < 3) {
      await delay(300 * attempt);
      return callApi(url, params, attempt + 1);
    }
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const data = await response.json();
  if (data.status !== 0) {
    if (attempt < 3) {
      await delay(300 * attempt);
      return callApi(url, params, attempt + 1);
    }
    throw new Error(`API status ${data.status}: ${data.msg || url}`);
  }

  return data.data?.resources?.[0]?.payload ?? {};
}

function cleanFileName(value) {
  return String(value)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function textFromPinyinDetail(detail) {
  return Array.isArray(detail) ? detail.map((item) => item?.hanzi ?? '').join('') : '';
}

function sentenceText(sentence) {
  return (
    sentence?.source ||
    sentence?.text ||
    sentence?.content ||
    textFromPinyinDetail(sentence?.pinyin_detail)
  ).trim();
}

function getLessonBody(payload) {
  const chapters = payload?.article_detail?.chapter ?? [];
  return chapters
    .map((chapter) => {
      const sentences = chapter?.sentences ?? [];
      return sentences.map(sentenceText).filter(Boolean).join('');
    })
    .filter(Boolean)
    .join('\n\n');
}

function getAuthor(payload) {
  return (
    payload?.article_detail?.author_info?.source ||
    payload?.author?.name ||
    payload?.author?.source ||
    ''
  ).trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value ?? ''))
    .replace(/<img\b[^>]*\bsrc=["']?([^"'\s>]+)["']?[^>]*>/gi, '\n图片：$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function flattenText(value) {
  if (value == null || value === '') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenText(item));
  }
  if (typeof value === 'object') {
    return [];
  }
  const text = htmlToText(value);
  return text ? [text] : [];
}

function joinText(value, separator = '、') {
  return flattenText(value).join(separator);
}

function pushLine(lines, label, value) {
  const text = joinText(value);
  if (text) {
    lines.push(`- ${label}：${text}`);
  }
}

function pushStringSection(lines, title, value) {
  const text = htmlToText(value);
  if (text) {
    lines.push(`## ${title}`, '', text, '');
  }
}

function hasObjectContent(value) {
  return value && typeof value === 'object' && Object.values(value).some((item) => {
    if (Array.isArray(item)) {
      return item.length > 0;
    }
    return Boolean(item);
  });
}

function renderAuthorInfo(lines, author) {
  if (!hasObjectContent(author) || !author.introduction) {
    return;
  }
  lines.push('## 作者简介', '');
  pushLine(lines, '人物生平', author.introduction);
  pushLine(lines, '文学成就', author.achievement);
  pushLine(lines, '主要作品', author.major_works);
  lines.push('');
}

function renderNewWord(lines, words) {
  if (!Array.isArray(words) || !words.length) {
    return;
  }
  lines.push('## 生字学习', '');
  for (const word of words) {
    const pinyin = joinText(word.pinyin);
    lines.push(`### ${word.word}${pinyin ? `（${pinyin}）` : ''}`, '');
    pushLine(lines, '部首', word.radical);
    pushLine(lines, '结构', word.struct);
    pushLine(lines, '笔画', word.stroke_num);
    pushLine(lines, '繁体', word.traditional && word.traditional !== word.word ? word.traditional : '');
    pushLine(lines, '课文释义', word.text_definition);
    pushLine(lines, '释义', word.definition);
    pushLine(lines, '组词', word.group_words);
    pushLine(lines, '拓展组词', word.ext_group_words);
    lines.push('');
  }
}

function renderNewWords(lines, words) {
  if (!Array.isArray(words) || !words.length) {
    return;
  }
  lines.push('## 词语学习', '');
  for (const item of words) {
    const word = joinText(item.word, '');
    const pinyin = joinText(item.pinyin, ' ');
    lines.push(`### ${word}${pinyin ? `（${pinyin}）` : ''}`, '');
    pushLine(lines, '释义', item.definition);
    pushLine(lines, '近义词', item.synonyms);
    pushLine(lines, '反义词', item.antonym);
    pushLine(lines, '例句', item.sentence);
    pushLine(lines, '音频', item.audio);
    lines.push('');
  }
}

function renderPairList(lines, title, list) {
  if (!Array.isArray(list) || !list.length) {
    return;
  }
  lines.push(`### ${title}`, '');
  for (const item of list) {
    const pair = flattenText(item);
    if (pair.length >= 2) {
      lines.push(`- ${pair[0]}：${pair.slice(1).join('、')}`);
    } else if (pair.length) {
      lines.push(`- ${pair[0]}`);
    }
  }
  lines.push('');
}

function renderWordLearning(lines, learning) {
  if (!hasObjectContent(learning)) {
    return;
  }
  const hasUsefulContent = Boolean(
    learning.polyphonic_character?.length ||
      learning.word_dictation?.length ||
      learning.word_collocation?.length ||
      learning.word_expansion?.length ||
      learning.key_words?.length ||
      learning.synonyms?.list?.length ||
      learning.antonym?.list?.length,
  );
  if (!hasUsefulContent) {
    return;
  }

  lines.push('## 词语辨析', '');

  if (learning.key_words?.length) {
    lines.push(`### 关键词`, '', joinText(learning.key_words), '');
  }

  if (learning.polyphonic_character?.length) {
    lines.push('### 多音字', '');
    for (const item of learning.polyphonic_character) {
      lines.push(`- ${htmlToText(item.char)}：${htmlToText(item.desc)}`);
      pushLine(lines, '辨析', item.analysis);
      pushLine(lines, '例句', item.ex_sentence);
    }
    lines.push('');
  }

  if (learning.word_dictation?.length) {
    lines.push('### 词语听写', '', joinText(learning.word_dictation), '');
  }

  if (learning.word_collocation?.length) {
    lines.push('### 词语搭配', '', joinText(learning.word_collocation), '');
  }

  if (learning.word_expansion?.length) {
    lines.push('### 词语拓展', '');
    for (const item of learning.word_expansion) {
      if (typeof item === 'object') {
        lines.push(`- ${htmlToText(item.title || '')}：${joinText(item.words || item.list || item.content)}`);
      } else {
        lines.push(`- ${htmlToText(item)}`);
      }
    }
    lines.push('');
  }

  renderPairList(lines, '近义词', learning.synonyms?.list);
  if (learning.synonyms?.analysis?.length) {
    lines.push('近义词辨析：', '', joinText(learning.synonyms.analysis, '\n\n'), '');
  }
  if (learning.synonyms?.ex_sentence?.length) {
    lines.push('近义词例句：', '', joinText(learning.synonyms.ex_sentence, '\n'), '');
  }

  renderPairList(lines, '反义词', learning.antonym?.list);
  if (learning.antonym?.analysis?.length) {
    lines.push('反义词辨析：', '', joinText(learning.antonym.analysis, '\n\n'), '');
  }
  if (learning.antonym?.ex_sentence?.length) {
    lines.push('反义词例句：', '', joinText(learning.antonym.ex_sentence, '\n'), '');
  }
}

function renderKnowledgeQa(lines, items) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }
  lines.push('## 思考', '');
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${htmlToText(item.ask)}`);
    const answer = htmlToText(item.answer);
    if (answer) {
      lines.push(`   答：${answer}`);
    }
  });
  lines.push('');
}

function renderExerciseItem(lines, item, label) {
  lines.push(`### 习题 ${label}`, '');
  const question = htmlToText(item.question_content);
  if (question) {
    lines.push(question, '');
  }
  if (Array.isArray(item.question_options) && item.question_options.length) {
    item.question_options.forEach((option, index) => {
      const letter = String.fromCharCode(65 + index);
      lines.push(`- ${letter}. ${htmlToText(option)}`);
    });
    lines.push('');
  }
  if (Array.isArray(item.children) && item.children.length) {
    item.children.forEach((child, index) => renderExerciseItem(lines, child, `${label}.${index + 1}`));
    return;
  }
  pushLine(lines, '答案', item.answer);
  pushLine(lines, '解析', item.analysis);
  lines.push('');
}

function renderExercises(lines, items) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }
  lines.push('## 巩固练习', '');
  items.forEach((item, index) => renderExerciseItem(lines, item, `${index + 1}`));
}

function renderWritingGuide(lines, items) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }
  lines.push('## 写作指导', '');
  items.forEach((item, index) => {
    const title = htmlToText(item.title);
    const content = htmlToText(item.con);
    lines.push(`${index + 1}. ${title ? `${title}：` : ''}${content}`);
  });
  lines.push('');
}

function renderExtraSections(payload) {
  const lines = [];
  pushStringSection(lines, '赏析', payload.shangxi);
  renderNewWord(lines, payload.new_word);
  renderNewWords(lines, payload.new_words);
  renderWordLearning(lines, payload.word_learning);
  return lines.join('\n').trim();
}

function renderMarkdown({ book, unit, lesson, payload, body }) {
  const title = lesson.displayName;
  const author = getAuthor(payload);
  const lines = [
    `# ${title}`,
    '',
    `- 学制：五四制`,
    `- 年级：${book.grade}`,
    `- 册别：${book.term}`,
    `- 教材：${book.name}`,
    `- 单元：${unit.name}`,
    `- PID：${lesson.id}`,
    `- 来源：${DETAIL_URL}${lesson.id}`,
  ];

  if (author) {
    lines.push(`- 作者：${author}`);
  }

  lines.push('', '## 课文', '', body || '（该接口未返回课文正文）', '');
  const extraSections = renderExtraSections(payload);
  if (extraSections) {
    lines.push(extraSections, '');
  }

  return lines.join('\n');
}

function leafLessonsFromCatalog(catalog) {
  const lessons = [];
  for (const unit of catalog ?? []) {
    for (const article of unit.article ?? []) {
      if (article.have_child && article.child_list?.length) {
        for (const child of article.child_list) {
          lessons.push({
            unit,
            id: String(child.id),
            catalogName: article.name,
            childName: child.name,
            displayName: `${article.name} - ${child.name}`,
          });
        }
      } else {
        lessons.push({
          unit,
          id: String(article.id),
          catalogName: article.name,
          childName: '',
          displayName: article.name,
        });
      }
    }
  }
  return lessons;
}

async function writeIndex(indexRows) {
  const lines = ['# 百度小度五四制语文课文目录', ''];
  for (const row of indexRows) {
    lines.push(`- ${row.bookTitle}/（${row.count} 篇）`);
  }
  lines.push('');
  await fs.writeFile(path.join(OUTPUT_DIR, '目录.md'), lines.join('\n'), 'utf8');
}

async function main() {
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const indexRows = [];
  const failures = [];
  let savedCount = 0;

  for (const grade of GRADES) {
    for (const term of TERMS) {
      const catalogPayload = await callApi('dueros://bot_deepspace/catalog/info', {
        grade,
        term,
        xuezhi: XUEZHI,
      });
      const book = catalogPayload.book ?? { grade, term, name: `${grade}${term}` };
      const bookDirName = cleanFileName(`${book.grade}${book.term}`);
      const bookDir = path.join(OUTPUT_DIR, bookDirName);
      await fs.mkdir(bookDir, { recursive: true });
      const lessons = leafLessonsFromCatalog(catalogPayload.catalog);
      let order = 0;

      for (const lesson of lessons) {
        order += 1;

        try {
          const payload = await callApi('dueros://bot_deepspace/lesson/info', {
            id: lesson.id,
          });
          const body = getLessonBody(payload);
          const fileName = cleanFileName(
            `${String(order).padStart(3, '0')} ${lesson.displayName} (${lesson.id}).md`,
          );
          const filePath = path.join(bookDir, fileName);
          await fs.writeFile(
            filePath,
            renderMarkdown({ book, unit: lesson.unit, lesson, payload, body }),
            'utf8',
          );

          savedCount += 1;
        } catch (error) {
          failures.push({
            book: `${grade}${term}`,
            lesson: lesson.displayName,
            id: lesson.id,
            error: error.message,
          });
        }

        await delay(80);
      }

      indexRows.push({
        bookTitle: `${book.grade}${book.term}`,
        count: lessons.length,
      });

      console.log(`${book.grade}${book.term}: saved ${savedCount} total`);
    }
  }

  await writeIndex(indexRows);

  console.log(
    `Done. Saved ${savedCount} lesson markdown files in ${indexRows.length} volume directories under ${OUTPUT_DIR}`,
  );
  if (failures.length) {
    console.log('Failures:');
    for (const failure of failures) {
      console.log(
        `- ${failure.book} ${failure.lesson} (${failure.id}): ${failure.error}`,
      );
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

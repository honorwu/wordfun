import type { CharacterCategory, DictationWord, Grade, Lesson } from "../types";

type RawWord = {
  text: string;
  pinyin: string;
  chars?: string;
  category: CharacterCategory | "四类";
};

type RawLesson = {
  grade: Grade;
  unit: number;
  number: number;
  title: string;
  words: RawWord[];
};

const rawLessons: RawLesson[] = [
  {
    grade: 1,
    unit: 1,
    number: 1,
    title: "天地人",
    words: [
      { text: "天地", pinyin: "tiān dì", chars: "天地", category: "一类" },
      { text: "你我", pinyin: "nǐ wǒ", chars: "你我", category: "二类" },
      { text: "他人", pinyin: "tā rén", chars: "他人", category: "二类" },
      { text: "四方", pinyin: "sì fāng", chars: "四方", category: "四类" },
    ],
  },
  {
    grade: 1,
    unit: 1,
    number: 2,
    title: "金木水火土",
    words: [
      { text: "一二三", pinyin: "yī èr sān", chars: "一二三", category: "一类" },
      { text: "上下", pinyin: "shàng xià", chars: "上下", category: "一类" },
      { text: "金木", pinyin: "jīn mù", chars: "金木", category: "二类" },
      { text: "水火", pinyin: "shuǐ huǒ", chars: "水火", category: "二类" },
      { text: "土地", pinyin: "tǔ dì", chars: "土地", category: "一类" },
    ],
  },
  {
    grade: 1,
    unit: 2,
    number: 3,
    title: "秋天",
    words: [
      { text: "秋天", pinyin: "qiū tiān", chars: "秋天", category: "一类" },
      { text: "天气", pinyin: "tiān qì", chars: "天气", category: "一类" },
      { text: "树叶", pinyin: "shù yè", chars: "树叶", category: "二类" },
      { text: "大雁", pinyin: "dà yàn", chars: "大雁", category: "四类" },
      { text: "飞来", pinyin: "fēi lái", chars: "飞来", category: "一类" },
    ],
  },
  {
    grade: 2,
    unit: 1,
    number: 1,
    title: "小蝌蚪找妈妈",
    words: [
      { text: "池塘", pinyin: "chí táng", chars: "池塘", category: "一类" },
      { text: "脑袋", pinyin: "nǎo dai", chars: "脑袋", category: "二类" },
      { text: "灰色", pinyin: "huī sè", chars: "灰色", category: "一类" },
      { text: "游动", pinyin: "yóu dòng", chars: "游动", category: "一类" },
      { text: "捕食", pinyin: "bǔ shí", chars: "捕食", category: "四类" },
      { text: "阿姨", pinyin: "ā yí", chars: "阿姨", category: "二类" },
    ],
  },
  {
    grade: 2,
    unit: 1,
    number: 2,
    title: "我是什么",
    words: [
      { text: "天空", pinyin: "tiān kōng", chars: "天空", category: "一类" },
      { text: "傍晚", pinyin: "bàng wǎn", chars: "傍晚", category: "二类" },
      { text: "海洋", pinyin: "hǎi yáng", chars: "海洋", category: "一类" },
      { text: "工作", pinyin: "gōng zuò", chars: "工作", category: "一类" },
      { text: "灌溉", pinyin: "guàn gài", chars: "灌溉", category: "四类" },
      { text: "淹没", pinyin: "yān mò", chars: "淹没", category: "四类" },
    ],
  },
  {
    grade: 2,
    unit: 2,
    number: 3,
    title: "植物妈妈有办法",
    words: [
      { text: "办法", pinyin: "bàn fǎ", chars: "办法", category: "一类" },
      { text: "如果", pinyin: "rú guǒ", chars: "如果", category: "一类" },
      { text: "脚下", pinyin: "jiǎo xià", chars: "脚下", category: "二类" },
      { text: "娃娃", pinyin: "wá wa", chars: "娃", category: "二类" },
      { text: "知识", pinyin: "zhī shi", chars: "知识", category: "一类" },
      { text: "蒲公英", pinyin: "pú gōng yīng", chars: "蒲公英", category: "四类" },
    ],
  },
  {
    grade: 3,
    unit: 1,
    number: 1,
    title: "大青树下的小学",
    words: [
      { text: "早晨", pinyin: "zǎo chén", chars: "早晨", category: "一类" },
      { text: "鲜艳", pinyin: "xiān yàn", chars: "鲜艳", category: "一类" },
      { text: "服装", pinyin: "fú zhuāng", chars: "服装", category: "一类" },
      { text: "打扮", pinyin: "dǎ ban", chars: "打扮", category: "二类" },
      { text: "敬爱", pinyin: "jìng ài", chars: "敬爱", category: "一类" },
      { text: "飘扬", pinyin: "piāo yáng", chars: "飘扬", category: "二类" },
      { text: "摔跤", pinyin: "shuāi jiāo", chars: "摔跤", category: "四类" },
    ],
  },
  {
    grade: 3,
    unit: 1,
    number: 2,
    title: "花的学校",
    words: [
      { text: "荒野", pinyin: "huāng yě", chars: "荒野", category: "一类" },
      { text: "跳舞", pinyin: "tiào wǔ", chars: "跳舞", category: "一类" },
      { text: "狂欢", pinyin: "kuáng huān", chars: "狂欢", category: "二类" },
      { text: "放假", pinyin: "fàng jià", chars: "放假", category: "一类" },
      { text: "互相", pinyin: "hù xiāng", chars: "互相", category: "一类" },
      { text: "能够", pinyin: "néng gòu", chars: "能够", category: "二类" },
      { text: "衣裳", pinyin: "yī shang", chars: "裳", category: "四类" },
    ],
  },
  {
    grade: 3,
    unit: 2,
    number: 3,
    title: "铺满金色巴掌的水泥道",
    words: [
      { text: "水泥", pinyin: "shuǐ ní", chars: "水泥", category: "一类" },
      { text: "院墙", pinyin: "yuàn qiáng", chars: "院墙", category: "一类" },
      { text: "排列", pinyin: "pái liè", chars: "排列", category: "一类" },
      { text: "规则", pinyin: "guī zé", chars: "规则", category: "二类" },
      { text: "迟到", pinyin: "chí dào", chars: "迟到", category: "一类" },
      { text: "印着", pinyin: "yìn zhe", chars: "印", category: "二类" },
      { text: "凌乱", pinyin: "líng luàn", chars: "凌乱", category: "四类" },
    ],
  },
  {
    grade: 4,
    unit: 1,
    number: 1,
    title: "观潮",
    words: [
      { text: "奇观", pinyin: "qí guān", chars: "奇观", category: "一类" },
      { text: "农历", pinyin: "nóng lì", chars: "农历", category: "一类" },
      { text: "据说", pinyin: "jù shuō", chars: "据说", category: "一类" },
      { text: "宽阔", pinyin: "kuān kuò", chars: "宽阔", category: "二类" },
      { text: "滚动", pinyin: "gǔn dòng", chars: "滚动", category: "一类" },
      { text: "霎时", pinyin: "shà shí", chars: "霎时", category: "四类" },
      { text: "恢复", pinyin: "huī fù", chars: "恢复", category: "一类" },
    ],
  },
  {
    grade: 4,
    unit: 1,
    number: 2,
    title: "走月亮",
    words: [
      { text: "柔和", pinyin: "róu hé", chars: "柔和", category: "一类" },
      { text: "河床", pinyin: "hé chuáng", chars: "河床", category: "二类" },
      { text: "新鲜", pinyin: "xīn xiān", chars: "新鲜", category: "一类" },
      { text: "修补", pinyin: "xiū bǔ", chars: "修补", category: "一类" },
      { text: "满意", pinyin: "mǎn yì", chars: "满意", category: "一类" },
      { text: "风俗", pinyin: "fēng sú", chars: "风俗", category: "四类" },
    ],
  },
  {
    grade: 5,
    unit: 1,
    number: 1,
    title: "白鹭",
    words: [
      { text: "精巧", pinyin: "jīng qiǎo", chars: "精巧", category: "一类" },
      { text: "配合", pinyin: "pèi hé", chars: "配合", category: "一类" },
      { text: "适宜", pinyin: "shì yí", chars: "适宜", category: "一类" },
      { text: "生硬", pinyin: "shēng yìng", chars: "生硬", category: "二类" },
      { text: "寻常", pinyin: "xún cháng", chars: "寻常", category: "一类" },
      { text: "孤独", pinyin: "gū dú", chars: "孤独", category: "二类" },
      { text: "清澄", pinyin: "qīng chéng", chars: "澄", category: "四类" },
    ],
  },
  {
    grade: 5,
    unit: 1,
    number: 2,
    title: "落花生",
    words: [
      { text: "播种", pinyin: "bō zhòng", chars: "播种", category: "一类" },
      { text: "浇水", pinyin: "jiāo shuǐ", chars: "浇水", category: "一类" },
      { text: "吩咐", pinyin: "fēn fù", chars: "吩咐", category: "二类" },
      { text: "榨油", pinyin: "zhà yóu", chars: "榨油", category: "一类" },
      { text: "便宜", pinyin: "pián yi", chars: "便宜", category: "一类" },
      { text: "爱慕", pinyin: "ài mù", chars: "爱慕", category: "二类" },
      { text: "茅亭", pinyin: "máo tíng", chars: "茅亭", category: "四类" },
    ],
  },
];

const toWord = (lesson: RawLesson, rawWord: RawWord, index: number): DictationWord => {
  const lessonId = `g${lesson.grade}-u${lesson.unit}-l${lesson.number}`;
  const chars = Array.from(new Set(Array.from(rawWord.chars ?? rawWord.text).filter((char) => /\p{Script=Han}/u.test(char))));

  return {
    id: `${lessonId}-w${index + 1}`,
    text: rawWord.text,
    pinyin: rawWord.pinyin,
    chars,
    grade: lesson.grade,
    lessonId,
    lessonTitle: lesson.title,
    category: rawWord.category === "四类" ? "二类" : rawWord.category,
  };
};

export const seedLessons: Lesson[] = rawLessons.map((lesson) => {
  const lessonId = `g${lesson.grade}-u${lesson.unit}-l${lesson.number}`;

  return {
    id: lessonId,
    grade: lesson.grade,
    unit: lesson.unit,
    number: lesson.number,
    title: lesson.title,
    words: lesson.words.map((word, index) => toWord(lesson, word, index)),
  };
});

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

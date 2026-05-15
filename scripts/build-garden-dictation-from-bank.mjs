import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const characterBankDir = path.join(projectRoot, "textbook", "textbook-character-bank");
const outputDir = path.join(projectRoot, "textbook", "garden");

const chineseNumerals = new Map([
  ["一", 1],
  ["二", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
  ["十", 10],
]);

const dictationWordsByGarden = new Map(
  Object.entries({
    "g1-t2-garden-01": ["阴天", "雷电", "一阵", "冰冻", "夹子"],
    "g1-t2-garden-02": ["一辆", "马匹", "一册", "一支", "铅笔", "一棵", "书架"],
    "g1-t2-garden-04": ["眉毛", "鼻子", "嘴巴", "脖子", "手臂", "肚子", "小腿", "脚尖"],
    "g1-t2-garden-05": ["吃饭", "能力", "吃饱", "茶叶", "水泡", "轻声", "鞭炮"],
    "g1-t2-garden-06": ["木棍", "米汤", "扇子", "木椅", "萤火虫", "牵手", "织女", "北斗"],
    "g1-t2-garden-07": ["吵闹", "发胖", "几岁", "现在", "车票", "交通", "弹弓", "甘甜"],
    "g1-t2-garden-08": ["卫生", "牙刷", "梳头", "毛巾", "擦手", "香皂", "洗澡", "脸盆"],

    "g2-t1-garden-01": ["手套", "帽子", "登山", "鞋子", "裤子", "图画", "水壶", "帐篷", "手指", "指南针"],
    "g2-t1-garden-02": ["葡萄", "紫色", "狐狸", "笨鸟", "酸甜"],
    "g2-t1-garden-03": ["弹琴", "钢琴", "练习", "捏泥", "滚动", "铁环", "荡秋千", "滑梯"],
    "g2-t1-garden-04": ["南昌", "床铺", "空调", "硬座", "卧铺", "有限", "乘车", "售票"],
    "g2-t1-garden-05": ["锋利", "蜜蜂", "夜幕", "扫地", "扫墓", "爱慕", "抄写", "炒饭"],
    "g2-t1-garden-06": ["轿车", "救人", "摩托车", "防水", "渔船", "货车", "轮船", "科学", "思考"],
    "g2-t1-garden-07": ["沙滩", "椰子", "贝壳", "沙漠", "骆驼", "骏马", "悬崖"],
    "g2-t1-garden-08": ["狼狗", "猩猩", "小蛇", "白鹤", "鸽子", "羚羊", "蚯蚓", "螃蟹", "鱼虾", "春蚕"],

    "g2-t2-garden-01": ["凉亭", "咨询", "京剧", "管理", "宝贝", "宝塔", "餐厅"],
    "g2-t2-garden-02": ["工程", "魔术", "建筑", "表演", "营地", "服务", "判断", "饲养"],
    "g2-t2-garden-03": ["甜津津", "酸溜溜", "辣乎乎", "香喷喷", "油腻腻", "软绵绵", "脆生生", "硬邦邦"],
    "g2-t2-garden-04": ["陀螺", "毽子", "倒立", "不倒翁", "手枪", "橡皮", "木板", "遥控", "坦克"],
    "g2-t2-garden-05": ["厨房", "厕所", "车厢", "大厦", "洞穴", "石窟", "窟窿", "窑洞", "窄小"],
    "g2-t2-garden-06": ["博物馆", "饭馆", "游览", "技术", "体育", "研究", "口哨", "门诊"],
    "g2-t2-garden-07": ["扫地", "扫帚", "抹布", "拖地", "簸箕", "玻璃", "垃圾"],
    "g2-t2-garden-08": ["鱼钩", "铲子", "梅花", "柿子", "水源", "涨水", "火炬", "灿烂", "冲垮", "坟地"],

    "g3-t1-garden-01": ["申请", "介绍", "正宗", "乙方", "召集", "孝顺"],
    "g3-t1-garden-02": ["车轴", "基础", "阁楼", "佳节", "盲人", "唐朝"],
    "g3-t1-garden-03": ["蝌蚪", "飞蛾", "鲤鱼", "鲫鱼", "鲨鱼"],
    "g3-t1-garden-04": ["眨眼", "瞪眼", "瞅见", "眼眶", "目睹"],

    "g3-t2-garden-01": ["援助", "投掷", "投球", "打捞", "束缚", "缭乱", "联络", "资料", "贡献", "贷款"],
    "g3-t2-garden-02": ["税务", "档案", "咖啡", "阅读", "废品", "贸易"],
    "g3-t2-garden-03": ["旭日", "岛屿", "瞭望", "巡查", "缆车", "船锚"],
    "g3-t2-garden-04": ["咳嗽", "呕吐", "唠叨", "嘀咕", "谚语", "歌谣", "告诫", "辩论"],

    "g4-t1-garden-01": ["驻地", "钞票", "培养", "赌气", "媒体", "气氛", "账单", "祝贺", "樟树", "单杠", "狡猾"],
    "g4-t1-garden-02": ["花圃", "花卉", "花蕾", "花蕊", "玫瑰", "茉莉", "牡丹", "海棠"],
    "g4-t1-garden-03": ["韭菜", "芥菜", "芹菜", "大蒜", "辣椒", "莲藕", "红薯", "芋头"],
    "g4-t1-garden-04": ["提纲", "传授", "揍人", "琴键", "乐谱", "生锈", "泡沫", "砖头", "矿山", "综合", "氧气", "俱全"],

    "g4-t2-garden-03": ["肝脏", "麦秆", "俏皮", "陡峭", "哺育", "黄浦江", "沦落", "抡起", "涣散", "焕发", "俊俏", "严峻"],
    "g4-t2-garden-01": ["宾馆", "吉利", "咸菜", "兆头", "朝廷", "给予", "红肿", "台阶", "脚趾", "巩固", "政治", "浏览"],
    "g4-t2-garden-02": ["屈原", "陶渊明", "孟子", "杜甫", "姓韩", "治愈", "大禹", "锡纸", "仲夏", "姓龚"],
    "g4-t2-garden-04": ["和蔼", "慷慨", "贤惠", "亲戚", "惧怕", "彬彬有礼", "急躁", "焚烧"],
  }),
);

const extraAllowedCharsByGarden = new Map([
  // 人工指定：更贴近日常用词，但“弹”在字库中到二年级上册语文园地三才出现。
  ["g1-t2-garden-07", new Set(["弹"])],
]);

const termName = (term) => (term === 2 ? "下册" : "上册");
const termNumber = (term) => (term === "下册" ? 2 : 1);
const hanChars = (value) => [...value].filter((char) => /\p{Script=Han}/u.test(char));
const unique = (values) => [...new Set(values)];
const compactChars = (value) => hanChars(value).join("");
const markdownPath = (value) => value.split(path.sep).map(encodeURIComponent).join("/");

const bookInfoFromFileName = (fileName) => {
  const chineseName = fileName.match(/^([一二三四五六])年级(上册|下册)\.md$/u);
  if (chineseName) {
    return {
      grade: chineseNumerals.get(chineseName[1]),
      term: termNumber(chineseName[2]),
    };
  }

  const legacyName = fileName.match(/^g(\d)-t(\d)-.+\.md$/u);
  if (legacyName) {
    return {
      grade: Number(legacyName[1]),
      term: Number(legacyName[2]),
    };
  }

  return null;
};

const gardenIndexFromTitle = (title) => {
  const match = title.match(/语文园地([一二三四五六七八九十])/u);
  return match ? chineseNumerals.get(match[1]) : undefined;
};

const parseBankRows = () => {
  const files = readdirSync(characterBankDir)
    .map((name) => ({ name, book: bookInfoFromFileName(name) }))
    .filter((item) => item.book)
    .sort((left, right) => {
      return left.book.grade - right.book.grade || left.book.term - right.book.term;
    });

  const rows = [];
  for (const { name: fileName, book } of files) {
    const { grade, term } = book;
    const sourcePath = path.join(characterBankDir, fileName);
    const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/u);
    for (const line of lines) {
      if (!/^\|\s*\d+\s*\|/u.test(line)) {
        continue;
      }
      const columns = line.split("|").slice(1, -1).map((column) => column.trim());
      if (columns.length < 7) {
        continue;
      }
      const [sequence, section, title, type, recognitionChars, writingChars] = columns;
      rows.push({
        fileName,
        grade,
        term,
        sequence: Number(sequence),
        section,
        title,
        type,
        recognitionChars: recognitionChars === "（无）" ? "" : recognitionChars,
        writingChars: writingChars === "（无）" ? "" : writingChars,
      });
    }
  }
  return rows;
};

const gardenKey = (row) => {
  const gardenIndex = gardenIndexFromTitle(row.title);
  if (!gardenIndex) {
    throw new Error(`Cannot parse garden index from title: ${row.title}`);
  }
  return `g${row.grade}-t${row.term}-garden-${String(gardenIndex).padStart(2, "0")}`;
};

const validateGarden = (garden, words, learnedChars) => {
  const targetChars = unique(hanChars(`${garden.recognitionChars}${garden.writingChars}`));
  const coveredChars = new Set();
  const unknownPairs = [];
  const allowedChars = new Set([...learnedChars, ...(extraAllowedCharsByGarden.get(gardenKey(garden)) ?? [])]);
  for (const word of words) {
    for (const char of hanChars(word)) {
      if (!allowedChars.has(char)) {
        unknownPairs.push(`${word}:${char}`);
      }
      if (targetChars.includes(char)) {
        coveredChars.add(char);
      }
    }
  }

  const uncoveredChars = targetChars.filter((char) => !coveredChars.has(char));
  if (unknownPairs.length > 0 || uncoveredChars.length > 0) {
    throw new Error(
      [
        `${gardenKey(garden)} ${garden.title} validation failed.`,
        unknownPairs.length > 0 ? `Unknown chars: ${unknownPairs.join(", ")}` : "",
        uncoveredChars.length > 0 ? `Uncovered garden chars: ${uncoveredChars.join("")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
};

const gardenMarkdown = (garden, words) => {
  const targetChars = unique(hanChars(`${garden.recognitionChars}${garden.writingChars}`));
  const extraAllowedChars = [...(extraAllowedCharsByGarden.get(gardenKey(garden)) ?? [])];
  const wordsByChar = new Map(targetChars.map((char) => [char, []]));
  for (const word of words) {
    for (const char of unique(hanChars(word))) {
      if (wordsByChar.has(char)) {
        wordsByChar.get(char).push(word);
      }
    }
  }

  return [
    `# ${garden.grade}年级${termName(garden.term)} ${garden.title}`,
    "",
    `- 来源：[${garden.fileName}](../textbook-character-bank/${markdownPath(garden.fileName)})`,
    `- 序号：${garden.sequence}`,
    `- 园地生字：${targetChars.join(" ")}`,
    "- 选词原则：日常常用、意思明确；词语中的每个汉字默认均已在本园地或之前学过。",
    ...(extraAllowedChars.length > 0 ? [`- 人工例外：${extraAllowedChars.join("、")} 尚未在当前进度出现，用于保留指定词语。`] : []),
    "",
    "## 默写词语",
    "",
    words.map((word) => `- ${word}`).join("\n"),
    "",
    "## 生字配词",
    "",
    "| 生字 | 默写词语 |",
    "|---|---|",
    ...targetChars.map((char) => `| ${char} | ${unique(wordsByChar.get(char)).join("、")} |`),
    "",
  ].join("\n");
};

const writeReadme = (summaries) => {
  const markdown = [
    "# 语文园地默写词语",
    "",
    "本目录根据 `textbook/textbook-character-bank` 中的语文园地生字人工配词生成。每个默写词语尽量选择日常常用、意思明确的表达，并默认校验词语中的每个汉字都已在当前园地或此前课次学过；个别人工指定词以对应文件备注为准。",
    "",
    "| 年级 | 册别 | 序号 | 语文园地 | 园地生字 | 默写词语 | 文件 |",
    "|---:|---|---:|---|---|---|---|",
    ...summaries.map(
      (item) =>
        `| ${item.grade} | ${termName(item.term)} | ${item.sequence} | ${item.title} | ${item.chars.join("")} | ${item.words.join("、")} | [打开](${markdownPath(item.fileName)}) |`,
    ),
    "",
  ].join("\n");
  writeFileSync(path.join(outputDir, "README.md"), markdown);
};

const main = () => {
  if (!existsSync(characterBankDir)) {
    throw new Error(`Missing character bank directory: ${characterBankDir}`);
  }

  mkdirSync(outputDir, { recursive: true });
  for (const name of readdirSync(outputDir)) {
    if (name.endsWith(".md")) {
      unlinkSync(path.join(outputDir, name));
    }
  }

  const rows = parseBankRows();
  const learnedChars = new Set();
  const summaries = [];

  for (const row of rows) {
    for (const char of hanChars(`${row.recognitionChars}${row.writingChars}`)) {
      learnedChars.add(char);
    }
    if (row.type !== "garden") {
      continue;
    }

    const key = gardenKey(row);
    const words = dictationWordsByGarden.get(key);
    if (!words) {
      throw new Error(`Missing dictation words for ${key} ${row.title}`);
    }

    validateGarden(row, words, learnedChars);

    const fileName = `${key}-${row.title}.md`;
    writeFileSync(path.join(outputDir, fileName), gardenMarkdown(row, words));
    summaries.push({
      grade: row.grade,
      term: row.term,
      sequence: row.sequence,
      title: row.title,
      chars: unique(hanChars(`${row.recognitionChars}${row.writingChars}`)),
      words,
      fileName,
    });
  }

  const extraKeys = [...dictationWordsByGarden.keys()].filter((key) => !summaries.some((item) => item.fileName.startsWith(key)));
  if (extraKeys.length > 0) {
    throw new Error(`Dictation map contains unused gardens: ${extraKeys.join(", ")}`);
  }

  writeReadme(summaries);
  console.log(JSON.stringify({ outputDir, gardenFiles: summaries.length, words: summaries.reduce((sum, item) => sum + item.words.length, 0) }, null, 2));
};

main();

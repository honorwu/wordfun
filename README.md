# 字趣

一个面向上海小学五年制语文字词默写的网页应用。当前版本支持单个孩子使用，教材词库、配词库、学习进度和练习记录保存在 SQLite 中。

## 功能

- 选择当前学到的年级和课次，自动纳入一年级至当前课次的词语。
- 学生首页显示已学汉字、已复习汉字、掌握情况和今日练习。
- 家长后台显示当前已学字数、复习字数、待覆盖字数、错词和最近记录。
- 支持两种默写模式：本课词语会打印当前课全部配词；历史筛查会从已学旧课中高效抽词，尽量用更少词语覆盖更多已学字。
- 默写单自动写日期，拼音在米字格上方，可直接打印；核对时显示答案并标记错误。
- 保存练习结果后，应用会记录词语和生字掌握情况。
- 抽到识字表、写字表里的单个生字时，会优先使用同课词语表或 md 中补组词；古诗、文言文课保留原字词直接默写。
- 支持手动补充词语，包含一类、二类、四类字标记。
- 支持导出和导入本地备份。

## 运行

```bash
npm install
npm run dev
```

打开终端显示的 Vite 本地地址即可使用。`npm run dev` 会同时启动 API 服务和前端开发服务。启动前需要存在总字库数据库 `data/ziqu-catalog.sqlite`。

生产运行：

```bash
npm run build
npm run start
```

SQLite 默认拆成两个数据库，避免教材词库和学习记录互相干扰：

- `data/ziqu-catalog.sqlite`：总字库，只放教材课次、词条、汉字索引和配词候选。
- `data/ziqu-learning.sqlite`：学习库，只放当前进度、练习记录、词语/汉字统计、不合适词语标记和自定义补充数据。

可以通过 `ZIQU_CATALOG_DB_PATH` 指定总字库文件，通过 `ZIQU_LEARNING_DB_PATH` 指定学习库文件，通过 `ZIQU_DATA_DIR` 指定默认数据目录。

## 数据存储

- 总字库表：`source_files`、`lessons`、`characters`、`lesson_characters`、`words`、`word_characters`、`lesson_words`、`lesson_uncovered_characters`、`char_companion_words`、`classical_texts`、`classical_lines`。
- 学习库表：`students`、`progress`、`word_stats`、`char_stats`、`char_word_evidence`、`unsuitable_words`、`review_logs`、`review_log_words`、`review_log_chars`、`custom_lessons`、`custom_words`、`custom_word_chars`。

总字库 SQLite 是当前权威数据源；线上运行时由 Node API 读取 SQLite。学习记录只写入学习库，不写入总字库。

重新生成总字库 SQLite 数据库，默认保留学习库：

```bash
npm run rebuild:data
```

脚本会先删除再重建 `data/ziqu-catalog.sqlite`。总字库只从 `md/字词/*.md` 和 `md/古诗词/*.md` 读取数据，生成课次、字、词、字词关系、补组词、古诗词正文和来源文件指纹；学习库会补齐表结构并保留当前进度、练习记录，但会清空不合适词语标记，因为这类标记默认已经通过修正 md 数据源处理掉。两份数据库互不写入对方的数据。

如果需要连学习库也重置：

```bash
npm run rebuild:all
```

## 词库说明

内置词库来自 `md/` 目录下已经整理好的语文资料，当前导入 1-5 年级上下册字词表和古诗词资料。补组词只取自 `未覆盖生字组词` 列；课内配词只取自同一课的 `词语表`，不会从外部词频表或程序猜测中生成。

家长后台支持批量导入完整教材数据，格式为：

```csv
年级,单元,课次,课题,词语,拼音,生字,字类
1,1,1,天地人,天地,tiān dì,天地,一类
1,1,1,天地人,你我,nǐ wǒ,你我,二类
```

导入同年级、同单元、同课次的数据时，会覆盖对应的内置课。

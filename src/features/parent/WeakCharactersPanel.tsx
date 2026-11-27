import { Flame } from "lucide-react";
import { useMemo, useState } from "react";
import type { CharacterStat, DictationWord, LessonSummary } from "../../../shared/types.ts";
import { lessonOrder } from "../../../shared/domain/catalog.ts";
import { isMasteredChar } from "../../../shared/domain/reviewPolicy.ts";
import "./WeakCharactersPanel.css";

const defaultLimit = 20;

export function WeakCharactersPanel({ charStats, questions, lessons, selectedLesson, wrongCharsById }: {
  charStats: Readonly<Record<string, CharacterStat>>;
  questions: readonly DictationWord[];
  lessons: readonly LessonSummary[];
  selectedLesson: LessonSummary;
  wrongCharsById: ReadonlyMap<string, ReadonlySet<string>>;
}) {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [showAll, setShowAll] = useState(false);

  const { pending, all } = useMemo(() => {
    const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
    const courseOrder = lessonOrder(selectedLesson);
    const wordsByChar = new Map<string, Array<{ text: string; missed: boolean }>>();

    for (const question of questions) {
      const lesson = lessonsById.get(question.lessonId);
      if (!lesson || lesson.lessonKind === "classical_poetry" || lessonOrder(lesson) > courseOrder) continue;
      const missedChars = wrongCharsById.get(question.id);
      for (const char of new Set(Array.from(question.text))) {
        if (!charStats[char]?.mistakes) continue;
        const list = wordsByChar.get(char) ?? [];
        const missed = Boolean(missedChars?.has(char));
        const existing = list.find((entry) => entry.text === question.text);
        if (existing) {
          existing.missed ||= missed;
        } else {
          list.push({ text: question.text, missed });
        }
        wordsByChar.set(char, list);
      }
    }

    const entries = Object.entries(charStats)
      .filter(([, stat]) => stat.mistakes > 0)
      .map(([char, stat]) => {
        const mastered = isMasteredChar(stat);
        const examples = (wordsByChar.get(char) ?? [])
          .sort((a, b) => Number(b.missed) - Number(a.missed))
          .slice(0, 4);
        return { char, stat, mastered, examples };
      })
      .sort((a, b) =>
        Number(a.mastered) - Number(b.mastered)
        || b.stat.mistakes - a.stat.mistakes
        || (b.stat.lastMistakeAt ?? "").localeCompare(a.stat.lastMistakeAt ?? ""),
      );

    return {
      all: entries,
      pending: entries.filter((entry) => !entry.mastered),
    };
  }, [charStats, questions, lessons, selectedLesson, wrongCharsById]);

  if (all.length === 0) return null;

  const activeFilter = filter === "pending" && pending.length === 0 ? "all" : filter;
  const rows = activeFilter === "pending" ? pending : all;
  const visibleRows = showAll ? rows : rows.slice(0, defaultLimit);

  return (
    <section className="panel wide weak-chars-panel" aria-label="高频易错字榜">
      <div className="panel-title-row">
        <div className="panel-heading"><Flame size={20} aria-hidden="true" /><h2>高频易错字榜</h2></div>
        <div className="notebook-filters" role="group" aria-label="易错字范围">
          <button
            type="button"
            aria-pressed={activeFilter === "pending"}
            disabled={pending.length === 0}
            onClick={() => { setFilter("pending"); setShowAll(false); }}
          >
            仍待巩固 <b>{pending.length}</b>
          </button>
          <button
            type="button"
            aria-pressed={activeFilter === "all"}
            onClick={() => { setFilter("all"); setShowAll(false); }}
          >
            全部曾错字 <b>{all.length}</b>
          </button>
        </div>
      </div>
      <p className="notebook-guide">
        按单字聚合历史错字（跨课文去重），方便一眼发现孩子反复出错的字根或形近字；标红词语表示曾在该词中写错。
      </p>
      <ul className="weak-chars-grid">
        {visibleRows.map(({ char, stat, mastered, examples }) => (
          <li className={`weak-char-card ${mastered ? "is-mastered" : "is-pending"}`} key={char}>
            <div className="weak-char-head">
              <strong className="weak-char-glyph">{char}</strong>
              <span className={`weak-char-badge ${mastered ? "is-mastered" : "is-pending"}`}>
                {mastered ? "已掌握" : "待巩固"}
              </span>
            </div>
            <small className="weak-char-stats">错 {stat.mistakes} 次 · 练 {stat.attempts} 次</small>
            {examples.length > 0 && (
              <div className="weak-char-words">
                {examples.map(({ text, missed }) => (
                  <span className={missed ? "is-missed" : undefined} key={text}>{text}</span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {rows.length > defaultLimit && (
        <button className="show-more-logs" type="button" onClick={() => setShowAll((current) => !current)}>
          {showAll ? "收起列表" : `查看全部 ${rows.length} 个易错字`}
        </button>
      )}
    </section>
  );
}

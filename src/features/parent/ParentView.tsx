import { BarChart3, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardCheck, History, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppState, BookCharacterIndex, DictationWord, LessonSummary } from "../../../shared/types.ts";
import { isMasteredChar, isPendingScreeningMistakeChar } from "../../../shared/domain/index.ts";
import { learnedTextbookChars, textbookCharacterSet } from "../../../shared/domain/characterMastery.ts";
import type { MissedWrongCharCorrection } from "../../../shared/domain/reviews.ts";
import { WordIssuesPanel } from "../../components/WordIssues";
import { lessonLabel } from "../../lib/lessonPresentation";
import { localDateKey } from "../../lib/dates";
import { RecentReviewItem } from "./RecentReviewItem";
import { ReviewCorrectionPage } from "./ReviewCorrectionPage";
import { CharacterMasteryPanel } from "./CharacterMasteryPanel";

export interface ParentViewProps {
  characterBooks: BookCharacterIndex[];
  lessons: LessonSummary[];
  onSetIssueResolved: (id: string, resolved: boolean) => void;
  onSupplementReviewMistakes: (logId: string, corrections: MissedWrongCharCorrection[]) => number;
  selectedLesson: LessonSummary;
  state: AppState;
  wordById: Map<string, DictationWord>;
}

export function ParentView({
  characterBooks,
  lessons,
  onSetIssueResolved,
  onSupplementReviewMistakes,
  selectedLesson,
  state,
  wordById,
}: ParentViewProps) {
  const [showAllLogs, setShowAllLogs] = useState(false);
  const [activeCorrectionLogId, setActiveCorrectionLogId] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  useEffect(() => {
    const clearPrintReport = () => {
      delete document.documentElement.dataset.printReport;
    };
    window.addEventListener("afterprint", clearPrintReport);
    return () => {
      window.removeEventListener("afterprint", clearPrintReport);
      clearPrintReport();
    };
  }, []);

  const printReport = (report: "pending" | "history") => {
    document.documentElement.dataset.printReport = report;
    window.print();
  };

  const activeCorrectionLog = state.logs.find((log) => log.id === activeCorrectionLogId);
  if (activeCorrectionLog) {
    return (
      <ReviewCorrectionPage
        key={activeCorrectionLog.id}
        lessons={lessons}
        log={activeCorrectionLog}
        onBack={() => {
          setActiveCorrectionLogId(null);
          window.requestAnimationFrame(() => document.getElementById(`review-correction-open-${activeCorrectionLog.id}`)?.focus());
        }}
        onSupplementReviewMistakes={onSupplementReviewMistakes}
        wordById={wordById}
      />
    );
  }

  const textbookChars = textbookCharacterSet(characterBooks);
  const learnedChars = learnedTextbookChars(characterBooks, selectedLesson);
  const textbookStats = Object.entries(state.charStats).filter(([char]) => textbookChars.has(char));
  const pendingWrongChars = textbookStats
    .filter(([char, stat]) => learnedChars.has(char) && stat.mistakes > 0 && !isMasteredChar(stat))
    .sort((left, right) => right[1].mistakes - left[1].mistakes);
  const wrongWordsByText = new Map<string, { chars: Set<string>; lastMistakeAt: string }>();
  const charsWithWordEvidence = new Set<string>();
  for (const [char, stat] of pendingWrongChars) {
    for (const wordText of stat.wrongWordTexts ?? []) {
      if (!wordText.trim()) continue;
      const existing = wrongWordsByText.get(wordText) ?? { chars: new Set<string>(), lastMistakeAt: "" };
      existing.chars.add(char);
      charsWithWordEvidence.add(char);
      if ((stat.lastMistakeAt ?? "") > existing.lastMistakeAt) existing.lastMistakeAt = stat.lastMistakeAt ?? "";
      wrongWordsByText.set(wordText, existing);
    }
  }
  const wrongWords = [
    ...[...wrongWordsByText.entries()].map(([wordText, detail]) => ({
      key: `word-${wordText}`,
      wordText,
      ...detail,
      missingWordEvidence: false,
    })),
    ...pendingWrongChars
      .filter(([char]) => !charsWithWordEvidence.has(char))
      .map(([char, stat]) => ({
        key: `legacy-char-${char}`,
        wordText: char,
        chars: new Set([char]),
        lastMistakeAt: stat.lastMistakeAt ?? "",
        missingWordEvidence: true,
      })),
  ].sort((left, right) => right.lastMistakeAt.localeCompare(left.lastMistakeAt) || right.chars.size - left.chars.size);
  const missingWordEvidenceCount = wrongWords.filter((item) => item.missingWordEvidence).length;
  const historicalWrongWordsByText = new Map<string, { chars: Set<string>; pendingChars: Set<string> }>();
  const historicalWrongCharsWithoutWordEvidence: string[] = [];
  for (const [char, stat] of textbookStats) {
    if (stat.mistakes <= 0) continue;
    const wordTexts = Array.from(new Set((stat.wrongWordTexts ?? []).map((wordText) => wordText.trim()).filter(Boolean)));
    if (wordTexts.length === 0) historicalWrongCharsWithoutWordEvidence.push(char);
    for (const wordText of wordTexts) {
      const existing = historicalWrongWordsByText.get(wordText) ?? { chars: new Set<string>(), pendingChars: new Set<string>() };
      existing.chars.add(char);
      if (isPendingScreeningMistakeChar(stat)) existing.pendingChars.add(char);
      historicalWrongWordsByText.set(wordText, existing);
    }
  }
  const historicalWrongWords = [...historicalWrongWordsByText.entries()]
    .map(([wordText, detail]) => ({ wordText, ...detail }))
    .sort((left, right) => Number(right.pendingChars.size > 0) - Number(left.pendingChars.size > 0)
      || left.wordText.localeCompare(right.wordText, "zh-CN"));
  const historicalPendingWordCount = historicalWrongWords.filter((item) => item.pendingChars.size > 0).length;
  const historicalMasteredWordCount = historicalWrongWords.length - historicalPendingWordCount;
  const printDate = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date());
  const totalPracticeCount = state.logs.reduce((total, log) => total + log.wordIds.length, 0);
  const totalCheckinDays = new Set(state.logs.map((log) => localDateKey(new Date(log.date)))).size;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const recentCheckinDays = new Set(
    state.logs
      .filter((log) => {
        const practiceDay = new Date(log.date);
        practiceDay.setHours(0, 0, 0, 0);
        const dayDifference = (todayStart.getTime() - practiceDay.getTime()) / 86_400_000;
        return dayDifference >= 0 && dayDifference < 7;
      })
      .map((log) => localDateKey(new Date(log.date))),
  ).size;
  const totalCharacterAttempts = textbookStats.reduce((total, [, stat]) => total + stat.attempts, 0);
  const totalCharacterMistakes = textbookStats.reduce((total, [, stat]) => total + stat.mistakes, 0);
  const accuracy = totalCharacterAttempts > 0
    ? Math.max(0, Math.round(((totalCharacterAttempts - totalCharacterMistakes) / totalCharacterAttempts) * 100))
    : null;
  const activityByDate = state.logs.reduce<Map<string, number>>((result, log) => {
    const key = localDateKey(new Date(log.date));
    result.set(key, (result.get(key) ?? 0) + log.wordIds.length);
    return result;
  }, new Map());
  const calendarYear = calendarMonth.getFullYear();
  const calendarMonthIndex = calendarMonth.getMonth();
  const calendarOffset = (new Date(calendarYear, calendarMonthIndex, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(calendarYear, calendarMonthIndex + 1, 0).getDate();
  const calendarDays = Array.from({ length: calendarOffset + daysInMonth }, (_, index) =>
    index < calendarOffset ? null : new Date(calendarYear, calendarMonthIndex, index - calendarOffset + 1),
  );
  while (calendarDays.length % 7 !== 0) calendarDays.push(null);
  const checkedDays = calendarDays.filter((date) => date && activityByDate.has(localDateKey(date))).length;

  return (
    <section className="parent-main">
      <div className="parent-title">
        <h1>学习进度</h1>
        <div className="current-course"><span>当前学习进度</span><strong>{lessonLabel(selectedLesson)}</strong></div>
      </div>

      <div className="parent-grid">
        <CharacterMasteryPanel books={characterBooks} progress={selectedLesson} charStats={state.charStats} />

        <section className="panel overview-panel">
          <div className="panel-heading"><BarChart3 size={20} /><h2>学习概览</h2></div>
          <div className="overview-stats">
            <div className="overview-stat"><strong>{totalPracticeCount}</strong><span>累计默写（项）</span></div>
            <div className="overview-stat"><strong>{totalCheckinDays}</strong><span>累计打卡（天）</span></div>
            <div className="overview-stat"><strong>{recentCheckinDays}</strong><span>近 7 天打卡</span></div>
            <div className="overview-stat"><strong>{accuracy === null ? "—" : `${accuracy}%`}</strong><span>字准确率（含初始状态）</span></div>
            <div className="overview-stat attention"><strong>{pendingWrongChars.length}</strong><span>待巩固错字</span></div>
            <div className="overview-stat history-total"><strong>{historicalWrongWords.length}</strong><span>历史错词</span></div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading"><History size={20} /><h2>最近默写</h2></div>
          <div className="recent-list">
            {state.logs.length === 0 ? <p className="muted">还没有默写记录。</p> : (showAllLogs ? state.logs : state.logs.slice(0, 6)).map((log) => (
              <RecentReviewItem
                key={log.id}
                lessons={lessons}
                log={log}
                onOpenCorrection={() => {
                  setActiveCorrectionLogId(log.id);
                  window.scrollTo({ top: 0, behavior: "auto" });
                }}
                wordById={wordById}
              />
            ))}
            {state.logs.length > 6 ? (
              <button
                aria-expanded={showAllLogs}
                className="show-more-logs"
                type="button"
                onClick={() => setShowAllLogs((current) => !current)}
              >
                {showAllLogs ? "收起较早记录" : `查看全部 ${state.logs.length} 条记录`}
              </button>
            ) : null}
          </div>
        </section>

        <WordIssuesPanel issues={state.wordIssues} onSetResolved={onSetIssueResolved} />

        <section className="panel wide calendar-panel">
          <div className="calendar-heading">
            <div className="panel-heading"><CalendarDays size={20} /><h2>打卡日历</h2></div>
            <div className="calendar-nav">
              <button type="button" onClick={() => setCalendarMonth(new Date(calendarYear, calendarMonthIndex - 1, 1))} aria-label="上一个月"><ChevronLeft size={18} /></button>
              <strong>{calendarYear} 年 {calendarMonthIndex + 1} 月</strong>
              <button type="button" onClick={() => setCalendarMonth(new Date(calendarYear, calendarMonthIndex + 1, 1))} aria-label="下一个月"><ChevronRight size={18} /></button>
            </div>
          </div>
          <div className="calendar-summary">本月已打卡 <strong>{checkedDays}</strong> 天</div>
          <div className="calendar-grid calendar-weekdays" aria-hidden="true">
            {["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>周{day}</span>)}
          </div>
          <div className="calendar-grid">
            {calendarDays.map((date, index) => {
              if (!date) return <span className="calendar-day blank" key={`blank-${index}`} />;
              const key = localDateKey(date);
              const practiceCount = activityByDate.get(key) ?? 0;
              const isToday = key === localDateKey(new Date());
              return (
                <div className={`calendar-day ${practiceCount > 0 ? "checked" : ""} ${isToday ? "today" : ""}`} key={key}>
                  <b>{date.getDate()}</b>
                  {practiceCount > 0 ? <><span><Check size={13} />已打卡</span><small>{practiceCount} 项</small></> : <small>{isToday ? "今天" : ""}</small>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel wide pending-words-panel printable-report" data-print-section="pending">
          <div className="panel-title-row">
            <div className="panel-heading"><ClipboardCheck size={20} /><h2>待巩固错字</h2></div>
            <button className="print-report-button" type="button" onClick={() => printReport("pending")} disabled={wrongWords.length === 0}>
              <Printer size={16} />打印待巩固
            </button>
          </div>
          <p className="print-metadata">待巩固错字清单 · 打印日期：{printDate}</p>
          {wrongWords.length === 0 ? <p className="muted">目前没有待巩固的错字。新的批改结果会自动记在这里。</p> : (
            <>
              <p className="panel-note">
                共 {pendingWrongChars.length} 个待巩固错字，完整列出 {wrongWordsByText.size} 个相关词语；同一个字可能出现在多个词中。
                {missingWordEvidenceCount > 0 ? `另有 ${missingWordEvidenceCount} 个字仅有逐字状态，已单独列出。` : ""}
              </p>
              <div className="wrong-word-list">{wrongWords.map(({ chars, key, missingWordEvidence, wordText }) => {
                const isLongText = Array.from(wordText).filter((char) => /\p{Script=Han}/u.test(char)).length > 10;
                const displayText = isLongText ? `《${wordText.split("\n")[0]}》全文` : wordText;
                return (
                  <div className={`wrong-word-item ${missingWordEvidence ? "missing-evidence" : ""}`} key={key}>
                    <strong className="wrong-word-text">
                      {Array.from(displayText).map((char, index) => (
                        <span className={chars.has(char) ? "wrong-character" : ""} key={`${char}-${index}`}>{char}</span>
                      ))}
                    </strong>
                    <small>{missingWordEvidence ? "仅有逐字状态 · " : "错字："}{[...chars].map((char) => <b key={char}>{char}</b>)}</small>
                  </div>
                );
              })}</div>
            </>
          )}
        </section>

        <section className="panel wide history-words-panel printable-report" data-print-section="history">
          <div className="panel-title-row">
            <div className="panel-heading"><History size={20} /><h2>历史错词</h2></div>
            <button className="print-report-button" type="button" onClick={() => printReport("history")} disabled={historicalWrongWords.length === 0}>
              <Printer size={16} />打印历史错词
            </button>
          </div>
          <p className="print-metadata">历史错词清单 · 打印日期：{printDate}</p>
          {historicalWrongWords.length === 0 ? <p className="muted">还没有历史错词记录。</p> : (
            <>
              <p className="panel-note">
                历史上共错过 {historicalWrongWords.length} 个词语，其中 {historicalPendingWordCount} 个仍待巩固，{historicalMasteredWordCount} 个已经掌握。历史错词掌握后仍会保留在这里。
                {historicalWrongCharsWithoutWordEvidence.length > 0 ? `另有 ${historicalWrongCharsWithoutWordEvidence.length} 个旧错字未保留原词，未计入词语总数。` : ""}
              </p>
              <div className="history-word-table-wrap">
                <table className="history-word-table">
                  <thead>
                    <tr><th scope="col">序号</th><th scope="col">历史错词</th><th scope="col">曾错字</th><th scope="col">当前状态</th></tr>
                  </thead>
                  <tbody>
                    {historicalWrongWords.map(({ chars, pendingChars, wordText }, index) => {
                      const isLongText = Array.from(wordText).filter((char) => /\p{Script=Han}/u.test(char)).length > 10;
                      const displayText = isLongText ? `《${wordText.split("\n")[0]}》全文` : wordText;
                      return (
                        <tr key={wordText}>
                          <td className="history-word-index">{index + 1}</td>
                          <td>
                            <strong className="history-word-text">
                              {Array.from(displayText).map((char, charIndex) => (
                                <span className={chars.has(char) ? "wrong-character" : ""} key={`${char}-${charIndex}`}>{char}</span>
                              ))}
                            </strong>
                          </td>
                          <td><span className="historical-wrong-chars">{[...chars].map((char) => <b key={char}>{char}</b>)}</span></td>
                          <td>
                            <span className={`mastery-status ${pendingChars.size > 0 ? "pending" : "mastered"}`}>
                              {pendingChars.size > 0 ? `待巩固 ${pendingChars.size} 字` : "已掌握"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

      </div>
    </section>
  );
}

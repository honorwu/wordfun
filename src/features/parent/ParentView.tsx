import { BarChart3, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardCheck, History, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppState, DictationWord, LessonSummary, QuestionCarryover } from "../../../shared/types.ts";
import { lessonOrder } from "../../../shared/domain/catalog.ts";
import { isMasteredQuestion } from "../../../shared/domain/reviewPolicy.ts";
import type { MissedWrongCharCorrection } from "../../../shared/domain/reviews.ts";
import { WordIssuesPanel } from "../../components/WordIssues";
import { lessonLabel } from "../../lib/lessonPresentation";
import { localDateKey } from "../../lib/dates";
import { RecentReviewItem } from "./RecentReviewItem";
import { ReviewCorrectionPage } from "./ReviewCorrectionPage";
import { MarkedQuestionText, QuestionMasteryPanel } from "./QuestionMasteryPanel";

export interface ParentViewProps {
  inheritedMasteredChars: string[];
  lessons: LessonSummary[];
  onSetIssueResolved: (id: string, resolved: boolean) => void;
  onSupplementReviewMistakes: (logId: string, corrections: MissedWrongCharCorrection[]) => number;
  questions: DictationWord[];
  reviewCarryover: Record<string, QuestionCarryover>;
  selectedLesson: LessonSummary;
  state: AppState;
  wordById: Map<string, DictationWord>;
}

export function ParentView({
  inheritedMasteredChars,
  lessons,
  onSetIssueResolved,
  onSupplementReviewMistakes,
  questions,
  reviewCarryover,
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

  const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const wrongCharsById = new Map<string, Set<string>>();
  for (const log of state.logs) {
    const snapshots = new Map((log.reviewedItems ?? []).map((item) => [item.wordId, item.wordText]));
    for (const { wordId, char } of log.wrongChars ?? []) {
      const question = questionsById.get(wordId);
      const snapshot = snapshots.get(wordId);
      if (!question?.text.includes(char) || (snapshot && snapshot !== question.text)) continue;
      const wrongChars = wrongCharsById.get(wordId) ?? new Set<string>();
      wrongChars.add(char);
      wrongCharsById.set(wordId, wrongChars);
    }
  }

  const scoredQuestions = questions.flatMap((question) => {
    const stat = state.wordStats[question.id];
    const lesson = lessonsById.get(question.lessonId);
    return stat && lesson ? [{ question, lesson, stat }] : [];
  });
  const historicalWrongQuestions = scoredQuestions.filter(({ stat }) => stat.mistakes > 0)
    .map((item) => ({ ...item, mastered: isMasteredQuestion(item.stat) }))
    .sort((left, right) => Number(left.mastered) - Number(right.mastered)
      || (right.stat.lastMistakeAt ?? "").localeCompare(left.stat.lastMistakeAt ?? ""));
  const pendingWrongQuestions = historicalWrongQuestions.filter(({ lesson, mastered }) =>
    !mastered && lessonOrder(lesson) <= lessonOrder(selectedLesson),
  );
  const historicalMasteredCount = historicalWrongQuestions.filter(({ mastered }) => mastered).length;
  const displayQuestion = (question: DictationWord, lesson: LessonSummary) => lesson.lessonKind === "classical_poetry"
    ? `《${question.lessonTitle}》全文`
    : question.text;
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
  const totalQuestionAttempts = scoredQuestions.reduce((total, { stat }) => total + stat.attempts, 0);
  const totalQuestionMistakes = scoredQuestions.reduce((total, { stat }) => total + stat.mistakes, 0);
  const accuracy = totalQuestionAttempts > 0
    ? Math.max(0, Math.round(((totalQuestionAttempts - totalQuestionMistakes) / totalQuestionAttempts) * 100))
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
        <QuestionMasteryPanel
          charStats={state.charStats}
          inheritedMasteredChars={inheritedMasteredChars}
          lessons={lessons}
          progress={selectedLesson}
          questions={questions}
          reviewCarryover={reviewCarryover}
          wordStats={state.wordStats}
          wrongCharsById={wrongCharsById}
        />

        <section className="panel overview-panel">
          <div className="panel-heading"><BarChart3 size={20} /><h2>学习概览</h2></div>
          <div className="overview-stats">
            <div className="overview-stat"><strong>{totalPracticeCount}</strong><span>累计默写（项）</span></div>
            <div className="overview-stat"><strong>{totalCheckinDays}</strong><span>累计打卡（天）</span></div>
            <div className="overview-stat"><strong>{recentCheckinDays}</strong><span>近 7 天打卡</span></div>
            <div className="overview-stat"><strong>{accuracy === null ? "—" : `${accuracy}%`}</strong><span>整题正确率</span></div>
            <div className="overview-stat attention"><strong>{pendingWrongQuestions.length}</strong><span>待巩固错题</span></div>
            <div className="overview-stat history-total"><strong>{historicalWrongQuestions.length}</strong><span>历史错题</span></div>
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
            <div className="panel-heading"><ClipboardCheck size={20} /><h2>待巩固错题</h2></div>
            <button className="print-report-button" type="button" onClick={() => printReport("pending")} disabled={pendingWrongQuestions.length === 0}>
              <Printer size={16} />打印待巩固
            </button>
          </div>
          <p className="print-metadata">待巩固错题清单 · {printDate}</p>
          {pendingWrongQuestions.length === 0 ? <p className="muted">目前没有待巩固的错题。</p> : (
            <>
              <p className="panel-note">共 {pendingWrongQuestions.length} 道待巩固错题。下划线标出考察字，红字标出有记录的错字。</p>
              <div className="wrong-word-list">{pendingWrongQuestions.map(({ question, lesson }) => {
                const wrongChars = wrongCharsById.get(question.id);
                return (
                  <div className="wrong-word-item" key={question.id}>
                    <strong className="wrong-word-text">
                      <MarkedQuestionText text={displayQuestion(question, lesson)} targets={question.chars} wrongChars={wrongChars} />
                    </strong>
                    <small>{lessonLabel(lesson)}</small>
                    <small>{wrongChars?.size ? <>曾错字 {[...wrongChars].map((char) => <b key={char}>{char}</b>)}</> : "暂无错字明细"}</small>
                  </div>
                );
              })}</div>
            </>
          )}
        </section>

        <section className="panel wide history-words-panel printable-report" data-print-section="history">
          <div className="panel-title-row">
            <div className="panel-heading"><History size={20} /><h2>历史错题</h2></div>
            <button className="print-report-button" type="button" onClick={() => printReport("history")} disabled={historicalWrongQuestions.length === 0}>
              <Printer size={16} />打印历史错题
            </button>
          </div>
          <p className="print-metadata">历史错题清单 · {printDate}</p>
          {historicalWrongQuestions.length === 0 ? <p className="muted">还没有历史错题记录。</p> : (
            <>
              <p className="panel-note">
                共 {historicalWrongQuestions.length} 道历史错题，其中 {historicalWrongQuestions.length - historicalMasteredCount} 道待巩固，{historicalMasteredCount} 道已掌握。
              </p>
              <div className="history-word-table-wrap">
                <table className="history-word-table">
                  <thead>
                    <tr><th scope="col">题目</th><th scope="col">课次</th><th scope="col">曾错字</th><th scope="col">当前状态</th></tr>
                  </thead>
                  <tbody>
                    {historicalWrongQuestions.map(({ question, lesson, mastered }) => {
                      const wrongChars = wrongCharsById.get(question.id);
                      return (
                        <tr key={question.id}>
                          <td>
                            <strong className="history-word-text">
                              <MarkedQuestionText text={displayQuestion(question, lesson)} targets={question.chars} wrongChars={wrongChars} />
                            </strong>
                          </td>
                          <td>{lessonLabel(lesson)}</td>
                          <td>{wrongChars?.size
                            ? <span className="historical-wrong-chars">{[...wrongChars].map((char) => <b key={char}>{char}</b>)}</span>
                            : "暂无明细"}</td>
                          <td>
                            <span className={`mastery-status ${mastered ? "mastered" : "pending"}`}>
                              {mastered ? "已掌握" : "待巩固"}
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

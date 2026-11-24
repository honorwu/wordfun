import { History } from "lucide-react";
import { useState } from "react";
import type { DictationWord, LessonSummary, ReviewLog, WordStat } from "../../../shared/types.ts";
import { localDateKey } from "../../lib/dates";
import { CheckinCalendar } from "./CheckinCalendar";
import { RecentReviewItem } from "./RecentReviewItem";

export function PracticeRecords({ logs, activityByDate, correctionNow, lessons, wordById, scoredQuestions, onOpenCorrection }: {
  logs: ReviewLog[];
  activityByDate: ReadonlyMap<string, number>;
  correctionNow: number;
  lessons: LessonSummary[];
  wordById: Map<string, DictationWord>;
  scoredQuestions: { stat: WordStat }[];
  onOpenCorrection: (id: string) => void;
}) {
  const [showAllLogs, setShowAllLogs] = useState(false);
  const totalQuestionAttempts = scoredQuestions.reduce((total, { stat }) => total + stat.attempts, 0);
  const totalQuestionMistakes = scoredQuestions.reduce((total, { stat }) => total + stat.mistakes, 0);
  const accuracy = totalQuestionAttempts > 0
    ? Math.max(0, Math.round(((totalQuestionAttempts - totalQuestionMistakes) / totalQuestionAttempts) * 100))
    : null;
  const totalPracticeCount = Array.from(activityByDate.values()).reduce((sum, count) => sum + count, 0);
  const today = new Date();
  const todayKey = localDateKey(today);
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  const firstDayKey = localDateKey(weekStart);
  const recentCheckinDays = Array.from(activityByDate.keys()).filter((day) => day >= firstDayKey && day <= todayKey).length;
  return (
    <div className="practice-records">
      <dl className="activity-summary panel" aria-label="默写统计">
        <div><dt>累计默写</dt><dd>{totalPracticeCount}<small>题次</small></dd></div>
        <div title={`当前题库共 ${totalQuestionAttempts} 次整题判定`}><dt>整题正确率</dt><dd>{accuracy === null ? "—" : `${accuracy}%`}</dd></div>
        <div><dt>累计打卡</dt><dd>{activityByDate.size}<small>天</small></dd></div>
        <div><dt>近 7 天打卡</dt><dd>{recentCheckinDays}<small>天</small></dd></div>
      </dl>
      <div className="records-grid">
        <section className="panel">
          <div className="panel-heading"><History size={20} /><h2 id="practice-records-heading" tabIndex={-1}>最近默写</h2></div>
          {logs.length > 0 && <p className="muted">默写完成后 3 天（72 小时）内可补记错字。</p>}
          <div className="recent-list">
            {logs.length === 0 ? <p className="muted">还没有默写记录。</p> : (showAllLogs ? logs : logs.slice(0, 6)).map((log) => (
              <RecentReviewItem
                key={log.id}
              correctionNow={correctionNow}
                lessons={lessons}
                log={log}
                onOpenCorrection={() => onOpenCorrection(log.id)}
                wordById={wordById}
              />
            ))}
            {logs.length > 6 ? (
              <button
                aria-expanded={showAllLogs}
                className="show-more-logs"
                type="button"
                onClick={() => setShowAllLogs((current) => !current)}
              >
                {showAllLogs ? "收起较早记录" : `查看全部 ${logs.length} 条记录`}
              </button>
            ) : null}
          </div>
        </section>

        <CheckinCalendar activityByDate={activityByDate} />
      </div>
    </div>
  );
}

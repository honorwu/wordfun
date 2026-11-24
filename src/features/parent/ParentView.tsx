import { BookOpenCheck, ChartNoAxesCombined, Flag, History } from "lucide-react";
import { useState } from "react";
import type { AppState, DictationWord, LessonSummary, QuestionCarryover } from "../../../shared/types.ts";
import type { MissedWrongCharCorrection } from "../../../shared/domain/reviews.ts";
import { WordIssuesPanel } from "../../components/WordIssues";
import { lessonLabel } from "../../lib/lessonPresentation";
import { localDateKey } from "../../lib/dates";
import { CheckinCalendar } from "./CheckinCalendar";
import { MistakeNotebook } from "./MistakeNotebook";
import { PracticeRecords } from "./PracticeRecords";
import { QuestionMasteryPanel } from "./QuestionMasteryPanel";
import { ReviewCorrectionPage } from "./ReviewCorrectionPage";

const sections = [
  { id: "progress", label: "学习进度", icon: ChartNoAxesCombined },
  { id: "mistakes", label: "错题本", icon: BookOpenCheck },
  { id: "records", label: "默写记录", icon: History },
  { id: "issues", label: "词库问题", icon: Flag },
] as const;

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
  const [section, setSection] = useState<typeof sections[number]["id"]>("progress");
  const [activeCorrectionLogId, setActiveCorrectionLogId] = useState<string | null>(null);
  const activeCorrectionLog = state.logs.find((log) => log.id === activeCorrectionLogId);
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

  const activityByDate = state.logs.reduce<Map<string, number>>((result, log) => {
    const key = localDateKey(new Date(log.date));
    result.set(key, (result.get(key) ?? 0) + log.wordIds.length);
    return result;
  }, new Map());

  const scoredQuestions = questions.flatMap((question) => {
    const stat = state.wordStats[question.id];
    const lesson = lessonsById.get(question.lessonId);
    return stat && lesson ? [{ question, lesson, stat }] : [];
  });

  return (
    <>
      {activeCorrectionLog && (
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
      )}
      <section className="parent-main" hidden={Boolean(activeCorrectionLog)}>
        <div className="parent-title">
          <h1>家长看板</h1>
          <div className="current-course"><span>当前课次</span><strong>{lessonLabel(selectedLesson)}</strong></div>
        </div>
        <nav className="parent-nav" aria-label="家长看板分区">
          {sections.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id} aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}>
              <Icon size={17} aria-hidden="true" />{label}
            </button>
          ))}
        </nav>

        {section === "progress" && (
          <div className="parent-progress-grid">
            <CheckinCalendar activityByDate={activityByDate} />
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
          </div>
        )}
        {section === "mistakes" && (
          <MistakeNotebook scoredQuestions={scoredQuestions} selectedLesson={selectedLesson} wrongCharsById={wrongCharsById} />
        )}
        {section === "records" && (
          <PracticeRecords
            logs={state.logs}
            activityByDate={activityByDate}
            lessons={lessons}
            wordById={wordById}
            scoredQuestions={scoredQuestions}
            onOpenCorrection={(id) => {
              setActiveCorrectionLogId(id);
              window.scrollTo({ top: 0, behavior: "auto" });
            }}
          />
        )}
        {section === "issues" && <WordIssuesPanel issues={state.wordIssues} onSetResolved={onSetIssueResolved} />}
      </section>
    </>
  );
}

import { BookOpenCheck, ChartNoAxesCombined, Flag, History } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppState, DictationWord, LessonSummary, QuestionCarryover } from "../../../shared/types.ts";
import type { MissedWrongCharCorrection } from "../../../shared/domain/reviews.ts";
import { canSupplementReview, isQuestionCarryoverActive, reviewCorrectionWindowMs } from "../../../shared/domain/reviewPolicy.ts";
import { WordIssuesPanel } from "../../components/WordIssues";
import { lessonLabel } from "../../lib/lessonPresentation";
import { localDateKey } from "../../lib/dates";
import { CheckinCalendar } from "./CheckinCalendar";
import { MistakeNotebook } from "./MistakeNotebook";
import { PracticeRecords } from "./PracticeRecords";
import { QuestionMasteryPanel } from "./QuestionMasteryPanel";
import { ReviewCorrectionPage } from "./ReviewCorrectionPage";
import { WeakCharactersPanel } from "./WeakCharactersPanel";

const sections = [
  { id: "progress", label: "学习进度", icon: ChartNoAxesCombined },
  { id: "mistakes", label: "错题本", icon: BookOpenCheck },
  { id: "records", label: "默写记录", icon: History },
  { id: "issues", label: "词库问题", icon: Flag },
] as const;

export interface ParentViewProps {
  lessons: LessonSummary[];
  onSetIssueResolved: (id: string, resolved: boolean) => void;
  onSupplementReviewMistakes: (logId: string, corrections: MissedWrongCharCorrection[]) => Promise<number>;
  questions: DictationWord[];
  reviewCarryover: Record<string, QuestionCarryover>;
  selectedLesson: LessonSummary;
  state: AppState;
  wordById: Map<string, DictationWord>;
}

export function ParentView({
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
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [correctionNow, setCorrectionNow] = useState(Date.now);
  const activeReview = useMemo(() => state.logs.find((log) => log.id === activeReviewId), [state.logs, activeReviewId]);
  const lessonsById = useMemo(() => new Map(lessons.map((lesson) => [lesson.id, lesson])), [lessons]);
  const questionsById = useMemo(() => new Map(questions.map((question) => [question.id, question])), [questions]);
  const wrongCharsById = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const log of state.logs) {
      const snapshots = new Map((log.reviewedItems ?? []).map((item) => [item.wordId, item.wordText]));
      for (const { wordId, char } of log.wrongChars ?? []) {
        const question = questionsById.get(wordId);
        const snapshot = snapshots.get(wordId);
        if (!question?.text.includes(char) || (snapshot && snapshot !== question.text)) continue;
        const wrongChars = map.get(wordId) ?? new Set<string>();
        wrongChars.add(char);
        map.set(wordId, wrongChars);
      }
    }
    return map;
  }, [state.logs, questionsById]);

  const activityByDate = useMemo(() => state.logs.reduce<Map<string, number>>((result, log) => {
    const key = localDateKey(new Date(log.date));
    result.set(key, (result.get(key) ?? 0) + log.wordIds.length);
    return result;
  }, new Map()), [state.logs]);

  const scoredQuestions = useMemo(() => questions.flatMap((question) => {
    const stat = state.wordStats[question.id];
    const lesson = lessonsById.get(question.lessonId);
    return stat && lesson ? [{ question, lesson, stat }] : [];
  }), [questions, state.wordStats, lessonsById]);

  const carriedQuestions = useMemo(() => questions.flatMap((question) => {
    const lesson = lessonsById.get(question.lessonId);
    return lesson && isQuestionCarryoverActive(state.wordStats[question.id], reviewCarryover[question.id])
      ? [{ question, lesson }]
      : [];
  }), [questions, lessonsById, state.wordStats, reviewCarryover]);

  useEffect(() => {
    if (section !== "records") return;
    const refreshCorrectionTime = () => setCorrectionNow(Date.now());
    let nextDeadline = Number.POSITIVE_INFINITY;
    for (const log of state.logs) {
      if (!canSupplementReview(log, correctionNow)) continue;
      const deadline = Date.parse(log.date) + reviewCorrectionWindowMs;
      nextDeadline = Math.min(nextDeadline, deadline);
    }
    const timeout = Number.isFinite(nextDeadline)
      ? window.setTimeout(refreshCorrectionTime, Math.max(0, nextDeadline - Date.now() + 1))
      : undefined;
    document.addEventListener("visibilitychange", refreshCorrectionTime);
    window.addEventListener("focus", refreshCorrectionTime);
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", refreshCorrectionTime);
      window.removeEventListener("focus", refreshCorrectionTime);
    };
  }, [correctionNow, section, state.logs]);

  return (
    <>
      {activeReview && (
        <ReviewCorrectionPage
          key={activeReview.id}
          correctionNow={correctionNow}
          lessons={lessons}
          log={activeReview}
          onBack={() => {
            setCorrectionNow(Date.now());
            setActiveReviewId(null);
            window.requestAnimationFrame(() => {
              const focusTarget = document.getElementById(`review-open-${activeReview.id}`)
                ?? document.getElementById("practice-records-heading");
              focusTarget?.focus();
            });
          }}
          onSupplementReviewMistakes={onSupplementReviewMistakes}
          wordById={wordById}
        />
      )}
      <section className="parent-main" hidden={Boolean(activeReview)}>
        <div className="parent-title">
          <h1>家长看板</h1>
          <div className="current-course"><span>当前课次</span><strong>{lessonLabel(selectedLesson)}</strong></div>
        </div>
        <nav className="parent-nav" aria-label="家长看板分区">
          {sections.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id} aria-current={section === id ? "page" : undefined} onClick={() => {
              if (id === "records") setCorrectionNow(Date.now());
              setSection(id);
            }}>
              <Icon size={17} aria-hidden="true" />{label}
            </button>
          ))}
        </nav>

        {section === "progress" && (
          <div className="parent-progress-grid">
            <CheckinCalendar activityByDate={activityByDate} />
            <QuestionMasteryPanel
              charStats={state.charStats}
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
          <>
            <WeakCharactersPanel
              charStats={state.charStats}
              lessons={lessons}
              questions={questions}
              selectedLesson={selectedLesson}
              wrongCharsById={wrongCharsById}
            />
            <MistakeNotebook
              carriedQuestions={carriedQuestions}
              scoredQuestions={scoredQuestions}
              selectedLesson={selectedLesson}
              wrongCharsById={wrongCharsById}
            />
          </>
        )}
        {section === "records" && (
          <PracticeRecords
            logs={state.logs}
            activityByDate={activityByDate}
            correctionNow={correctionNow}
            lessons={lessons}
            wordById={wordById}
            scoredQuestions={scoredQuestions}
            onOpenReview={(id) => {
              setCorrectionNow(Date.now());
              setActiveReviewId(id);
              window.scrollTo({ top: 0, behavior: "auto" });
            }}
          />
        )}
        {section === "issues" && <WordIssuesPanel issues={state.wordIssues} onSetResolved={onSetIssueResolved} />}
      </section>
    </>
  );
}

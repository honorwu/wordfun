import type { ClassicalText, WordIssue, WordIssueKind } from "../../../shared/types.ts";
import { DictationCard, type DictationQuestion } from "./DictationCard";
import { PoetryCard } from "./PoetryCard";
import type { ReviewMarks, ReviewQuestionResult } from "./reviewMarks";

type ReviewQuestion = DictationQuestion & ReviewQuestionResult & {
  poem?: ClassicalText;
  issue?: WordIssue;
  onToggleIssue?: (kind: WordIssueKind) => void;
};

export function ReviewCards({ questions, marks }: { questions: ReviewQuestion[]; marks: ReviewMarks }) {
  return (
    <div className={`dictation-grid ${questions.some((question) => question.poem) ? "poetry-grid" : ""}`}>
      {questions.map((question, index) => {
        const { word, poem, issue, onToggleIssue, editableChars, result, unavailableLabel } = question;
        const review = { ...marks, editableChars, result, unavailableLabel };
        return poem ? (
          <PoetryCard key={word.id} index={index} wordId={word.id} poem={poem} review={review} />
        ) : (
          <DictationCard key={word.id} index={index} question={question} review={review} issue={issue} onToggleIssue={onToggleIssue} />
        );
      })}
    </div>
  );
}

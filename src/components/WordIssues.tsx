import { Check, Download, Flag, RotateCcw } from "lucide-react";
import { useState } from "react";
import { exportWordIssues, wordIssueKinds, wordIssueLabels } from "../lib/wordIssues";
import type { WordIssue, WordIssueKind } from "../types";

export function WordIssueControls({ issue, onToggle }: {
  issue?: WordIssue;
  onToggle: (kind: WordIssueKind) => void;
}) {
  const activeKinds = issue && !issue.resolvedAt ? issue.kinds : [];
  return (
    <div className="word-issue-controls" onClick={(event) => event.stopPropagation()}>
      <span className="word-issue-prompt"><Flag size={15} />题目有问题？</span>
      <div className="word-issue-options" role="group" aria-label="标记题目问题">
        {wordIssueKinds.map((kind) => (
          <button
            aria-pressed={activeKinds.includes(kind)}
            className={activeKinds.includes(kind) ? "selected" : ""}
            key={kind}
            onClick={() => onToggle(kind)}
            type="button"
          >
            {activeKinds.includes(kind) ? <Check size={15} /> : <Flag size={15} />}{wordIssueLabels[kind]}
          </button>
        ))}
      </div>
      {activeKinds.length > 0 ? <small role="status">已标记，交给家长核对；再次点击可取消。</small> : null}
    </div>
  );
}

export function WordIssuesPanel({ issues, onSetResolved }: {
  issues: WordIssue[];
  onSetResolved: (id: string, resolved: boolean) => void;
}) {
  const [filter, setFilter] = useState<"pending" | "resolved">("pending");
  const pendingCount = issues.filter((issue) => !issue.resolvedAt).length;
  const visibleIssues = issues.filter((issue) => filter === "pending" ? !issue.resolvedAt : Boolean(issue.resolvedAt))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const downloadIssues = () => {
    const url = URL.createObjectURL(new Blob([exportWordIssues(visibleIssues)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `字趣-词库问题-${filter === "pending" ? "待处理" : "已处理"}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="panel wide word-issues-panel" aria-label="词库问题">
      <div className="panel-title-row">
        <div className="panel-heading"><Flag size={20} /><h2>词库问题</h2></div>
        <button className="print-report-button" disabled={visibleIssues.length === 0} onClick={downloadIssues} type="button">
          <Download size={16} />导出{filter === "pending" ? "待处理" : "已处理"}清单
        </button>
      </div>
      <p className="panel-note">孩子在批改时标记的组词、读音问题会集中保留在这里。可导出清单统一修改词库，修改后再标记已处理。</p>
      <div className="word-issue-filters" role="group" aria-label="词库问题状态">
        <button aria-pressed={filter === "pending"} onClick={() => setFilter("pending")} type="button">待处理 {pendingCount}</button>
        <button aria-pressed={filter === "resolved"} onClick={() => setFilter("resolved")} type="button">已处理 {issues.length - pendingCount}</button>
      </div>
      {visibleIssues.length === 0 ? <p className="muted">{filter === "pending" ? "目前没有待处理的词库问题。孩子可在批改题卡下方进行标记。" : "还没有已处理的问题。"}</p> : (
        <div className="word-issue-list">
          {visibleIssues.map((issue) => (
            <article className="word-issue-item" key={issue.id}>
              <div className="word-issue-detail">
                <strong>{issue.word.text}</strong>
                <span className="word-issue-pinyin">{issue.word.pinyin || "暂无拼音"}</span>
                <small>{issue.lessonLabel} · 目标字：{issue.word.chars.join("、")}</small>
                <div className="word-issue-tags">{issue.kinds.map((kind) => <span key={kind}>{wordIssueLabels[kind]}</span>)}</div>
                <time dateTime={issue.createdAt}>标记于 {new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(issue.createdAt))}</time>
              </div>
              <button className="print-report-button" onClick={() => onSetResolved(issue.id, !issue.resolvedAt)} type="button">
                {issue.resolvedAt ? <><RotateCcw size={15} />重新打开</> : <><Check size={15} />标记已处理</>}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

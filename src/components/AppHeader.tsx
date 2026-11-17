import { BarChart3, Home } from "lucide-react";
import type { ViewMode } from "../app/types";

export function AppHeader({ viewMode, onSelectView }: { viewMode: ViewMode; onSelectView: (view: ViewMode) => void }) {
  return (
    <header className="app-header">
      <button className="brand" type="button" onClick={() => onSelectView("student")} aria-label="回到学生默写">
        <span className="brand-mark">字</span>
        <span><strong>字趣</strong><small>每天认真写好一点</small></span>
      </button>
      <nav className="view-tabs" aria-label="页面切换">
        <button className={viewMode === "student" ? "active" : ""} type="button" onClick={() => onSelectView("student")}>
          <Home size={18} />开始默写
        </button>
        <button className={viewMode === "parent" ? "active" : ""} type="button" onClick={() => onSelectView("parent")}>
          <BarChart3 size={18} />家长看板
        </button>
      </nav>
    </header>
  );
}

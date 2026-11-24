import { BarChart3, Home } from "lucide-react";
import type { ViewMode } from "../app/types";

export function AppHeader({ viewMode, onSelectView, navigationDisabled }: {
  viewMode: ViewMode;
  onSelectView: (view: ViewMode) => void;
  navigationDisabled: boolean;
}) {
  return (
    <header className="app-header">
      <button className="brand" type="button" disabled={navigationDisabled} onClick={() => onSelectView("student")} aria-label="回到学生默写">
        <span className="brand-mark" aria-hidden="true">字</span>
        <strong>字趣</strong>
      </button>
      <nav className="view-tabs" aria-label="页面切换">
        <button aria-current={viewMode === "student" ? "page" : undefined} type="button" disabled={navigationDisabled} onClick={() => onSelectView("student")}>
          <Home size={17} aria-hidden="true" />开始默写
        </button>
        <button aria-current={viewMode === "parent" ? "page" : undefined} type="button" disabled={navigationDisabled} onClick={() => onSelectView("parent")}>
          <BarChart3 size={17} aria-hidden="true" />家长看板
        </button>
      </nav>
    </header>
  );
}

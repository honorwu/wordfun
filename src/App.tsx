import { useAppController } from "./app/useAppController";
import { AppHeader } from "./components/AppHeader";
import { StatusScreen } from "./components/StatusScreen";
import { ParentView } from "./features/parent/ParentView";
import { StudentView } from "./features/practice/StudentView";

// 保留旧测试与脚本使用的导出。
export { maskLessonTitle } from "./features/practice/titleMask";

export default function App() {
  const app = useAppController();
  if (app.loadError) return <StatusScreen title="词库加载失败" detail={app.loadError} />;
  if (!app.isReady || !app.selectedLesson) return <StatusScreen title="正在加载默写" detail="读取当前课次和学习进度……" />;

  return (
    <main className="app-shell">
      <AppHeader viewMode={app.viewMode} onSelectView={app.setViewMode} />
      {app.viewMode === "student" ? (
        <StudentView {...app.studentProps} />
      ) : !app.parentReady ? (
        <section className="panel wide" role="status">
          <h2>{app.parentError ? "学习记录加载失败" : "正在加载学习记录"}</h2>
          {app.parentError ? <><p>{app.parentError}</p><button className="primary-button" type="button" onClick={app.retryLoad}>重新加载</button></> : null}
        </section>
      ) : (
        <ParentView {...app.parentProps} />
      )}
      {app.savedMessage ? <div className="toast" role="status" aria-live="polite">{app.savedMessage}</div> : null}
    </main>
  );
}

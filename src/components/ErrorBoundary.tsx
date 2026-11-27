import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "页面渲染遇到意外错误",
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-shell">
          <section className="status-screen" role="alert">
            <h1>页面暂时遇到问题</h1>
            <p>{this.state.message || "请刷新页面后重试，已保存的默写记录不会丢失。"}</p>
            <button className="primary-button" type="button" onClick={() => window.location.reload()}>
              重新加载页面
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

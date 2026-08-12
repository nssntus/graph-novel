import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppRoot } from "./app-root";
import "./styles.css";

type ErrorBoundaryState = { error: Error | null };

class FrontendErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("GraphNovel frontend error", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-12">
      <p className="text-sm font-medium text-destructive">GraphNovel 前端加载失败</p>
      <h1 className="text-2xl font-semibold tracking-tight">页面暂时无法显示</h1>
      <p className="text-sm text-muted-foreground">请刷新页面；如果问题持续存在，请查看运行中心或重新启动 5500 服务。</p>
      <pre className="max-h-48 overflow-auto rounded-md border bg-muted p-4 text-xs text-muted-foreground">{this.state.error.message}</pre>
    </main>;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FrontendErrorBoundary>
      <AppRoot />
    </FrontendErrorBoundary>
  </StrictMode>,
);

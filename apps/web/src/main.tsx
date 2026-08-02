import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

type AppErrorBoundaryState = { hasError: boolean };

class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch() {
    // Keep the user-facing surface secret-free; the actionable details belong in
    // the browser console and server-side diagnostics, not in the rendered page.
    console.error("automation_os_ui_render_error");
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main className="main">
        <section className="panel" role="alert" aria-live="assertive">
          <h1>Automation OS</h1>
          <p>画面の表示中にエラーが発生しました。認証状態を保持したまま再読み込みしてください。</p>
          <p className="muted">UI_RENDER_ERROR / 詳細な値やトークンは表示していません。</p>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>再読み込み</button>
        </section>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);

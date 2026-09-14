import React, { useEffect, useMemo, useRef, useState } from "react";
import { approvalReadbackUrl, validateApprovalReadback, type ApprovalReadStatus, type ApprovalReadFilters, type ApprovalReadback } from "./approvalReadFilters";

type ReadApiJson = (url: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
type Props = { companyId: string; initialRunId?: string; readApiJson: ReadApiJson };

const fields = ["id", "run_id", "action_kind", "target_account_ref_id", "payload_hash", "policy_version", "expires_at", "decision_revision", "consumed_at", "consumed_by_attempt_id"] as const;

const displayValue = (value: unknown) => value === null || value === undefined || value === "" ? "未確認" : String(value);

export function ApprovalReadbackPanel({ companyId, initialRunId = "", readApiJson }: Props) {
  const [runId, setRunId] = useState(initialRunId);
  const [status, setStatus] = useState<"" | ApprovalReadStatus>("");
  const [actionKind, setActionKind] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [error, setError] = useState("確定できない応答です。");
  const [readback, setReadback] = useState<ApprovalReadback | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const filters = useMemo<ApprovalReadFilters>(() => ({ companyId, runId: runId.trim(), status: status || undefined, actionKind: actionKind.trim() || undefined }), [companyId, runId, status, actionKind]);

  useEffect(() => {
    generation.current += 1;
    controller.current?.abort();
    setReadback(null);
    setState("idle");
    return () => {
      generation.current += 1;
      controller.current?.abort();
    };
  }, [companyId, runId, status, actionKind]);

  const search = async () => {
    const currentGeneration = ++generation.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    if (!filters.runId) { setReadback(null); setState("idle"); return; }
    let timedOut = false;
    const timeoutHandle = window.setTimeout(() => {
      timedOut = true;
      nextController.abort();
    }, 15_000);
    setState("loading"); setError("承認照会を確認できませんでした。");
    try {
      const value = await readApiJson(approvalReadbackUrl(filters), { signal: nextController.signal });
      if (currentGeneration !== generation.current) return;
      setReadback(validateApprovalReadback(value, filters));
      setState("ready");
    } catch (cause) {
      if (currentGeneration !== generation.current || (nextController.signal.aborted && !timedOut)) return;
      setReadback(null); setState("error");
      setError(timedOut ? "approval_readback_timeout" : cause instanceof Error ? cause.message : "承認照会を確認できませんでした。");
    } finally {
      window.clearTimeout(timeoutHandle);
    }
  };

  useEffect(() => {
    if (companyId && initialRunId.trim()) void search();
    // The route-provided Run ID is the only value that auto-starts a read-only
    // lookup; manually edited filters still require an explicit click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, initialRunId]);

  return <section className="panel" data-control-id="approvals.readback.panel">
    <div className="panel-head"><h2>会社・Run限定の承認照会（閲覧専用）</h2></div>
    <p className="muted">mvpStateの承認一覧とは独立した、会社スコープAPIのread-only照会です。秘密情報・承認本文は表示しません。</p>
    <div className="form-row">
      <label>会社<input data-control-id="approvals.readback.company" value={companyId} readOnly /></label>
      <label>Run ID<input data-control-id="approvals.readback.run" value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="業務Run ID（必須）" /></label>
      <label>status<select data-control-id="approvals.readback.status" value={status} onChange={(event) => setStatus(event.target.value as "" | ApprovalReadStatus)}><option value="">指定なし</option><option value="pending">pending</option><option value="approved">approved</option><option value="rejected">rejected</option><option value="cancelled">cancelled</option></select></label>
      <label>action_kind<input data-control-id="approvals.readback.action-kind" value={actionKind} onChange={(event) => setActionKind(event.target.value)} placeholder="完全一致" /></label>
    </div>
    <div className="button-row"><button type="button" className="btn primary" data-control-id="approvals.readback.search" disabled={!filters.runId || state === "loading"} onClick={() => { void search(); }}>{state === "loading" ? "照会中…" : "承認を照会"}</button><span className="muted">GET /api/v1/companies/:companyId/approvals / limit=20固定</span></div>
    {state === "idle" && <p className="muted" role="status">{!companyId ? "会社を確認できないため照会しません。" : filters.runId ? "業務Run IDを確認しました。承認照会を実行してください。" : "Run未指定では検索しません。業務Run IDを確認して入力してください。"}</p>}
    {state === "loading" && <p role="status">会社・Run限定の承認を取得中です。</p>}
    {state === "error" && <p role="alert">承認照会は未確認です。旧APIやmvpState一覧にはfallbackしていません。({error})</p>}
    {state === "ready" && readback && <>
      {readback.count === 0 ? <p role="status">一致する承認は0件です。承認不要・実行可能とは判定していません。</p> : <p role="status">一致 {readback.count}件 / 取得 {readback.approvals.length}件</p>}
      {readback.count === 20 && <p className="muted">上限到達、続きの有無は未確認</p>}
      {readback.approvals.length > 0 && <div className="table-wrap"><table data-control-id="approvals.readback.table"><thead><tr>{fields.map((field) => <th key={field}>{field}</th>)}</tr></thead><tbody>{readback.approvals.map((row, index) => <tr key={String(row.id ?? index)}>{fields.map((field) => <td key={field} data-label={field}>{displayValue(row[field])}</td>)}</tr>)}</tbody></table></div>}
    </>}
  </section>;
}

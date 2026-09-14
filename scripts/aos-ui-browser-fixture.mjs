// Local-only React acceptance fixture. Never proxies requests to AOS/providers.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";

const appPath = resolve("apps/web/src/App.tsx");
const entry = readFileSync(appPath, "utf8") + `
import { createRoot } from "react-dom/client";
const fixtureCompany = "company_fixture_readonly";
const fixtureRun = "run_fixture_cancelled";
location.hash = "#/projects/" + fixtureCompany + "/recovery?run_id=" + fixtureRun;
let fixtureReads = 0;
let fixtureBlocked = 0;
const fixtureLog = () => {
  document.getElementById("fixture-audit").textContent =
    "ISOLATED FIXTURE — no production connection | GET=" + fixtureReads + " | blocked=" + fixtureBlocked;
};
globalThis.fetch = async (input, init = {}) => {
  const expected = "/api/v1/companies/" + fixtureCompany + "/runs/" + fixtureRun + "/recovery";
  if (String(input) !== expected || (init.method || "GET").toUpperCase() !== "GET") {
    fixtureBlocked++; fixtureLog(); throw new Error("fixture_request_blocked");
  }
  fixtureReads++; fixtureLog();
  if (fixtureReads === 1) return new Response("{}", {status: 503});
  return Response.json({recovery: {
    schema: "aos.portable_run_recovery.v1", company_id: fixtureCompany, run_id: fixtureRun,
    readback_token: "fixture-only-token", status: "cancelled", workflow_id: "fixture-only",
    checked_at: "2026-09-06T14:00:00Z", external_action_executed: false,
    can_cancel: false, can_retry: false,
    cancel_blocker: "portable_recovery_run_not_cancellable",
    retry_blocker: "portable_recovery_workflow_unsupported"
  }});
};
const fixtureModel = {
  mvpLoadStatus: "ready",
  mvpState: {companies: [{id: fixtureCompany, name: "ISOLATED Fixture", role: "viewer"}],
    runs: [{id: fixtureRun, company_id: fixtureCompany, status: "cancelled"}], jobs: [], job_attempts: []},
  setReceipt() {}, setMvpState() {}, setAutomationRows() {}
};
fixtureLog();
createRoot(document.getElementById("root")).render(<TruthfulRecoveryPage model={fixtureModel} />);
`;
const companyEntry = readFileSync(appPath, "utf8") + `
import { createRoot } from "react-dom/client";
location.hash = "#/projects";
let posts = 0, reads = 0, blocked = 0;
let saved = null;
const audit = () => { document.getElementById("fixture-audit").textContent =
  "ISOLATED company fixture — POST=" + posts + " GET=" + reads + " blocked=" + blocked +
  " | saved=" + (saved?.name || "none"); };
globalThis.fetch = async (url, init = {}) => {
  const method = (init.method || "GET").toUpperCase();
  if (url === "/api/companies" && method === "POST" && !saved) {
    const body = JSON.parse(init.body);
    if (body.name !== "Fixture Acceptance" || !new Headers(init.headers).get("idempotency-key")) {
      blocked++; audit(); throw new Error("fixture_payload_rejected");
    }
    posts++; saved = {id: "company_fixture_created", name: body.name, role: "owner"}; audit();
    return Response.json({ok:true, company:saved});
  }
  if (url === "/api/mvp/state?projection=ui&fresh=1" && method === "GET" && saved) {
    reads++; audit(); return Response.json({companies:[saved], automations:[], runs:[], feedbacks:[]});
  }
  blocked++; audit(); throw new Error("fixture_request_blocked");
};
function CompanyFixture() {
  const [state, setState] = useState({companies:[], automations:[], runs:[]});
  const [receipt, setReceipt] = useState("");
  const model = {mvpState:state, mvpLoadStatus:"ready", setMvpState:setState,
    setReceipt, setAutomationRows() {}, setFeedbackReadback() {}};
  return <><p role="status">{receipt}</p><ProjectDirectoryPage model={model} /></>;
}
audit();
createRoot(document.getElementById("root")).render(<CompanyFixture />);
`;
const readonlyEntry = readFileSync(appPath, "utf8") + `
import { createRoot } from "react-dom/client";
const company = "company_fixture_readonly";
const page = new URLSearchParams(location.search).get("page") || "approvals";
if (!["approvals", "runs", "recovery"].includes(page)) throw new Error("fixture_page_rejected");
location.hash = page === "recovery" ? "#/projects/" + company + "/recovery" : "#/" + page;
let blocked = 0, reads = 0;
const audit = () => { document.getElementById("fixture-audit").textContent =
  "ISOLATED viewer fixture — page=" + page + " | production connection=false | GET=" + reads + " | blocked requests=" + blocked; };
globalThis.fetch = async (url, init = {}) => {
  if ((init.method || "GET").toUpperCase() === "GET") {
    if (url === "/api/mvp/state?projection=ui&fresh=1") {
      reads++; audit(); return Response.json(model.mvpState);
    }
    if (url === "/api/runs/fixture-run") {
      reads++; audit(); return Response.json({run:model.mvpState.runs[0], proofs:[], steps:[], workerEvents:[]});
    }
  }
  blocked++; audit(); throw new Error("fixture_network_blocked");
};
const model = {mvpLoadStatus:"ready", mvpState: {
  companies:[{id:company, name:"ISOLATED viewer company", role:"viewer"}],
  runs:[{id:"fixture-run", company_id:company, name:"Fixture run", status:"failed"}],
  jobs:[{id:"fixture-job", run_id:"fixture-run", company_id:company, status:"timed_out", attempt_count:1}],
  approvals:[{id:"fixture-approval", company_id:company, status:"pending", title:"Fixture pending approval", external_action_allowed:false}],
  automations:[], proofs:[], job_attempts:[]
}, setReceipt() {}, setMvpState() {}, setAutomationRows() {}};
audit();
createRoot(document.getElementById("root")).render(page === "approvals" ? <ApprovalsPage model={model} /> : page === "runs" ? <RunsPage model={model} /> : <TruthfulRecoveryPage model={model} />);
`;
const bundle = await build({
  stdin: { contents: process.argv.includes("--chat") ? readFileSync(appPath, "utf8").replace(
    'const requestThreadId = selectedChatSession ? (selectedChatSession.codex_thread_id ?? "") : chatThreadId;',
    'const requestThreadId = selectedChatSession ? (selectedChatSession.codex_thread_id ?? "") : chatThreadId; React.useEffect(() => { let node = document.getElementById("fixture-chat-state"); if (!node) { node = document.createElement("pre"); node.id = "fixture-chat-state"; document.body.prepend(node); } node.textContent = JSON.stringify({sessionId:chatSessionId, selectedThread:selectedChatSession?.codex_thread_id, localThread:chatThreadId, requestThread:requestThreadId, plannerThread:plannerReadback?.chat_thread_id, progressThread:plannerProgress?.threadId}); }, [chatSessionId, selectedChatSession, chatThreadId, requestThreadId, plannerReadback, plannerProgress]);'
  ) + `
import { createRoot } from "react-dom/client";
const company = "company_fixture_chat";
location.hash = "#/chat?company_id=" + company;
let reads = 0, creates = 0, activates = 0, blocked = 0;
const sessions = [{id:"fixture-old-session",project_id:company,name:"既存の会話",codex_thread_id:"fixture-old-thread",active:true,created_at:"2026-09-06T00:00:00Z",updated_at:"2026-09-06T00:00:00Z"}];
const audit = () => {document.getElementById("fixture-audit").textContent = "ISOLATED Chat GET="+reads+" create="+creates+" activate="+activates+" blocked="+blocked+" sessions="+sessions.length+" production=false";};
globalThis.fetch = async (url, init = {}) => {
  const method = init.method || "GET";
  let body;
  if (method === "GET" && url === "/api/create/chat/sessions?project_id="+company) body={ok:true,sessions};
  else if (method === "GET" && url === "/api/create/chat/threads?project_id="+company+"&limit=20") body={ok:true,threads:[{threadId:"fixture-old-thread",latestJobId:"fixture-old-job",latestStatus:"blocked",updatedAt:"2026-09-06T00:00:00Z",companyIds:[company],resultTitle:"既存履歴の保持テスト",messages:[{role:"user",text:"以前の相談"},{role:"assistant",text:"以前の回答を保持"}]}]};
  else if (method === "GET" && url === "/api/v1/companies/"+company+"/control-plane/consultation") {reads++;audit();return Response.json({error:"fixture_consultation_not_in_scope"},{status:503});}
  else if (method === "POST" && url === "/api/create/chat/sessions" && creates === 0 && JSON.parse(init.body).project_id === company) {
    creates++; const item={...sessions[0],id:"fixture-new-session",name:JSON.parse(init.body).name,codex_thread_id:null,active:false};sessions.push(item);body={ok:true,session:item};
  } else if (method === "POST" && url === "/api/create/chat/sessions/fixture-new-session/activate" && activates === 0 && JSON.parse(init.body).project_id === company) {
    activates++;sessions.forEach(item=>item.active=item.id==="fixture-new-session");body={ok:true,session:sessions[1]};
  } else {blocked++;audit();throw new Error("fixture_request_blocked:"+method+":"+url);}
  if(method === "GET") reads++;audit();return Response.json(body);
};
function ChatFixture() {
  const [receipt,setReceipt]=useState("");
  const [state,setMvpState]=useState({companies:[{id:company,name:"ISOLATED Chat company",role:"owner"}],automations:[],schedules:[],runs:[],jobs:[],approvals:[],projects:[],codexCapabilities:{plugins:[]}});
  const model={mvpLoadStatus:"ready",mvpState:state,setMvpState,setReceipt,setAutomationRows:()=>{}};
  return <><p role="status">{receipt}</p><ChatPage model={model}/></>;
}
audit();createRoot(document.getElementById("root")).render(<ChatFixture/>);
` : process.argv.includes("--plugins") ? readFileSync(appPath, "utf8") + `
import { createRoot } from "react-dom/client";
const company = "company_fixture_plugins";
location.hash = "#/plugins?company_id=" + company;
let phase = "unavailable", reads = 0, blocked = 0, authRequests = 0, popupAttempts = 0;
const prefix = "/api/v1/companies/" + company;
const audit = () => { document.getElementById("fixture-audit").textContent =
  "ISOLATED Plugin — phase=" + phase + " GET=" + reads + " blocked=" + blocked + " authStub=" + authRequests + " popupStub=" + popupAttempts + " production connection=false"; };
const ref = {id:"fixture-ref",companyId:company,platform:"FixturePlugin",accountRef:"fixture-only",revision:1,status:"verified",oauthState:"connected",scopes:["read"]};
if (new URLSearchParams(location.search).get("verifiedRef") === "1") Object.assign(ref, {verificationStatus:"verified",lastVerifiedAt:"2026-09-06T00:00:00.000Z"});
globalThis.fetch = async (url, init = {}) => {
  if (new URLSearchParams(location.search).get("popup") === "1" && init.method === "POST" && url === prefix + "/codex/app-server/plugins/install" && authRequests === 0) {
    const payload = JSON.parse(init.body || "{}");
    if (payload.plugin_id === "fixture-plugin" && payload.plugin_name === "FixturePlugin") {
      authRequests++; audit();
      return Response.json({ok:true,plugin:{id:"fixture-plugin"},registry:{pluginRegistry:{installed:[{id:"fixture-plugin",name:"FixturePlugin",authPolicy:"ON_USE"}],available:[]}},auth:{authorization_urls:["https://fixture-auth.invalid/authorize"]}});
    }
  }
  if ((init.method || "GET").toUpperCase() !== "GET") { blocked++; audit(); throw new Error("fixture_write_blocked"); }
  let body;
  if (url === prefix + "/connection-account-refs") body = {ok:true,refs:[ref]};
  else if (url === prefix + "/codex/app-server/connector-registry") body = {registry:{pluginRegistry:{installed:[],available:[]}}};
  else if (url === prefix + "/codex/app-server/auth/status") body = {ok:true,auth:{status:"verified",account:{accountPresent:true}}};
  else if (url === prefix + "/codex/app-server/plugins/access?plugin_id=fixture-plugin") {
    reads++; audit();
    if (phase === "error") return Response.json({ok:false,error:"fixture_access_unavailable"},{status:503});
    return Response.json({ok:true,access:{apps:[{accessStateAvailable:true,isAccessible:phase === "ready",isEnabled:true,callable:phase === "ready"}]}});
  } else { blocked++; audit(); throw new Error("fixture_url_blocked"); }
  reads++; audit(); return Response.json(body);
};
window.open = () => { popupAttempts++; audit(); return null; };
function PluginFixture() {
  const [receipt,setReceipt] = useState("");
  const model = {mvpLoadStatus:"ready",setReceipt,mvpState:{companies:[{id:company,name:"ISOLATED Plugin company",role:"owner"}],codexCapabilities:{plugins:[{id:"fixture-plugin",pluginId:"fixture-plugin",name:"FixturePlugin",kind:"plugin",catalogSource:"installed",status:"available_with_codex_runtime",state:{configured:true,enabled:true,verified:false,connected:false}}]}}};
  return <><div aria-label="Fixture response phase">{["unavailable","error","ready"].map(value => <button key={value} onClick={() => {phase=value; audit();}}>Fixture {value}</button>)}</div><p role="status">{receipt}</p><TruthfulPluginsPage model={model} /></>;
}
audit(); createRoot(document.getElementById("root")).render(<PluginFixture />);
` : process.argv.includes("--backend") ? readFileSync(appPath, "utf8") + `
import { createRoot } from "react-dom/client";
location.hash = "#/admin";
let reads = 0, writes = 0, blocked = 0;
let setting = {backend:"aos_chrome_companion", revision:1, chrome_profile:{name:"Profile 2"}};
const path = "/api/v1/settings/web-operation-backend";
const scenario = new URLSearchParams(location.search).get("scenario") || "normal";
const audit = () => { document.getElementById("fixture-audit").textContent =
  "ISOLATED backend — GET=" + reads + " PUT=" + writes + " blocked=" + blocked + " scenario=" + scenario; };
globalThis.fetch = async (url, init = {}) => {
  const method = (init.method || "GET").toUpperCase();
  if (url === "/api/v1/admin/diagnostics" && method === "GET") {
    reads++; audit(); return Response.json({ok:true, pc:{}, browser:{}, codex:{}});
  }
  if (url === path && method === "GET") {
    reads++; audit();
    return Response.json({ok:true, setting, adapter_coverage:[], local_sync:{written:true}});
  }
  if (url === path && method === "PUT" && writes === 0) {
    const body = JSON.parse(init.body);
    if (body.expected_revision !== 1 || body.backend !== "aos_chrome_companion") {
      blocked++; audit(); throw new Error("fixture_payload_rejected");
    }
    writes++; audit();
    if (scenario === "conflict") return Response.json({ok:false, error:"web_operation_backend_revision_conflict"}, {status:409});
    setting = {...setting, revision:2};
    return Response.json({ok:true, setting});
  }
  blocked++; audit(); throw new Error("fixture_request_blocked");
};
function BackendFixture() {
  const [state,setState] = useState({companies:[{id:"company_fixture", name:"ISOLATED owner", role:"owner"}], worker:{heartbeat_fresh:true}});
  const [receipt,setReceipt] = useState("");
  return <><p role="status">{receipt}</p><OwnerAdminPage model={{mvpState:state,mvpLoadStatus:"ready",setMvpState:setState,setReceipt}} /></>;
}
audit(); createRoot(document.getElementById("root")).render(<BackendFixture />);
` : process.argv.includes("--integrations") ? readFileSync(appPath, "utf8") + `
import { createRoot } from "react-dom/client";
location.hash = "#/projects/company_fixture/integrations";
let reads = 0, posts = 0, blocked = 0;
let ref = {id:"fixture-ref", companyId:"company_fixture", platform:"Fixture", accountRef:"fixture-only", revision:1, status:"verified", oauthState:"connected", scopes:[]};
const path = "/api/v1/companies/company_fixture/connection-account-refs";
const audit = () => { document.getElementById("fixture-audit").textContent =
  "ISOLATED integrations — GET=" + reads + " POST=" + posts + " blocked=" + blocked; };
globalThis.fetch = async (url, init = {}) => {
  const method = (init.method || "GET").toUpperCase();
  if (url === path && method === "GET") {
    reads++; audit();
    if (reads === 2 && !new URLSearchParams(location.search).has("normal")) return Response.json({ok:false}, {status:503});
    return Response.json({ok:true, company_scope:{enforced:true, company_id:"company_fixture"}, refs:[ref]});
  }
  if (url === path + "/fixture-ref/revoke" && method === "POST" && posts === 0
    && JSON.parse(init.body).expected_revision === 1) {
    posts++; ref = {...ref, revision:2, status:"revoked", oauthState:"revoked"}; audit();
    return Response.json({ok:true, connection:ref});
  }
  blocked++; audit(); throw new Error("fixture_request_blocked");
};
function IntegrationsFixture() {
  const [receipt,setReceipt] = useState("");
  return <><p role="status">{receipt}</p><TruthfulIntegrationsPage model={{mvpState:{companies:[{id:"company_fixture", name:"ISOLATED Fixture", role:"owner"}]}, setReceipt}} /></>;
}
audit(); createRoot(document.getElementById("root")).render(<IntegrationsFixture />);
` : process.argv.includes("--auth") ? readFileSync(appPath, "utf8") + `
import { createRoot } from "react-dom/client";
location.hash = "#/projects";
let authReads = 0, stateReads = 0, blocked = 0;
const audit = () => { document.getElementById("fixture-audit").textContent =
  "ISOLATED auth fixture — auth GET=" + authReads + " state GET=" + stateReads + " blocked=" + blocked; };
globalThis.fetch = async (url, init = {}) => {
  if ((init.method || "GET").toUpperCase() !== "GET") { blocked++; audit(); throw new Error("fixture_write_blocked"); }
  if (url === "/api/auth/session") { authReads++; audit(); return Response.json({ok:false}, {status:401}); }
  if (String(url).startsWith("/api/mvp/state?")) { stateReads++; audit(); return Response.json({}, {status:401}); }
  blocked++; audit(); throw new Error("fixture_url_blocked");
};
audit();
createRoot(document.getElementById("root")).render(<App />);
` : process.argv.includes("--readonly") ? readonlyEntry : process.argv.includes("--company") ? companyEntry : entry, loader: "tsx", resolveDir: dirname(appPath), sourcefile: appPath },
  bundle: true, write: false, format: "iife", platform: "browser", outdir: "fixture-output",
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
});
const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.contents;
const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.contents ?? "";
if (!js) throw new Error("fixture_bundle_missing");
const html = '<!doctype html><html lang="ja"><meta charset="utf-8"><title>AOS isolated UI fixture</title><link rel="stylesheet" href="/fixture.css"><body><p id="fixture-audit"></p><main id="root"></main><script src="/fixture.js"></script></body></html>';
const server = createServer((req, res) => {
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("Cache-Control", "no-store");
  const route = new URL(req.url, "http://127.0.0.1").pathname;
  const assets = { "/": ["text/html; charset=utf-8", html], "/fixture.js": ["text/javascript; charset=utf-8", js], "/fixture.css": ["text/css; charset=utf-8", css] };
  if (req.method !== "GET" || !assets[route]) { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", assets[route][0]);
  res.end(assets[route][1]);
});
const fixtureMode = ["chat", "plugins", "backend", "readonly", "integrations", "auth", "company"].find(mode => process.argv.includes("--" + mode)) ?? "recovery";
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({
  url: `http://127.0.0.1:${server.address().port}/`, fixture: fixtureMode + "-isolated",
  production_connection: false, browser_acceptance: "pending", mode: fixtureMode
})));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close();
  server.closeAllConnections();
});

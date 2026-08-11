import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-kernel-"));

const contracts = await import("../automationKernel/contracts.js");
const repository = await import("../automationKernel/repository.js");
const manifestCompiler = await import("../automationKernel/manifestCompiler.js");
const kernelResult = await import("../automationKernel/result.js");
const cli = await import("../cli/automationKernelClaimEffect.js");
const control = await import("../cli/automationKernelControl.js");

const definition = contracts.parseAutomationKernelDefinitionV1({
  schema_version: "automation_kernel.v1",
  kernel_id: "kernel-demo",
  title: "Kernel Demo",
  heartbeat_owner: "caller",
  effects: [
    {
      effect_id: "prep_local_state",
      effect_class: "internal_idempotent",
      summary: "Prepare local state",
      payload: { step: 1 }
    },
    {
      effect_id: "send_external_receipt",
      effect_class: "external_non_idempotent",
      summary: "Send external receipt",
      payload: { step: 2 }
    }
  ],
  metadata: { purpose: "test" }
});

test("kernel definition parsing rejects unknown fields and heartbeat ownership drift", () => {
  assert.throws(
    () =>
      contracts.parseAutomationKernelDefinitionV1({
        schema_version: "automation_kernel.v1",
        kernel_id: "kernel-demo",
        title: "Kernel Demo",
        heartbeat_owner: "caller",
        effects: [],
        metadata: {},
        extra: true
      }),
    /kernel_definition_unknown_field/
  );
  assert.throws(
    () =>
      contracts.parseAutomationKernelDefinitionV1({
        schema_version: "automation_kernel.v1",
        kernel_id: "kernel-demo",
        title: "Kernel Demo",
        heartbeat_owner: "kernel",
        effects: [],
        metadata: {}
      }),
    /kernel_definition_heartbeat_owner_invalid/
  );
});

test("kernel repository claims one effect, preserves caller-owned heartbeat, and chains timeline entries", () => {
  const root = join(tempRoot, "repo");
  const ensured = repository.ensureKernelDefinition({ definition, root });
  assert.equal(ensured.kernel_id, "kernel-demo");
  assert.ok(existsSync(repository.definitionPath(ensured.kernel_id, root)));

  const claimed = repository.claimKernelEffect({
    definition: ensured,
    root,
    claimedBy: "test-suite",
    createdAt: "2026-07-16T00:00:00.000Z"
  });

  assert.equal(claimed.snapshot.status, "running");
  assert.equal(claimed.snapshot.active_effect_id, "prep_local_state");
  assert.equal(claimed.snapshot.next_effect_id, null);
  assert.equal(claimed.snapshot.heartbeat_owner, "caller");
  assert.equal(claimed.legacy_projection.legacy_status, "partial");
  assert.equal(claimed.timeline_entry.entry_kind, "kernel_event");
  assert.equal(claimed.timeline_entry.previous_entry_hash.length, 64);
  assert.ok(existsSync(repository.timelinePath(ensured.kernel_id, root)));

  const timeline = repository.readKernelTimeline({ kernelId: ensured.kernel_id, root });
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.entry_hash, claimed.timeline_entry.entry_hash);
});

test("kernel reducer moves ambiguous external receipts into reconciliation_required", () => {
  const externalClaim = repository.claimKernelEffect({
    definition,
    root: join(tempRoot, "reducer"),
    claimedBy: "test-suite",
    createdAt: "2026-07-16T00:00:00.000Z"
  });
  const receipt = repository.recordKernelReceipt({
    kernelId: externalClaim.definition.kernel_id,
    root: join(tempRoot, "reducer"),
    effectId: "prep_local_state",
    effectClass: "internal_idempotent",
    outcome: "succeeded",
    externalActionExecuted: false,
    summary: "internal succeeded",
    createdAt: "2026-07-16T00:00:01.000Z"
  });
  assert.equal(receipt.snapshot.status, "running");

  repository.claimKernelEffect({
    definition,
    root: join(tempRoot, "reducer"),
    effectId: "send_external_receipt",
    claimedBy: "test-suite",
    createdAt: "2026-07-16T00:00:02.000Z"
  });
  const ambiguous = repository.recordKernelReceipt({
    kernelId: definition.kernel_id,
    root: join(tempRoot, "reducer"),
    effectId: "send_external_receipt",
    effectClass: "external_non_idempotent",
    outcome: "ambiguous",
    externalActionExecuted: true,
    summary: "external outcome ambiguous",
    evidence: { observed: true, exact_blocker: "submit_readback_ambiguous" },
    createdAt: "2026-07-16T00:00:03.000Z"
  });

  assert.equal(ambiguous.snapshot.status, "reconciliation_required");
  assert.equal(ambiguous.snapshot.exact_blocker, "submit_readback_ambiguous");
  assert.equal(ambiguous.legacy_projection.registered_status, "blocked");
  assert.equal(ambiguous.legacy_projection.legacy_status, "partial");
  assert.ok(ambiguous.legacy_projection.proof_gate.missing.some((item) => item.includes("reconciliation_required")));
});

test("continuation effects persist unit receipts and complete only on a terminal unit", () => {
  const root = join(tempRoot, "continuation-units");
  const continuationDefinition = contracts.parseAutomationKernelDefinitionV1({
    schema_version: "automation_kernel.v1",
    kernel_id: "kernel-continuation",
    title: "Kernel Continuation",
    heartbeat_owner: "caller",
    effects: [
      {
        effect_id: "chunks",
        effect_class: "external_non_idempotent",
        summary: "Process chunks",
        payload: { continuation: { unit_id: "chunk_id" } }
      },
      {
        effect_id: "finish",
        effect_class: "internal_idempotent",
        summary: "Finish",
        payload: {}
      }
    ],
    metadata: { workflow_id: "continuation-workflow", run_id: "continuation-run" }
  });

  repository.claimKernelEffect({
    definition: continuationDefinition,
    root,
    effectId: "chunks",
    unitId: "chunk-1",
    claimedBy: "test-suite",
    createdAt: "2026-07-16T00:00:00.000Z"
  });
  const first = repository.recordKernelReceipt({
    kernelId: continuationDefinition.kernel_id,
    root,
    effectId: "chunks",
    effectClass: "external_non_idempotent",
    outcome: "succeeded",
    externalActionExecuted: true,
    summary: "first chunk complete",
    unitId: "chunk-1",
    stageTerminal: false,
    createdAt: "2026-07-16T00:00:01.000Z"
  });
  assert.equal(first.snapshot.effects[0]!.status, "claimed");
  assert.equal(first.snapshot.effects[0]!.active_unit_id, null);
  assert.equal(first.snapshot.next_effect_id, "chunks");
  assert.deepEqual(first.snapshot.effects[0]!.unit_ids, ["chunk-1"]);
  assert.throws(() => repository.claimKernelEffect({
    definition: continuationDefinition,
    root,
    effectId: "chunks",
    unitId: "chunk-1",
    claimedBy: "test-suite",
    createdAt: "2026-07-16T00:00:02.000Z"
  }), /kernel_effect_unit_id_duplicate:chunks/);

  repository.claimKernelEffect({
    definition: continuationDefinition,
    root,
    effectId: "chunks",
    unitId: "chunk-2",
    claimedBy: "test-suite",
    createdAt: "2026-07-16T00:00:03.000Z"
  });
  const terminal = repository.recordKernelReceipt({
    kernelId: continuationDefinition.kernel_id,
    root,
    effectId: "chunks",
    effectClass: "external_non_idempotent",
    outcome: "succeeded",
    externalActionExecuted: true,
    summary: "all chunks complete",
    unitId: "chunk-2",
    stageTerminal: true,
    createdAt: "2026-07-16T00:00:04.000Z"
  });
  assert.equal(terminal.snapshot.effects[0]!.status, "succeeded");
  assert.equal(terminal.snapshot.next_effect_id, "finish");
  assert.deepEqual(terminal.snapshot.effects[0]!.unit_ids, ["chunk-1", "chunk-2"]);
});

test("always-run cleanup remains claimable and preserves the first exact blocker", () => {
  const root = join(tempRoot, "always-run-cleanup");
  const cleanupDefinition = contracts.parseAutomationKernelDefinitionV1({
    schema_version: "automation_kernel.v1",
    kernel_id: "kernel-cleanup",
    title: "Kernel Cleanup",
    heartbeat_owner: "caller",
    effects: [
      { effect_id: "fail", effect_class: "internal_idempotent", summary: "Fail", payload: {} },
      { effect_id: "skipped", effect_class: "internal_idempotent", summary: "Skipped", payload: {} },
      { effect_id: "cleanup", effect_class: "internal_idempotent", summary: "Cleanup", payload: { always_run: true } }
    ],
    metadata: { workflow_id: "cleanup-workflow", run_id: "cleanup-run" }
  });
  repository.claimKernelEffect({
    definition: cleanupDefinition,
    root,
    effectId: "fail",
    claimedBy: "test-suite",
    createdAt: "2026-07-16T00:00:00.000Z"
  });
  const failed = repository.recordKernelReceipt({
    kernelId: cleanupDefinition.kernel_id,
    root,
    effectId: "fail",
    effectClass: "internal_idempotent",
    outcome: "failed",
    externalActionExecuted: false,
    summary: "primary failure",
    evidence: { exact_blocker: "primary_exact_blocker" },
    createdAt: "2026-07-16T00:00:01.000Z"
  });
  assert.equal(failed.snapshot.status, "blocked");
  assert.equal(failed.snapshot.next_effect_id, "cleanup");
  const prematureResult = kernelResult.createAutomationKernelResultV2({
    workflowId: "cleanup-workflow",
    runId: "cleanup-run",
    terminalStatus: "blocked",
    selectedStages: ["fail"],
    stageResults: [{
      stage_id: "fail",
      status: "failed",
      exact_blocker: "primary_exact_blocker",
      artifact_uris: [],
      cleanup_proof: null,
      claim_id: failed.snapshot.effects[0]!.claim_id,
      receipt_id: failed.snapshot.effects[0]!.receipt_id,
      proof_uri: null,
      details: {}
    }],
    exactBlocker: "primary_exact_blocker",
    restartStage: "fail",
    cleanupProof: "cleanup://claimed-without-receipt"
  });
  assert.throws(
    () => kernelResult.assertAutomationKernelResultMatchesSnapshot(prematureResult, cleanupDefinition, failed.snapshot),
    /automation_kernel_result_always_run_incomplete:cleanup/
  );

  const cleanupClaim = repository.claimKernelEffect({
    definition: cleanupDefinition,
    root,
    effectId: "cleanup",
    claimedBy: "test-suite",
    createdAt: "2026-07-16T00:00:02.000Z"
  });
  const cleaned = repository.recordKernelReceipt({
    kernelId: cleanupDefinition.kernel_id,
    root,
    effectId: "cleanup",
    effectClass: "internal_idempotent",
    outcome: "succeeded",
    externalActionExecuted: false,
    summary: "cleanup complete",
    createdAt: "2026-07-16T00:00:03.000Z"
  });
  assert.equal(cleaned.snapshot.status, "blocked");
  assert.equal(cleaned.snapshot.exact_blocker, "primary_exact_blocker");
  assert.equal(cleaned.snapshot.effects[1]!.status, "pending");
  assert.equal(cleaned.snapshot.effects[2]!.status, "succeeded");
  const result = kernelResult.createAutomationKernelResultV2({
    workflowId: "cleanup-workflow",
    runId: "cleanup-run",
    terminalStatus: "blocked",
    selectedStages: ["fail", "cleanup"],
    stageResults: [
      {
        stage_id: "fail",
        status: "failed",
        exact_blocker: "primary_exact_blocker",
        artifact_uris: [],
        cleanup_proof: null,
        claim_id: failed.snapshot.effects[0]!.claim_id,
        receipt_id: failed.snapshot.effects[0]!.receipt_id,
        proof_uri: null,
        details: {}
      },
      {
        stage_id: "cleanup",
        status: "succeeded",
        exact_blocker: null,
        artifact_uris: [],
        cleanup_proof: "cleanup://done",
        claim_id: cleanupClaim.snapshot.effects[2]!.claim_id,
        receipt_id: cleaned.snapshot.effects[2]!.receipt_id,
        proof_uri: null,
        details: {}
      }
    ],
    exactBlocker: "primary_exact_blocker",
    restartStage: "fail",
    cleanupProof: "cleanup://done"
  });
  assert.doesNotThrow(() => kernelResult.assertAutomationKernelResultMatchesSnapshot(result, cleanupDefinition, cleaned.snapshot));
});

test("always-run cleanup becomes the active claim after an ambiguous external effect", () => {
  const root = join(tempRoot, "always-run-after-reconciliation");
  const definition = contracts.parseAutomationKernelDefinitionV1({
    schema_version: "automation_kernel.v1",
    kernel_id: "kernel-reconciliation-cleanup",
    title: "Kernel Reconciliation Cleanup",
    heartbeat_owner: "caller",
    effects: [
      { effect_id: "send", effect_class: "external_non_idempotent", summary: "Send", payload: {} },
      { effect_id: "cleanup", effect_class: "internal_idempotent", summary: "Cleanup", payload: { always_run: true } }
    ],
    metadata: { workflow_id: "reconciliation-cleanup", run_id: "reconciliation-cleanup-run" }
  });
  repository.claimKernelEffect({ definition, root, effectId: "send", claimedBy: "test-suite", createdAt: "2026-07-16T00:00:00.000Z" });
  const ambiguous = repository.recordKernelReceipt({
    kernelId: definition.kernel_id,
    root,
    effectId: "send",
    effectClass: "external_non_idempotent",
    outcome: "ambiguous",
    externalActionExecuted: true,
    summary: "send ambiguous",
    evidence: { exact_blocker: "send_readback_ambiguous" },
    createdAt: "2026-07-16T00:00:01.000Z"
  });
  assert.equal(ambiguous.snapshot.next_effect_id, "cleanup");
  const cleanupClaim = repository.claimKernelEffect({
    definition,
    root,
    effectId: "cleanup",
    claimedBy: "test-suite",
    createdAt: "2026-07-16T00:00:02.000Z"
  });
  assert.equal(cleanupClaim.snapshot.active_effect_id, "cleanup");
  const cleaned = repository.recordKernelReceipt({
    kernelId: definition.kernel_id,
    root,
    effectId: "cleanup",
    effectClass: "internal_idempotent",
    outcome: "succeeded",
    externalActionExecuted: false,
    summary: "cleanup complete",
    createdAt: "2026-07-16T00:00:03.000Z"
  });
  assert.equal(cleaned.snapshot.status, "reconciliation_required");
  assert.equal(cleaned.snapshot.exact_blocker, "send_readback_ambiguous");
});

test("CLI claims an effect and writes a file-backed canary artifact while keeping heartbeat caller-owned", async () => {
  const root = join(tempRoot, "cli");
  const definitionPath = join(tempRoot, "kernel-definition.json");
  const artifactPath = join(repository.automationKernelRoot(root), "kernel-claim-result.json");
  repository.ensureKernelDefinition({ definition, root });
  writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);

  const result = await cli.runAutomationKernelClaimCli({
    root,
    definitionFile: definitionPath,
    effectId: "prep_local_state",
    out: artifactPath
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.heartbeat_owner, "caller");
  assert.ok(existsSync(artifactPath));
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { ok: boolean; heartbeat_owner: string; caller_owned_heartbeat: boolean };
  assert.equal(artifact.ok, true);
  assert.equal(artifact.heartbeat_owner, "caller");
  assert.equal(artifact.caller_owned_heartbeat, true);
});

test("all globally registered and reference workflow manifests compile deterministically", () => {
  const registry = JSON.parse(readFileSync(
    "/Users/nichikatanaka/.codex/automations/_shared/automation-kernel-registry.v1.json",
    "utf8"
  )) as { entries: Array<{ manifest: string }> };
  const paths = [...new Set([
    ...registry.entries
      .map((entry) => entry.manifest)
      .filter((manifest): manifest is string => typeof manifest === "string" && manifest.trim().length > 0),
    "/Users/nichikatanaka/Documents/Codex/external-repos/heavy-chain/.codex/automation-kernel/manifests/heavy-chain.json"
  ])];
  paths.forEach((path) => {
    const manifest = manifestCompiler.parseAutomationKernelManifestFileV1(path);
    const first = manifestCompiler.compileAutomationKernelManifestV1(manifest, "deterministic-run");
    const second = manifestCompiler.compileAutomationKernelManifestV1(manifest, "deterministic-run");
    assert.deepEqual(first, second);
    const required = manifest.stages.filter((stage) => stage.required);
    assert.ok(required.length > 0);
    assert.equal(first.definition.effects.length, required.length);
    assert.deepEqual(first.definition.effects.map((effect) => effect.effect_id), required.map((stage) => stage.id));
    assert.deepEqual(first.definition.effects.map((effect) => effect.effect_class), required.map((stage) => stage.effect_class));
  });
});

test("optional manifest stages require explicit selection while required stages cannot be omitted", () => {
  const manifest = manifestCompiler.parseAutomationKernelManifestFileV1(
    "/Users/nichikatanaka/Documents/Codex/external-repos/heavy-chain/.codex/automation-kernel/manifests/heavy-chain.json"
  );
  const selected = manifestCompiler.compileAutomationKernelManifestV1(manifest, "selected-run", [
    "local_static_checks",
    "printing_foundation",
    "live_production_route_visual_qa"
  ]);
  assert.deepEqual(selected.definition.effects.map((effect) => effect.effect_id), [
    "local_static_checks",
    "printing_foundation",
    "live_production_route_visual_qa"
  ]);
  assert.throws(
    () => manifestCompiler.compileAutomationKernelManifestV1(manifest, "missing-required", ["local_static_checks"]),
    /automation_kernel_required_stage_not_selected:printing_foundation/
  );
  assert.throws(
    () => manifestCompiler.compileAutomationKernelManifestV1(manifest, "unknown-stage", [
      "local_static_checks",
      "printing_foundation",
      "not-a-stage"
    ]),
    /automation_kernel_selected_stage_unknown:not-a-stage/
  );
});

test("kernel profile is derived per stage and external stages are always full", () => {
  const source = JSON.parse(readFileSync(
    "/Users/nichikatanaka/Documents/New project/.codex/automation-kernel/manifests/daily-ai-research-publish-run.json",
    "utf8"
  )) as Record<string, unknown> & { stages: Array<Record<string, unknown>> };
  source.stages[0] = { ...source.stages[0], kernel_profile: "light" };
  const manifest = manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(source));
  const compiled = manifestCompiler.compileAutomationKernelManifestV1(manifest, "profile-run");
  assert.equal(manifest.stages[0]?.kernel_profile, "light");
  assert.equal(compiled.definition.effects[0]?.payload.kernel_profile, "light");

  const externalSource = structuredClone(source);
  externalSource.stages[0]!.effect_class = "external_non_idempotent";
  externalSource.stages[0]!.kernel_profile = "light";
  assert.throws(
    () => manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(externalSource)),
    /automation_kernel_manifest_external_stage_requires_full_kernel/
  );
});

test("Browser Use CLI is a strict manifest surface with no IAB or Chrome fallback", () => {
  const source = JSON.parse(readFileSync(
    "/Users/nichikatanaka/Documents/New project/.codex/automation-kernel/manifests/job-application-manager.json",
    "utf8"
  )) as Record<string, unknown> & { stages: Array<Record<string, unknown>>; chrome_lease_contract: Record<string, unknown> };
  const manifest = manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(source));
  assert.equal(manifest.stages[0]?.browser_surface, "browser_use_cli");
  assert.equal(manifest.stages[0]?.lane, "browser_use_cli");
  assert.equal(manifest.chrome_lease_contract.surface, "browser_use_cli");
  assert.equal(manifest.chrome_lease_contract.schema, "automation_kernel_browser_use_stage_lease.v1");
  const compiled = manifestCompiler.compileAutomationKernelManifestV1(manifest, "browser-use-surface-run");
  assert.equal(compiled.definition.effects[0]?.payload.browser_surface, "browser_use_cli");

  const wrongLane = structuredClone(source);
  wrongLane.stages[0]!.lane = "in_app_browser";
  assert.throws(
    () => manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(wrongLane)),
    /automation_kernel_manifest_browser_use_cli_stage_invalid:root_controller_bootstrap/
  );

  const mixedContract = structuredClone(source);
  mixedContract.chrome_lease_contract.schema = "automation_kernel_browser_stage_lease.v1";
  assert.throws(
    () => manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(mixedContract)),
    /automation_kernel_manifest_chrome_lease_contract_invalid:schema/
  );
});

test("Browser Use metadata is canonical, origin-bound, and inert outside a matching stage", () => {
  const source = JSON.parse(readFileSync(
    "/Users/nichikatanaka/Documents/New project/.codex/automation-kernel/manifests/daily-ai-research-publish-run.json",
    "utf8"
  )) as Record<string, unknown> & { stages: Array<Record<string, unknown>>; browser_use: Record<string, unknown> };
  const manifest = manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(source));
  assert.equal(manifest.browser_use?.surface, "browser_use_cli");
  assert.equal(manifest.browser_use?.no_fallback, true);

  const invalid = (mutate: (copy: typeof source) => void, code: RegExp) => {
    const copy = structuredClone(source);
    mutate(copy);
    assert.throws(() => manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(copy)), code);
  };
  invalid((copy) => { copy.browser_use.helper_path = "/tmp/browser-use"; }, /browser_use_helper_noncanonical/);
  invalid((copy) => { copy.browser_use.profile_root = "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled-evil/profile"; }, /browser_use_profile_root_invalid/);
  invalid((copy) => { copy.browser_use.allowed_origins = ["http://127.0.0.1"]; }, /browser_use_allowed_origin_private/);
  invalid((copy) => { copy.browser_use.reserved_port = 19980; }, /browser_use_reserved_port_invalid/);
  invalid((copy) => { copy.browser_use.authority_ref = "../authority.json"; }, /browser_use_authority_ref_invalid/);
  invalid((copy) => { copy.browser_use.no_fallback = false; }, /browser_use_no_fallback_required/);

  const mixed = structuredClone(source);
  mixed.stages.find((stage) => stage.id === "browser_video_qa_no_post_preflight")!.browser_surface = "in_app_browser";
  mixed.stages.find((stage) => stage.id === "browser_video_qa_no_post_preflight")!.lane = "in_app_browser";
  assert.throws(
    () => manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(mixed)),
    /automation_kernel_manifest_browser_use_mixed_surface/
  );

  const inert = structuredClone(source);
  for (const stage of inert.stages) {
    if (stage.browser_surface !== undefined) {
      delete stage.browser_surface;
      stage.lane = "local_process";
    }
  }
  const inertManifest = manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(inert));
  const inertCompiled = manifestCompiler.compileAutomationKernelManifestV1(inertManifest, "browser-use-inert-run");
  assert.equal(inertCompiled.manifest.browser_use?.surface, "browser_use_cli");
  assert.equal(inertCompiled.definition.effects.some((effect) => effect.payload.browser_surface !== undefined), false);
});

test("IAB stage receipts fail closed without capability evidence", () => {
  const root = join(tempRoot, "chrome-capability-required");
  // Keep this compatibility regression independent from the live migrated
  // manifest, which now uses Browser Use CLI. The old IAB contract remains
  // rejected without its capability evidence, but is not a production route.
  const source = JSON.parse(readFileSync(
    "/Users/nichikatanaka/Documents/New project/.codex/automation-kernel/manifests/daily-ai-research-publish-run.json",
    "utf8"
  )) as Record<string, unknown> & { stages: Array<Record<string, unknown>>; chrome_lease_contract: Record<string, unknown> };
  for (const stage of source.stages) {
    if (stage.browser_surface === "browser_use_cli") {
      stage.browser_surface = "in_app_browser";
      stage.lane = "in_app_browser";
    }
  }
  delete source.browser_use;
  source.chrome_lease_contract = { ...source.chrome_lease_contract, schema: "automation_kernel_browser_stage_lease.v1", surface: "in_app_browser" };
  const manifest = join(tempRoot, "iab-compatibility-manifest.json");
  writeFileSync(manifest, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
  const base = { manifest, runId: "chrome-capability-required", root };
  control.runAutomationKernelControl({ ...base, action: "compile" });
  // Consume the current manifest's required local stages before the
  // readiness stage whose IAB admission contract this test exercises.
  for (const stageId of ["research_queue_refresh", "pre_entry_readiness", "pre_browser_readiness"]) {
    control.runAutomationKernelControl({ ...base, action: "claim", effectId: stageId });
    control.runAutomationKernelControl({
      ...base,
      action: "record",
      effectId: stageId,
      outcome: "succeeded",
      externalActionExecuted: false,
      summary: "local stage complete"
    });
  }
  assert.throws(
    () => control.runAutomationKernelControl({
      ...base,
      action: "claim",
      effectId: "browser_video_qa_no_post_preflight",
      unitId: "visual-preflight-1",
      outcome: undefined,
      externalActionExecuted: false,
      summary: undefined
    }),
    /automation_kernel_browser_use_cli_required:browser_video_qa_no_post_preflight/
  );
});

test("approval artifacts are private, content-addressed, current, and identity-bound", () => {
  const root = join(tempRoot, "approvals");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const payload = {
    schema: "automation_kernel_approval.v1",
    workflow_id: "heavy-chain",
    run_id: "approval-run",
    stage_id: "deploy",
    manifest_sha256: "a".repeat(64),
    approved: true,
    authorized_by: "current_user_turn",
    session_id: "session-a",
    turn_id: "turn-a",
    prompt_sha256: "b".repeat(64),
    issued_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString()
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  const file = join(root, `${createHash("sha256").update(bytes).digest("hex")}.json`);
  writeFileSync(file, bytes, { mode: 0o600 });
  chmodSync(file, 0o600);
  const approval = control.validateAutomationKernelApprovalFile(file, {
    workflowId: "heavy-chain",
    runId: "approval-run",
    stageId: "deploy",
    manifestSha256: "a".repeat(64),
    sessionId: "session-a",
    turnId: "turn-a",
    promptSha256: "b".repeat(64)
  });
  assert.equal(approval.approved, true);
  assert.throws(
    () => control.validateAutomationKernelApprovalFile(file, {
      workflowId: "heavy-chain",
      runId: "different-run",
      stageId: "deploy",
      manifestSha256: "a".repeat(64),
      sessionId: "session-a",
      turnId: "turn-a",
      promptSha256: "b".repeat(64)
    }),
    /automation_kernel_approval_identity_mismatch:run_id/
  );
  assert.throws(
    () => control.validateAutomationKernelApprovalFile(file, {
      workflowId: "heavy-chain",
      runId: "approval-run",
      stageId: "deploy",
      manifestSha256: "a".repeat(64),
      sessionId: "session-a",
      turnId: "different-turn",
      promptSha256: "b".repeat(64)
    }),
    /automation_kernel_approval_current_binding_mismatch:turn_id/
  );
});

test("manifest compiler rejects Chrome stages over five minutes and implicit effect classes", () => {
  const source = JSON.parse(
    readFileSync(
      "/Users/nichikatanaka/Documents/Codex/external-repos/heavy-chain/.codex/automation-kernel/manifests/heavy-chain.json",
      "utf8"
    )
  ) as Record<string, unknown> & { stages: Array<Record<string, unknown>> };
  // Keep this regression independent from the live Heavy Chain manifest. The
  // production surface is IAB-only now, so the external fixture may contain
  // no Chrome stage at all; the compiler rule still needs a deterministic
  // synthetic legacy stage to exercise its wall-clock guard.
  source.stages.push({
    id: "synthetic_chrome_stage",
    effect_class: "internal_idempotent",
    owner: "test",
    lane: "signed_chrome_extension_profile2",
    needs_chrome: true,
    chrome_lease: { mode: "jit_exclusive", scope: "stage", max_wall_seconds: 300 },
    replay: "safe",
    required: false,
    fan_out: { max_units_per_invocation: 1 },
    continuation: {
      mode: "fresh_preflight_per_invocation",
      fresh_preflight_required: true,
      reuse_prior_receipt: false
    }
  });
  const tooLong = structuredClone(source);
  (tooLong.stages.find((stage) => stage.id === "synthetic_chrome_stage")!.chrome_lease as Record<string, unknown>).max_wall_seconds = 301;
  assert.throws(
    () => manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(tooLong)),
    /automation_kernel_manifest_chrome_stage_wall_invalid/
  );
  const implicitClass = structuredClone(source);
  delete implicitClass.stages[0]!.effect_class;
  assert.throws(
    () => manifestCompiler.parseAutomationKernelManifestTextV1(JSON.stringify(implicitClass)),
    /automation_kernel_manifest_stage_effect_class_invalid/
  );
});

test("repository keeps private modes, rejects traversal and symlinks, and never steals leftover locks", () => {
  const root = join(tempRoot, "hardening");
  repository.ensureKernelDefinition({ definition, root });
  const canonicalRoot = repository.automationKernelRoot(root);
  assert.equal(lstatSync(canonicalRoot).mode & 0o777, 0o700);
  assert.equal(lstatSync(repository.kernelDirectory(definition.kernel_id, root)).mode & 0o777, 0o700);
  assert.equal(lstatSync(repository.definitionPath(definition.kernel_id, root)).mode & 0o777, 0o600);
  assert.throws(
    () => repository.automationKernelArtifactPath({ kernelId: definition.kernel_id, root, suffix: "../../escape.json" }),
    /kernel_path_escape/
  );

  const lock = repository.acquireKernelLock({ kernelId: definition.kernel_id, root, owner: "first" });
  assert.throws(() => repository.acquireKernelLock({ kernelId: definition.kernel_id, root, owner: "second" }), /kernel_locked/);
  lock.release();
  const lockPath = repository.kernelLockPath(definition.kernel_id, root);
  writeFileSync(lockPath, `${JSON.stringify({ pid: 99999999, token: "leftover" })}\n`, { mode: 0o600 });
  chmodSync(lockPath, 0o600);
  assert.throws(() => repository.acquireKernelLock({ kernelId: definition.kernel_id, root, owner: "third" }), /kernel_locked/);

  const realRoot = join(tempRoot, "real-root");
  mkdirSync(realRoot, { recursive: true, mode: 0o700 });
  const symlinkRoot = join(tempRoot, "symlink-root");
  symlinkSync(realRoot, symlinkRoot);
  assert.throws(() => repository.automationKernelRoot(symlinkRoot), /kernel_root_symlink_forbidden/);

  const permissiveRoot = join(tempRoot, "permissive-existing-root");
  mkdirSync(permissiveRoot, { recursive: true, mode: 0o755 });
  chmodSync(permissiveRoot, 0o755);
  assert.throws(() => repository.automationKernelRoot(permissiveRoot), /kernel_directory_permissions_invalid/);
  assert.equal(lstatSync(permissiveRoot).mode & 0o777, 0o755);
});

test("repository rejects hardlinked immutable state", () => {
  const root = join(tempRoot, "hardlink");
  repository.ensureKernelDefinition({ definition: { ...definition, kernel_id: "kernel-hardlink" }, root });
  const source = repository.definitionPath("kernel-hardlink", root);
  const alias = join(tempRoot, "definition-hardlink-alias.json");
  linkSync(source, alias);
  assert.throws(
    () => repository.loadKernelDefinition({ kernelId: "kernel-hardlink", root }),
    /kernel_file_(?:invalid|hardlink_forbidden)/
  );
});

test("timeline tampering is detected before a new claim or receipt", () => {
  const root = join(tempRoot, "tamper");
  const claim = repository.claimKernelEffect({
    definition,
    root,
    claimedBy: "tamper-test",
    createdAt: "2026-07-16T00:00:00.000Z"
  });
  const path = repository.timelinePath(claim.definition.kernel_id, root);
  const line = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
  line.entry_hash = "0".repeat(64);
  writeFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  assert.throws(() => repository.readKernelTimeline({ kernelId: claim.definition.kernel_id, root }), /kernel_timeline_entry_hash_mismatch/);
});

test("result-v2 is strict and must match the persisted ambiguous external receipt", () => {
  const root = join(tempRoot, "result-v2");
  const externalDefinition = contracts.parseAutomationKernelDefinitionV1({
    schema_version: "automation_kernel.v1",
    kernel_id: "kernel-result",
    title: "Kernel Result",
    heartbeat_owner: "caller",
    effects: [{ effect_id: "send", effect_class: "external_non_idempotent", summary: "Send", payload: {} }],
    metadata: { workflow_id: "workflow-result", run_id: "run-result" }
  });
  const claim = repository.claimKernelEffect({
    definition: externalDefinition,
    root,
    claimedBy: "result-test",
    createdAt: "2026-07-16T00:00:00.000Z"
  });
  const receipt = repository.recordKernelReceipt({
    kernelId: externalDefinition.kernel_id,
    root,
    effectId: "send",
    effectClass: "external_non_idempotent",
    outcome: "ambiguous",
    externalActionExecuted: true,
    summary: "ambiguous external result",
    createdAt: "2026-07-16T00:00:01.000Z"
  });
  const result = kernelResult.createAutomationKernelResultV2({
    automationId: "automation-3",
    workflowId: "workflow-result",
    runId: "run-result",
    terminalStatus: "blocked",
    selectedStages: ["send"],
    stageResults: [{
      stage_id: "send",
      status: "reconciliation_required",
      exact_blocker: receipt.snapshot.exact_blocker,
      artifact_uris: ["artifact://ambiguous"],
      cleanup_proof: "cleanup://done",
      claim_id: claim.snapshot.effects[0]!.claim_id,
      receipt_id: receipt.snapshot.effects[0]!.receipt_id,
      proof_uri: "artifact://ambiguous",
      details: {}
    }],
    exactBlocker: receipt.snapshot.exact_blocker,
    restartStage: "send",
    artifactUris: ["artifact://ambiguous"],
    cleanupProof: "cleanup://done"
  });
  assert.equal(result.automation_id, "automation-3");
  assert.equal(kernelResult.parseAutomationKernelResultV2(result).automation_id, "automation-3");
  const { automation_id: _legacyAutomationId, ...legacyResult } = result;
  assert.equal(kernelResult.parseAutomationKernelResultV2(legacyResult).automation_id, undefined);
  assert.throws(
    () => kernelResult.parseAutomationKernelResultV2({ ...result, automation_id: "" }),
    /automation_kernel_result_automation_id/
  );
  assert.doesNotThrow(() => kernelResult.assertAutomationKernelResultMatchesSnapshot(result, externalDefinition, receipt.snapshot));
  assert.throws(
    () => kernelResult.assertAutomationKernelResultMatchesSnapshot({ ...result, run_id: "other" }, externalDefinition, receipt.snapshot),
    /automation_kernel_result_identity_mismatch/
  );
});

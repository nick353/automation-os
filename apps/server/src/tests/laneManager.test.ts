import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateParallelLanes,
  assertRegisteredBrowserLaneRegistry,
  canParallelCommit,
  detectResourceCollisions,
  registeredBrowserLaneForWorkflow,
  registeredBrowserLanes
} from "../runs/laneManager.js";
import { assertBrowserUseLaneBinding, browserUseLaneFor, profileLockPathFor } from "../serviceReadiness/browserUseLifecycle.js";

test("allocates isolated profile, port, and workdir per task", () => {
  const plan = allocateParallelLanes([
    { id: "a", name: "Daily AI", resources: ["x_publish"] },
    { id: "b", name: "Runway", resources: ["runway_mcp"] }
  ], { lifecycle: "single_use" });

  assert.equal(plan.lanes.length, 2);
  assert.equal(plan.lanes[0].cdpPort, 19980);
  assert.equal(plan.lanes[1].cdpPort, 19981);
  assert.equal(plan.lanes[0].browserUseCdpUrl, "http://127.0.0.1:19980");
  assert.equal(plan.lanes[1].browserUseCdpUrl, "http://127.0.0.1:19981");
  assert.equal(plan.lanes[0].browserUseProfile, plan.lanes[0].profileDir);
  assert.match(plan.lanes[0].browserUseSession, /^browser-use-a$/);
  assert.equal(plan.lanes[0].profileStrategy, "browser_use_cli_lifecycle");
  assert.equal(plan.lanes[0].lifecycle, "single_use");
  assert.equal(plan.lanes[0].laneVisibility, "visible");
  assert.notEqual(plan.lanes[0].profileDir, plan.lanes[1].profileDir);
  assert.equal(plan.collisions.length, 0);
});

test("surfaces resource collisions", () => {
  const collisions = detectResourceCollisions([
    { id: "a", name: "X post", resources: ["social_publish"] },
    { id: "b", name: "LinkedIn post", resources: ["social_publish"] }
  ]);

  assert.deepEqual(collisions, [{ resource: "social_publish", taskIds: ["a", "b"] }]);
});

test("blocks lanes with generated ids when resources collide", () => {
  const plan = allocateParallelLanes([
    { name: "X post", resources: ["social_publish"] },
    { name: "LinkedIn post", resources: ["social_publish"] }
  ]);

  assert.equal(plan.collisions.length, 1);
  assert.equal(plan.lanes[0].status, "blocked");
  assert.equal(plan.lanes[1].status, "blocked");
  assert.deepEqual(plan.lanes[0].collisionWith, ["social_publish"]);
  assert.deepEqual(plan.lanes[1].collisionWith, ["social_publish"]);
});

test("allows approved all-parallel commits even when collisions are visible", () => {
  assert.equal(canParallelCommit(false, [{ resource: "social_publish", taskIds: ["a", "b"] }]), false);
  assert.equal(canParallelCommit(true, [{ resource: "social_publish", taskIds: ["a", "b"] }]), true);
});

test("registered browser lanes reserve unique ports and profiles per workflow", () => {
  assert.doesNotThrow(() => assertRegisteredBrowserLaneRegistry());
  assert.equal(new Set(registeredBrowserLanes.map((lane) => lane.cdpPort)).size, registeredBrowserLanes.length);
  assert.equal(new Set(registeredBrowserLanes.map((lane) => lane.profileDir)).size, registeredBrowserLanes.length);

  const dailyAiLane = registeredBrowserLaneForWorkflow("daily-ai-research-publish-run");
  assert.equal(dailyAiLane?.cdpPort, 19882);
  assert.equal(dailyAiLane?.profileDir, "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/daily-ai");
  assert.equal(dailyAiLane?.lifecycle, "scheduled");
  assert.equal(dailyAiLane?.laneVisibility, "headless");
  assert.equal(dailyAiLane?.cleanupStrategy, "port_and_profile_owned_processes");
  assert.equal(dailyAiLane?.webOperationContract, "automation_os_web_operation_contract.v1");

  const xLane = registeredBrowserLaneForWorkflow("x-authenticated-browser-lane");
  assert.equal(xLane?.cdpPort, 19885);
  assert.equal(xLane?.profileDir, "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/x-authenticated-browser-lane");
  assert.equal(xLane?.laneVisibility, "visible");

  const youtubeLane = registeredBrowserLaneForWorkflow("youtube-visible-transcript-capture");
  assert.equal(youtubeLane?.cdpPort, 20080);
  assert.equal(youtubeLane?.profileDir, "/Users/nichikatanaka/.browser-use-cli/profiles/temporary/youtube-visible-transcript");
  assert.equal(youtubeLane?.laneVisibility, "visible");
});

test("automatically separates one-shot, temporary, and scheduled Browser Use CLI lanes", () => {
  const oneShot = browserUseLaneFor({ lifecycle: "single_use", ownerKey: "run-one-shot-1", workflowId: "public-read" });
  const temporary = browserUseLaneFor({ lifecycle: "temporary", ownerKey: "run-temporary-1", workflowId: "user-handoff" });
  const scheduled = browserUseLaneFor({ lifecycle: "scheduled", ownerKey: "automation-3", workflowId: "job-application-manager" });

  assertBrowserUseLaneBinding(oneShot);
  assertBrowserUseLaneBinding(temporary);
  assertBrowserUseLaneBinding(scheduled);
  assert.equal(oneShot.surface, "browser_use_cli");
  assert.equal(temporary.surface, "browser_use_cli");
  assert.equal(scheduled.surface, "browser_use_cli");
  assert.equal(scheduled.reserved_port, 19881);
  assert.match(oneShot.profile_dir, /\/profiles\/single-use\//);
  assert.match(temporary.profile_dir, /\/profiles\/temporary\//);
  assert.match(scheduled.profile_dir, /\/profiles\/scheduled\/automation-3$/);
  assert.notEqual(oneShot.reserved_port, temporary.reserved_port);
  assert.notEqual(oneShot.profile_dir, temporary.profile_dir);
  assert.notEqual(temporary.profile_dir, scheduled.profile_dir);
  assert.equal(oneShot.lock_path, profileLockPathFor(oneShot.profile_dir));
  assert.equal(temporary.lock_path, profileLockPathFor(temporary.profile_dir));
  assert.equal(scheduled.lock_path, profileLockPathFor(scheduled.profile_dir));
  assert.notEqual(oneShot.lock_path, temporary.lock_path);
  assert.notEqual(temporary.lock_path, scheduled.lock_path);
});

test("automatic lane allocation classifies lifecycle from the task and keeps ranges isolated", () => {
  const plan = allocateParallelLanes([
    { id: "public-one-shot", name: "public read one-shot" },
    { id: "user-handoff", name: "temporary user handoff" },
    { id: "job-recurring", name: "job-application-manager recurring" }
  ]);

  assert.deepEqual(plan.lanes.map((lane) => lane.lifecycle), ["single_use", "temporary", "scheduled"]);
  assert.ok(plan.lanes[0].cdpPort >= 19980 && plan.lanes[0].cdpPort <= 19999);
  assert.ok(plan.lanes[1].cdpPort >= 20080 && plan.lanes[1].cdpPort <= 20099);
  assert.equal(plan.lanes[2].cdpPort, 19881);
  assert.equal(new Set(plan.lanes.map((lane) => lane.cdpPort)).size, 3);
  assert.ok(plan.lanes.every((lane) => lane.profileStrategy === "browser_use_cli_lifecycle"));
});

test("human-readable registered workflow commands resolve to the owned scheduled profile first", () => {
  const plan = allocateParallelLanes([
    { id: "task-1", name: "Job Application Manager registered workflow billing-only inbox readback and submit" },
    { id: "task-2", name: "Daily AI registered workflow research and publish" },
    { id: "task-3", name: "NisenPrints registered workflow product sync" }
  ]);

  assert.deepEqual(plan.lanes.map((lane) => lane.lifecycle), ["scheduled", "scheduled", "scheduled"]);
  assert.deepEqual(plan.lanes.map((lane) => lane.cdpPort), [19881, 19882, 19884]);
  assert.deepEqual(plan.lanes.map((lane) => lane.browserUseProfile), [
    "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/automation-3",
    "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/daily-ai",
    "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/nisenprints"
  ]);
});

test("scheduled workflow profiles own distinct canonical profile locks", () => {
  const lanes = [
    browserUseLaneFor({ lifecycle: "scheduled", ownerKey: "job-application-manager", workflowId: "job-application-manager" }),
    browserUseLaneFor({ lifecycle: "scheduled", ownerKey: "daily-ai-research-publish-run", workflowId: "daily-ai-research-publish-run" }),
    browserUseLaneFor({ lifecycle: "scheduled", ownerKey: "nisenprints-daily-product-canva-printify-etsy-pinterest", workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest" })
  ];
  assert.equal(new Set(lanes.map((lane) => lane.profile_dir)).size, 3);
  assert.equal(new Set(lanes.map((lane) => lane.lock_path)).size, 3);
  for (const lane of lanes) {
    assert.equal(lane.lock_path, profileLockPathFor(lane.profile_dir));
    assertBrowserUseLaneBinding(lane);
  }
});

test("fails closed when a browser lane lock does not match its profile", () => {
  const lane = browserUseLaneFor({ lifecycle: "scheduled", ownerKey: "daily-ai", workflowId: "daily-ai-research-publish-run" });
  assert.throws(
    () => assertBrowserUseLaneBinding({ ...lane, lock_path: "/Users/nichikatanaka/.browser-use-cli/locks/wrong-owner.lock" }),
    /browser_use_lane_lock_profile_mismatch/
  );
});

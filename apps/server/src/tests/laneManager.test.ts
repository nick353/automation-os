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

test("allocates isolated profile, port, and workdir per task", () => {
  const plan = allocateParallelLanes([
    { id: "a", name: "Daily AI", resources: ["x_publish"] },
    { id: "b", name: "Runway", resources: ["runway_mcp"] }
  ]);

  assert.equal(plan.lanes.length, 2);
  assert.equal(plan.lanes[0].cdpPort, 9445);
  assert.equal(plan.lanes[1].cdpPort, 9446);
  assert.equal(plan.lanes[0].browserUseCdpUrl, "http://127.0.0.1:9445");
  assert.equal(plan.lanes[1].browserUseCdpUrl, "http://127.0.0.1:9446");
  assert.equal(plan.lanes[0].browserUseProfile, plan.lanes[0].profileDir);
  assert.match(plan.lanes[0].browserUseSession, /^browser-use-a$/);
  assert.equal(plan.lanes[0].profileStrategy, "cdp_profile_lane");
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
  assert.equal(dailyAiLane?.cdpPort, 9333);
  assert.equal(dailyAiLane?.profileDir, "/Users/nichikatanaka/.daily-ai-playwright-chrome");
  assert.equal(dailyAiLane?.laneVisibility, "headless");
  assert.equal(dailyAiLane?.cleanupStrategy, "port_and_profile_owned_processes");

  const xLane = registeredBrowserLaneForWorkflow("x-authenticated-browser-lane");
  assert.equal(xLane?.cdpPort, 9336);
  assert.equal(xLane?.profileDir, "/Users/nichikatanaka/.x-learning-playwright-chrome");
  assert.equal(xLane?.laneVisibility, "visible");

  const youtubeLane = registeredBrowserLaneForWorkflow("youtube-visible-transcript-capture");
  assert.equal(youtubeLane?.cdpPort, 9337);
  assert.equal(youtubeLane?.profileDir, "/Users/nichikatanaka/.youtube-transcript-playwright-chrome");
  assert.equal(youtubeLane?.laneVisibility, "visible");
});

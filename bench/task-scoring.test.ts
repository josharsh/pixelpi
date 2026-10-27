import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTask, summarizeTasks } from "./task-scoring";

test("authentication error containing an expected answer cannot pass or become a scored failure", () => {
  const status = scoreTask("error", "HTTP 401 Example Domain", ["Example Domain"]);
  assert.equal(status, "error");
  assert.deepEqual(summarizeTasks([{ status }, { status: "not_run" }]), {
    passed: 0, evaluated: 0, total: 2, successRate: null,
  });
});

test("missing ground truth is unscored, including empty strings", () => {
  assert.equal(scoreTask("done", "anything", []), "unscored");
  assert.equal(scoreTask("done", "anything", [""]), "unscored");
});

test("blocked and budget-limited tasks remain real failures", () => {
  assert.equal(scoreTask("blocked", "BLOCKED: Example Domain", ["Example Domain"]), "fail");
  assert.equal(scoreTask("max_steps", "Example Domain", ["Example Domain"]), "fail");
  assert.equal(scoreTask("done", "wrong", ["Example Domain"]), "fail");
  assert.equal(scoreTask("done", "EXAMPLE\nDOMAIN", ["Example Domain"]), "pass");
  assert.equal(summarizeTasks([{ status: "pass" }, { status: "fail" }]).successRate, 0.5);
});

test("an incomplete suite never reports a headline percentage", () => {
  assert.equal(summarizeTasks([{ status: "pass" }, { status: "error" }]).successRate, null);
  assert.equal(summarizeTasks([]).successRate, null);
});

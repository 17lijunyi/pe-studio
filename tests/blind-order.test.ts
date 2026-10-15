import test from "node:test";
import assert from "node:assert/strict";
import { createCandidateOrder } from "../lib/blind-order";
import { blindLabel, orderedCandidateIds } from "../components/studio/blind-label";

const ids = ["writer-1", "writer-2", "writer-3"] as const;

test("a new round can assign every A/B/C permutation without changing request IDs", () => {
  const seen = new Set<string>();
  for (const first of [0, 0.5, 0.999999]) {
    for (const second of [0, 0.999999]) {
      const samples = [first, second];
      const order = createCandidateOrder(ids, () => samples.shift()!);
      assert.deepEqual([...order].sort(), [...ids]);
      assert.notEqual(order, ids);
      assert.deepEqual(ids, ["writer-1", "writer-2", "writer-3"]);
      assert.equal(samples.length, 0);
      seen.add(order.join(","));
      for (const [index, id] of order.entries()) assert.equal(blindLabel(id, order), "ABC"[index]);
    }
  }
  assert.equal(seen.size, 6);
  // A random round may legitimately keep the preceding assignment.
  assert.deepEqual(createCandidateOrder(ids, () => 0.999999), [...ids]);
});

test("display order survives different arrival order and preserves missing-result letters", () => {
  const savedOrder = ["writer-3", "writer-1", "writer-2"];
  const roundOrder = JSON.parse(JSON.stringify(savedOrder)) as string[];
  assert.deepEqual(orderedCandidateIds(["writer-2", "writer-1", "writer-3"], roundOrder), savedOrder);
  assert.deepEqual(orderedCandidateIds(["writer-2", "writer-3"], roundOrder), ["writer-3", "writer-2"]);
  assert.equal(blindLabel("writer-2", roundOrder), "C");
  assert.equal(blindLabel("writer-1", roundOrder), "B");
  assert.deepEqual(roundOrder, savedOrder);
});

test("legacy records retain their original writer/demo ordering without a round assignment", () => {
  assert.deepEqual(orderedCandidateIds(["writer-3", "writer-1", "writer-2"]), [...ids]);
  assert.deepEqual(orderedCandidateIds(["demo-c", "demo-a", "demo-b"]), ["demo-a", "demo-b", "demo-c"]);
  assert.equal(blindLabel("writer-2"), "B");
  assert.equal(blindLabel("demo-c"), "C");
  assert.equal(blindLabel("unknown"), "结果");
  assert.deepEqual(orderedCandidateIds(["writer-1", "writer-3", "writer-2"], ["writer-3"]), ["writer-3", "writer-1", "writer-2"]);
});

test("shuffle has independent output and cannot introduce invalid IDs from an invalid random source", () => {
  assert.deepEqual(createCandidateOrder([]), []);
  assert.deepEqual(createCandidateOrder(["writer-1", "writer-1"]), ["writer-1"]);
  for (const invalid of [-1, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createCandidateOrder(ids, () => invalid), RangeError);
    assert.deepEqual(ids, ["writer-1", "writer-2", "writer-3"]);
  }
});

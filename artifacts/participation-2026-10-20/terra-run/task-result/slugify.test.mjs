import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { slugify } from "./slugify.mjs";

test("slugifies the documented examples", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("Café déjà vu"), "cafe-deja-vu");
  assert.equal(slugify("  A__B  "), "a-b");
});

test("returns an empty slug for empty and punctuation-only input", () => {
  assert.equal(slugify(""), "");
  assert.equal(slugify("!?..."), "");
});

test("collapses repeated separators", () => {
  assert.equal(slugify("one --- two___three"), "one-two-three");
});

test("rejects non-string values", () => {
  assert.throws(() => slugify(null), TypeError);
  assert.throws(() => slugify(42), TypeError);
});

test("CLI prints a slug for joined arguments", () => {
  const result = spawnSync(process.execPath, ["cli.mjs", "Hello,", "World!"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello-world\n");
  assert.equal(result.stderr, "");
});

test("CLI reports usage and fails without arguments", () => {
  const result = spawnSync(process.execPath, ["cli.mjs"], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /usage/i);
});

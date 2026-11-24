import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scratch = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(scratch);
const vitest = path.join(repository, "node_modules/vitest/vitest.mjs");
const notice = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 153h38m14s";
const error = "agy rate limit (ResourceExhausted): Antigravity quota exhausted; resets in 153h38m14s";
const outcomes = {};
for (const variant of ["baseline", "candidate"]) {
 const output = path.join(scratch, `${variant}-observations.json`);
 const args = [vitest, "run", "tests/point4-differential.probe.test.ts", "--testTimeout=3000", "--reporter=verbose"];
 console.log(`RUN ${variant}: ${process.execPath} ${args.join(" ")}`);
 const run = spawnSync(process.execPath, args, {
  cwd: path.join(scratch, variant),
  env: { ...process.env, POINT4_VARIANT: variant, POINT4_RESULT: output },
  encoding: "utf8", timeout: 25000, maxBuffer: 2 * 1024 * 1024,
 });
 outcomes[variant] = { status: run.status, signal: run.signal, error: run.error?.message ?? null };
 fs.writeFileSync(path.join(scratch, `${variant}-stdout.log`), run.stdout ?? "");
 fs.writeFileSync(path.join(scratch, `${variant}-stderr.log`), run.stderr ?? "");
 console.log(`EXIT ${variant}: ${JSON.stringify(outcomes[variant])}`);
 console.log(`STDOUT ${variant}:\n${run.stdout ?? ""}`);
 console.log(`STDERR ${variant}:\n${run.stderr ?? ""}`);
}
assert.equal(outcomes.baseline.status, 0, "baseline probe must finish successfully");
assert.equal(outcomes.candidate.status, 0, "candidate probe must finish successfully");
const baseline = JSON.parse(fs.readFileSync(path.join(scratch, "baseline-observations.json"), "utf8"));
const candidate = JSON.parse(fs.readFileSync(path.join(scratch, "candidate-observations.json"), "utf8"));
let assertions = 0;
function equal(actual, expected, label) {
 assert.deepStrictEqual(actual, expected, label);
 assertions++;
}
equal(Object.keys(candidate).sort(), Object.keys(baseline).sort(), "identical scenario sets");
const preserved = [
 "ordinary discussion, quoted notice and suffix prose remain successful",
 "thoughts and tools prevent classification",
 "native errors and aborts retain their reasons",
 "a parked bridge call keeps toolUse and a notice-bearing continuation resumes its binding",
 "live continuation redelivers a tool result and preserves native stop or error",
];
for (const name of preserved) {
 assert.ok(baseline[name], `missing preserved scenario ${name}`);
 equal(candidate[name], baseline[name], `unchanged public terminals and requests: ${name}`);
 console.log(`MATCH ${name}`);
}
for (const engine of ["stream-json", "acp"]) {
 for (const stage of ["first", "bound"]) {
  const name = `${engine}: ${stage} quota context comparison`;
  const before = baseline[name];
  const after = candidate[name];
  assert.ok(before && after, `missing quota scenario ${name}`);
  const quotaIndex = stage === "first" ? 0 : 1;
  const followup = quotaIndex + 1;
  equal(before.terminals[quotaIndex].type, "done", `${name}: baseline successful event`);
  equal(before.terminals[quotaIndex].reason, "stop", `${name}: baseline stop`);
  equal(before.terminals[quotaIndex].content, [{ type: "text", text: notice }], `${name}: baseline notice`);
  equal(after.terminals[quotaIndex].type, "error", `${name}: candidate error event`);
  equal(after.terminals[quotaIndex].reason, "error", `${name}: candidate error reason`);
  equal(after.terminals[quotaIndex].errorMessage, error, `${name}: sanitized retryable message`);
  equal(before.requests[followup].conversationId, "conv", `${name}: baseline binding`);
  equal(after.requests[followup].conversationId, stage === "first" ? null : "conv", `${name}: candidate binding`);
  const contextPayload = (request) => engine === "acp" ? request.contextBlock?.text ?? "" : request.prompt;
  equal(contextPayload(after.requests[followup]).includes("missed"), true, `${name}: missed context retained in delivery channel`);
  equal(contextPayload(before.requests[followup]).includes("missed"), false, `${name}: baseline advances watermark`);
  equal(after.terminals[followup], before.terminals[followup], `${name}: successful follow-up unchanged`);
  equal(after.requests.slice(0, followup), before.requests.slice(0, followup), `${name}: pre-quota requests unchanged`);
  if (stage === "bound") equal(after.terminals[0], before.terminals[0], `${name}: initial success unchanged`);
  console.log(`EXPECTED_DIFFERENCE ${name}`);
 }
}
console.log(`PASS: ${preserved.length + 4} scenarios; ${assertions} comparison assertions; both subprocesses exit 0.`);

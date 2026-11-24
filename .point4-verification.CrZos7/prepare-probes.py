from pathlib import Path

root = Path(__file__).resolve().parent
source = (root / 'candidate/tests/provider-quota.test.ts').read_text()
header = source.split('for (const engine of ["stream-json", "acp"] as const) {', 1)[0]
unchanged = source.split('test("ordinary discussion, quoted notice and suffix prose remain successful"', 1)[1]
unchanged = 'test("ordinary discussion, quoted notice and suffix prose remain successful"' + unchanged.split('function userMessage', 1)[0]
public_tools = 'function userMessage' + source.split('function userMessage', 1)[1]
probe = header + unchanged + public_tools
probe = probe.replace('afterEach, beforeEach, test, vi', 'afterAll, afterEach, beforeEach, test, vi')
probe = probe.replace('const dirs: string[] = [];', '''interface Trace { requests: unknown[]; terminals: unknown[] }
const traces: Record<string, Trace> = {};
let activeTrace: Trace;
const candidate = process.env.POINT4_VARIANT === "candidate";
function recordRequest(request: DriverTurnRequest): void {
 activeTrace.requests.push({ conversationId: request.conversationId, prompt: request.prompt });
}
function recordTerminal(event: unknown): void {
 const e = event as { type: string; reason: string; message?: { content: unknown }; error?: { content: unknown; errorMessage?: string } };
 activeTrace.terminals.push({ type: e.type, reason: e.reason, content: (e.message ?? e.error)?.content, errorMessage: e.error?.errorMessage ?? null });
}
afterAll(() => {
 const output = process.env.POINT4_RESULT;
 if (!output) throw new Error("Missing POINT4_RESULT");
 fs.writeFileSync(output, JSON.stringify(traces, null, 2));
});
const dirs: string[] = [];''')
probe = probe.replace('beforeEach(() => {', 'beforeEach((context) => { activeTrace = { requests: [], terminals: [] }; traces[context.task.name] = activeTrace;')
probe = probe.replace('requests.push(request);', 'requests.push(request); recordRequest(request);')
probe = probe.replace('  return terminal;', '  recordTerminal(terminal); return terminal;')
probe = probe.replace('\treturn last;', '\trecordTerminal(last); return last;')
probe += '''
function assertQuotaTerminal(event: Awaited<ReturnType<ReturnType<typeof harness>["run"]>>): void {
 assert.equal(event.type, candidate ? "error" : "done");
 if (candidate) {
  assert.equal(event.type, "error");
  if (event.type !== "error") throw new Error("Missing quota error");
  assert.equal(event.reason, "error");
  assert.equal(event.error.errorMessage, error);
  assert.equal(isRetryableAssistantError(event.error), true);
 } else {
  assert.equal(event.type, "done");
  if (event.type !== "done") throw new Error("Missing baseline stop");
  assert.equal(event.reason, "stop");
 }
}
for (const engine of ["stream-json", "acp"] as const) {
 test(`${engine}: first quota context comparison`, async () => {
  const h = harness([{ response: notice }, { response: "ok" }], engine);
  assertQuotaTerminal(await h.run(["missed"]));
  assert.equal((await h.run(["missed", "next"])).type, "done");
  assert.equal(h.requests[1].conversationId, candidate ? null : "conv");
  assert.equal(h.requests[1].prompt.includes("missed"), candidate);
 });
 test(`${engine}: bound quota context comparison`, async () => {
  const h = harness([{ response: "ok" }, { response: notice }, { response: "ok" }], engine);
  assert.equal((await h.run(["first"])).type, "done");
  assertQuotaTerminal(await h.run(["first", "missed"]));
  assert.equal((await h.run(["first", "missed", "next"])).type, "done");
  assert.equal(h.requests[2].conversationId, "conv");
  assert.equal(h.requests[2].prompt.includes("missed"), candidate);
 });
}
'''
name = 'point4-differential.probe.test.ts'
for variant in ('baseline', 'candidate'):
    (root / variant / 'tests' / name).write_text(probe)
assert (root / 'baseline/tests' / name).read_bytes() == (root / 'candidate/tests' / name).read_bytes()
print('Identical public-interface probes prepared; 5 preservation and 4 quota/context scenarios.')

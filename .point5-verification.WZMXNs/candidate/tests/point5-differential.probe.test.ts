import assert from "node:assert/strict";
import os from "node:os";
import { test, vi } from "vitest";
import { AcpConnection } from "../src/acp/connection.js";
import { JsonRpcResponseError } from "../src/acp/jsonrpc.js";

function conn(binArgs: string[] = [], onExit = (_: unknown) => {}) {
  return new AcpConnection({ cwd: os.tmpdir(), bin: process.execPath, binArgs, log: () => {}, onUpdate: () => {}, onExit });
}
test("point5 public differential cases", async () => {
  const out: any = {};
  for (const method of ["new", "load"] as const) {
    const c = conn(); const err = new Error("same plain failure");
    const spy = vi.spyOn(c, "request").mockRejectedValue(err);
    try { let caught: any; try { method === "new" ? await c.newSession(os.tmpdir()) : await c.loadSession("s", os.tmpdir()); } catch (e) { caught = e; }
      out[`${method}Plain`] = { same: caught === err, message: caught?.message, name: caught?.name, causeSame: caught?.cause === err, calls: spy.mock.calls.length };
    } finally { spy.mockRestore(); }
  }
  {
    const c = conn(); const err = new JsonRpcResponseError({ code: -32001, message: "ACP request timed out after 20000ms: session/new" });
    vi.spyOn(c, "request").mockRejectedValue(err); let caught: any;
    try { await c.newSession(os.tmpdir()); } catch (e) { caught = e; }
    out.remote = { same: caught === err, message: caught?.message, name: caught?.name, cause: caught?.cause?.message };
  }
  for (const method of ["new", "load"] as const) {
    const c = conn(); const timeout = `ACP request timed out after 20000ms: session/${method}`; const err = new Error(timeout); const spy = vi.spyOn(c, "request").mockRejectedValue(err); let caught: any;
    try { method === "new" ? await c.newSession(os.tmpdir()) : await c.loadSession("s", os.tmpdir()); } catch (e) { caught = e; }
    out[`${method}Timeout`] = { same: caught === err, message: caught?.message, name: caught?.name, causeSame: caught?.cause === err, calls: spy.mock.calls.length };
  }
  const exits: any[] = [];
  const c = conn(["-e", `process.stdin.on('data',d=>{for(const l of String(d).trim().split('\\n')){const m=JSON.parse(l);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}))}});`], x => exits.push(x));
  await c.start();
  try {
    vi.useFakeTimers(); const timerRequest = c.request("other/method", {}, 20_000).then(()=>null,e=>e);
    await vi.advanceTimersByTimeAsync(20_000); const te = await timerRequest;
    out.genericTimeout = { message: te?.message, alive: c.alive, exits: exits.length };
    const pending = c.request("pending/method", {}, 20_000).then(()=>null,e=>e);
    c.kill(); const ke = await pending;
    out.kill = { message: ke?.message, alive: c.alive, exits: exits.length, exit: exits[0] ?? null };
  } finally { vi.useRealTimers(); c.kill(); }
  process.stdout.write("POINT5_JSON:"+JSON.stringify(out)+"\n");
});

/**
 * gramjs prints a stack trace for every keep-alive timeout of its update loop (and then reconnects).
 * quietKeepAliveTimeouts turns those into one rate-limited warning and leaves all other errors alone.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { LogLevel } from "telegram/extensions/Logger.js";
import { createTelegramClient, quietKeepAliveTimeouts } from "../../packages/telegram/dist/index.js";

const UPDATES_STACK = [
  "Error: TIMEOUT",
  "    at D:\\x\\node_modules\\telegram\\client\\updates.js:250:85",
  "    at async attempts (D:\\x\\node_modules\\telegram\\client\\updates.js:234:20)",
  "    at async _updateLoop (D:\\x\\node_modules\\telegram\\client\\updates.js:184:17)"
].join("\n");

function keepAliveTimeout() {
  const err = new Error("TIMEOUT");
  err.stack = UPDATES_STACK;
  return err;
}

function setup() {
  const sink = { warnings: [], errors: [], warn(m) { this.warnings.push(m); }, error(e) { this.errors.push(e); } };
  const client = createTelegramClient({ apiId: 1, apiHash: "0".repeat(32) });
  quietKeepAliveTimeouts(client, sink); // same wiring, with a capturing sink
  return { client, sink };
}

/** Mimics gramjs' update loop: report to the handler, then print if the ERROR level allows it. */
async function reportLikeGramjs(client, err) {
  await client._errorHandler(err);
  return client._log.canSend(LogLevel.ERROR);
}

test("keep-alive timeout: gramjs' stack-trace print is vetoed and replaced by one short warning", async () => {
  const { client, sink } = setup();
  assert.equal(await reportLikeGramjs(client, keepAliveTimeout()), false, "no console.error stack trace");
  assert.equal(sink.warnings.length, 1);
  assert.match(sink.warnings[0], /keep-alive ping timed out 1x .*reconnecting automatically/);
  assert.equal(sink.errors.length, 0);
});

test("the veto applies to exactly one print, so unrelated errors are never swallowed", async () => {
  const { client } = setup();
  await client._errorHandler(keepAliveTimeout());
  assert.equal(client._log.canSend(LogLevel.ERROR), false, "the print that follows the timeout is vetoed");
  assert.equal(client._log.canSend(LogLevel.ERROR), true, "the next one is not");
  assert.equal(client._log.canSend(LogLevel.WARN), false, "log level semantics are unchanged (ERROR level only)");
});

test("warnings are rate limited and report how many timeouts they cover", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const { client, sink } = setup();
    for (let i = 0; i < 5; i++) await reportLikeGramjs(client, keepAliveTimeout());
    assert.equal(sink.warnings.length, 1, "five timeouts in a burst -> one warning");

    mock.timers.tick(30_000);
    await reportLikeGramjs(client, keepAliveTimeout());
    assert.equal(sink.warnings.length, 1, "still inside the 60 s window");

    mock.timers.tick(31_000);
    await reportLikeGramjs(client, keepAliveTimeout());
    assert.equal(sink.warnings.length, 2);
    assert.match(sink.warnings[1], /timed out 6x/, "counts the timeouts suppressed since the previous warning");
  } finally {
    mock.timers.reset();
  }
});

test("every other error keeps normal reporting", async () => {
  const { client, sink } = setup();

  // Raised from the update loop but not a keep-alive timeout: gramjs prints it itself, we must not duplicate it.
  const loopError = new Error("something else");
  loopError.stack = UPDATES_STACK.replace("TIMEOUT", "something else");
  assert.equal(await reportLikeGramjs(client, loopError), true);
  assert.equal(sink.errors.length, 0, "no duplicate print for update-loop errors");

  // Raised elsewhere: with a handler installed gramjs stops printing these, so the handler reports them.
  const elsewhere = new Error("connect failed");
  elsewhere.stack = "Error: connect failed\n    at D:\\x\\node_modules\\telegram\\network\\MTProtoSender.js:162:5";
  assert.equal(await reportLikeGramjs(client, elsewhere), true);
  assert.deepEqual(sink.errors, [elsewhere]);

  // A bare "TIMEOUT" from a request path (not the update loop) is a real failure and stays visible.
  const requestTimeout = new Error("TIMEOUT");
  requestTimeout.stack = "Error: TIMEOUT\n    at D:\\x\\node_modules\\telegram\\network\\MTProtoSender.js:300:5";
  assert.equal(await reportLikeGramjs(client, requestTimeout), true);
  assert.equal(sink.errors.length, 2);
  assert.equal(sink.warnings.length, 0);
});

test("createTelegramClient installs the filter by default", () => {
  const client = createTelegramClient({ apiId: 1, apiHash: "0".repeat(32) });
  assert.equal(typeof client._errorHandler, "function");
  assert.equal(client._log.logLevel, LogLevel.ERROR, "real errors are still logged");
});

test("guard: the installed gramjs still reports errors in the order the filter relies on", async () => {
  const fs = await import("node:fs");
  const { createRequire } = await import("node:module");
  const updatesJs = fs.readFileSync(createRequire(import.meta.url).resolve("telegram/client/updates.js"), "utf8");
  // catch (err) { await client._errorHandler(err); if (client._log.canSend(ERROR)) console.error(err); ... client._sender.reconnect() }
  const pattern = /catch \(err\) \{[^}]*?client\._errorHandler\) \{\s*await client\._errorHandler\(err\);\s*\}\s*if \(client\._log\.canSend\(Logger_1\.LogLevel\.ERROR\)\) \{\s*console\.error\(err\);/;
  assert.match(updatesJs, pattern, "gramjs changed its update-loop error reporting: re-check quietKeepAliveTimeouts in packages/telegram/src/client.ts");
});

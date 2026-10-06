/**
 * A viewer seeking, closing a tab or cancelling a download is normal. It must not be logged as an error
 * ("Cannot pipe to a closed or destroyed stream"), must not leak resources, and must not affect other requests.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "../helpers/harness.js";

let h;
let user;
let fileId;
const content = Buffer.alloc(3 * 1024 * 1024, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  h = await startHarness();
  user = await h.login("900");
  fileId = (await user.client.uploadAndWait("movie.bin", content, { mimeType: "video/mp4" })).file.id;
});
after(async () => h.close());

/** Runs fn while recording console.error / console.warn output. */
async function captureConsole(fn) {
  const original = { error: console.error, warn: console.warn };
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = original.error;
    console.warn = original.warn;
  }
  return lines;
}

/** Makes the storage take `delayMs` before the first byte, like a cold Telegram connection. */
function slowStorage(delayMs) {
  const adapter = h.adapterFor(user.user.id);
  const original = adapter.download.bind(adapter);
  adapter.download = async function* (object, options) {
    await sleep(delayMs);
    yield* original(object, options);
  };
  return () => {
    adapter.download = original;
  };
}

const rawGet = (path, signal) => fetch(`${h.baseUrl}${path}`, { headers: { Cookie: user.client.cookie }, signal });

test("client disconnects before the first byte: not logged as an error", async () => {
  const restore = slowStorage(200);
  try {
    const lines = await captureConsole(async () => {
      const ctl = new AbortController();
      const pending = rawGet(`/api/files/${fileId}/content`, ctl.signal).catch(() => null);
      await sleep(60);
      ctl.abort(); // tab closed while Telegram is still answering
      await pending;
      await sleep(500); // let the server finish its side of the (now pointless) stream
    });
    assert.deepEqual(lines.filter(l => l.includes("[Download]")), [], "a client abort is not an error");
  } finally {
    restore();
  }
});

test("client disconnects mid-stream: not logged as an error, server keeps serving", async () => {
  const lines = await captureConsole(async () => {
    const ctl = new AbortController();
    const res = await rawGet(`/api/files/${fileId}/content`, ctl.signal);
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const first = await reader.read(); // got some bytes...
    assert.ok(first.value.length > 0);
    ctl.abort(); // ...then the viewer seeks away
    await reader.read().catch(() => null);
    await sleep(300);
  });
  assert.deepEqual(lines.filter(l => l.includes("[Download]")), []);

  const again = await user.client.get(`/api/files/${fileId}/content`, { headers: { Range: "bytes=100-199" } });
  assert.equal(again.status, 206);
  assert.ok(again.data.equals(content.subarray(100, 200)));
});

test("a genuine storage failure while the client is still connected IS still logged", async () => {
  const adapter = h.adapterFor(user.user.id);
  const original = adapter.download.bind(adapter);
  adapter.download = async function* (object, options) {
    const it = original(object, options)[Symbol.asyncIterator]();
    yield (await it.next()).value; // first chunk fine, so headers are already sent
    throw new Error("storage exploded");
  };
  try {
    const lines = await captureConsole(async () => {
      const res = await rawGet(`/api/files/${fileId}/content`);
      await res.arrayBuffer().catch(() => null); // truncated body
      await sleep(200);
    });
    assert.ok(lines.some(l => l.includes("[Download]") && l.includes("storage exploded")), `expected a [Download] error line, got: ${JSON.stringify(lines)}`);
  } finally {
    adapter.download = original;
  }
});

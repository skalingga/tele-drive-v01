import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { LocalStorageAdapter, MockStorageAdapter } from "../../packages/storage/dist/index.js";
import { TelegramStorageAdapter, mapTelegramError, isTransientStorageError } from "../../packages/telegram/dist/index.js";
import { SessionCrypto } from "../../workers/telegram-connector/dist/index.js";
import { FloodWaitError, ErrorCode } from "../../packages/shared/dist/index.js";

async function collect(iterable) {
  const chunks = [];
  for await (const c of iterable) chunks.push(c);
  return Buffer.concat(chunks);
}

test("LocalStorageAdapter: streams upload from disk, ranged download, delete", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-local-"));
  const src = path.join(dir, "src.bin");
  const content = crypto.randomBytes(200_000);
  fs.writeFileSync(src, content);

  const adapter = new LocalStorageAdapter(path.join(dir, "store"), "local_usr_1");
  let progress = 0;
  const obj = await adapter.upload({ fileId: "fil_1", name: "a", mimeType: "x/y", sizeBytes: content.length, filePath: src, onProgress: b => (progress = b) });
  assert.equal(progress, content.length);
  assert.equal(await adapter.exists(obj), true);
  assert.ok((await collect(adapter.download(obj))).equals(content));
  assert.ok((await collect(adapter.download(obj, { offsetBytes: 70_000, lengthBytes: 1234 }))).equals(content.subarray(70_000, 71_234)));

  await adapter.delete([obj]);
  assert.equal(await adapter.exists(obj), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LocalStorageAdapter: refuses other peers and path traversal", async () => {
  const adapter = new LocalStorageAdapter(os.tmpdir(), "local_usr_1");
  const base = { messageId: 1, documentId: "d", accessHash: "h", fileReference: "r", dcId: 0 };
  await assert.rejects(adapter.exists({ ...base, fileId: "fil_1", peerId: "local_usr_2" }), /another peer/);
  await assert.rejects(adapter.exists({ ...base, fileId: "../../secret", peerId: "local_usr_1" }), /Invalid file id/);
  assert.throws(() => new LocalStorageAdapter(os.tmpdir(), "../x"), /Invalid peer id/);
});

test("MockStorageAdapter: injected FLOOD_WAIT surfaces as FloodWaitError", async () => {
  const mock = new MockStorageAdapter();
  const file = path.join(os.tmpdir(), `td-mock-${Date.now()}`);
  fs.writeFileSync(file, "x");
  const obj = await mock.upload({ fileId: "f", name: "f", mimeType: "x/y", sizeBytes: 1, filePath: file });
  mock.simulateFloodWaitSeconds = 7;
  await assert.rejects(collect(mock.download(obj)), err => err instanceof FloodWaitError && err.seconds === 7);
  fs.rmSync(file);
});

const MB = 1024 * 1024;
const CH = 256 * 1024; // default download chunk size

/**
 * Fake gramjs client that enforces Telegram's upload.getFile rules (4 KiB-aligned offset, limit <= 1 MiB,
 * no request crossing a 1 MiB boundary). Like the real service it serves one request at a time per
 * connection (`serviceMs` each), so only more connections add throughput. `script(call)` may throw.
 */
function fakeClient(document, { name = "main", serviceMs = 0, script = () => {} } = {}) {
  let queue = Promise.resolve();
  const client = {
    name,
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    dcsRequested: [],
    disconnected: false,
    async disconnect() {
      client.disconnected = true;
    },
    async getSender(dcId) {
      client.dcsRequested.push(dcId);
      return { dcId, owner: name };
    },
    async invokeWithSender(request, sender) {
      const offset = Number(request.offset.toString());
      const limit = request.limit;
      assert.equal(offset % 4096, 0, "offset must be 4 KiB aligned");
      assert.ok(limit > 0 && limit <= MB && limit % 4096 === 0, "limit must be <= 1 MiB and 4 KiB aligned");
      assert.equal(Math.floor(offset / MB), Math.floor((offset + limit - 1) / MB), "request must not cross a 1 MiB boundary");
      const call = { offset, dcId: sender.dcId, n: client.calls.length, client: name };
      client.calls.push(call);
      client.inFlight++;
      client.maxInFlight = Math.max(client.maxInFlight, client.inFlight);
      const turn = queue.then(() => new Promise(r => setTimeout(r, serviceMs)));
      queue = turn.catch(() => undefined);
      try {
        await turn;
        script(call);
        return { bytes: document.subarray(offset, Math.min(offset + limit, document.length)) };
      } finally {
        client.inFlight--;
      }
    }
  };
  return client;
}

/** A main client plus a factory that hands out extra connections on the same "session". */
function fakeCluster(document, { serviceMs = 0, extraServiceMs = serviceMs, script, failFactory = false } = {}) {
  const main = fakeClient(document, { name: "main", serviceMs, script });
  const extras = [];
  const cluster = {
    main,
    extras,
    factoryCalls: 0,
    all: () => [main, ...extras],
    totalCalls: () => cluster.all().reduce((n, c) => n + c.calls.length, 0),
    async factory() {
      cluster.factoryCalls++;
      if (failFactory) throw new Error("cannot open connection");
      const extra = fakeClient(document, {
        name: `extra${extras.length + 1}`,
        serviceMs: typeof extraServiceMs === "function" ? extraServiceMs(extras.length) : extraServiceMs,
        script
      });
      extras.push(extra);
      return extra;
    }
  };
  return cluster;
}

const PEER = { channelId: "1001", accessHash: "5" };
const objectFor = doc => ({ fileId: "f", peerId: "1001", messageId: 1, documentId: "9", accessHash: "8", fileReference: "AA", dcId: 5, sizeBytes: doc.length });
const rpcError = (message, extra = {}) => Object.assign(new Error(message), { errorMessage: message, ...extra });
const adapterFor = (cluster, options = {}) => new TelegramStorageAdapter(cluster.main, PEER, { createExtraClient: () => cluster.factory(), ...options });

test("TelegramStorageAdapter: arbitrary byte ranges are exact (aligned chunks, trimmed at both ends)", async () => {
  const doc = crypto.randomBytes(3 * MB + 12345);
  const cases = [
    [0, doc.length],
    [123, 10],
    [CH - 5, 10], // crosses a chunk boundary
    [MB - 5, 10], // crosses a 1 MiB boundary
    [MB, MB], // exactly one 1 MiB block
    [2 * MB + 7, MB + 12345 - 7], // tail
    [doc.length - 1, 1]
  ];
  for (const [offset, length] of cases) {
    const cluster = fakeCluster(doc);
    const body = await collect(adapterFor(cluster).download(objectFor(doc), { offsetBytes: offset, lengthBytes: length }));
    assert.ok(body.equals(doc.subarray(offset, offset + length)), `range ${offset}+${length}`);
    assert.equal(cluster.totalCalls(), Math.ceil(((offset % CH) + length) / CH), `requests only the chunks it needs (${offset}+${length})`);
  }
});

test("TelegramStorageAdapter: chunks complete out of order but are delivered in order, bounded by the prefetch window", async () => {
  const doc = crypto.randomBytes(3 * MB + 1);
  const cluster = fakeCluster(doc);
  // Earlier chunks answer slower than later ones.
  const slowFirst = fakeClient(doc, { script: () => {} });
  const origInvoke = slowFirst.invokeWithSender;
  slowFirst.invokeWithSender = async (req, sender) => {
    await new Promise(r => setTimeout(r, (13 - slowFirst.calls.length) * 6));
    return origInvoke(req, sender);
  };
  const body = await collect(new TelegramStorageAdapter(slowFirst, PEER, { prefetchChunks: 4, connections: 1 }).download(objectFor(doc)));
  assert.ok(body.equals(doc), "byte-for-byte identical despite reordered completions");
  assert.equal(slowFirst.maxInFlight, 4, "exactly `prefetch` requests run concurrently");
  assert.equal(slowFirst.calls.length, 13, "one request per chunk, none beyond the end");
  assert.equal(cluster.factoryCalls, 0);
});

test("TelegramStorageAdapter: large downloads fan out across parallel connections and stay byte-exact", async () => {
  const doc = crypto.randomBytes(12 * MB + 321);
  const cluster = fakeCluster(doc, { serviceMs: 2 });
  const body = await collect(adapterFor(cluster, { connections: 4 }).download(objectFor(doc)));
  assert.ok(body.equals(doc));
  assert.equal(cluster.factoryCalls, 4, "opened 4 pooled download connections");
  for (const c of cluster.extras) assert.ok(c.calls.length >= 6, `${c.name} carried a fair share (${c.calls.length} of ${cluster.totalCalls()})`);
  assert.equal(cluster.totalCalls(), Math.ceil(doc.length / CH), "every chunk requested exactly once");
});

test("TelegramStorageAdapter: big downloads never touch the main connection, so uploads on it are not starved", async () => {
  // Measured on Telegram: sharing the main connection with downloads cut upload speed from ~3 MB/s to ~0.4 MB/s.
  const doc = crypto.randomBytes(12 * MB);
  const cluster = fakeCluster(doc, { serviceMs: 2 });
  const body = await collect(adapterFor(cluster, { connections: 4 }).download(objectFor(doc)));
  assert.ok(body.equals(doc));
  assert.equal(cluster.main.calls.length, 0, "the main connection carried no download traffic");
  assert.equal(cluster.main.maxInFlight, 0);
  assert.equal(cluster.totalCalls(), Math.ceil(doc.length / CH));
});

test("TelegramStorageAdapter: small downloads stay on the main connection (no new connections, no extra latency)", async () => {
  const doc = crypto.randomBytes(MB);
  const cluster = fakeCluster(doc);
  assert.ok((await collect(adapterFor(cluster, { connections: 4 }).download(objectFor(doc)))).equals(doc));
  assert.equal(cluster.factoryCalls, 0);
  assert.equal(cluster.main.calls.length, 4, "served by the main connection");
});

test("TelegramStorageAdapter: throughput scales with connections when each connection is rate-limited (as measured on Telegram)", async () => {
  const doc = crypto.randomBytes(8 * MB);
  const timeIt = async connections => {
    const cluster = fakeCluster(doc, { serviceMs: 25 });
    const t = Date.now();
    const body = await collect(adapterFor(cluster, { connections }).download(objectFor(doc)));
    assert.ok(body.equals(doc));
    return Date.now() - t;
  };
  const one = await timeIt(1);
  const four = await timeIt(4);
  assert.ok(one >= 32 * 25 * 0.9, `a single connection serves chunks one by one (${one}ms)`);
  assert.ok(four < one / 2.5, `4 connections are much faster: ${four}ms vs ${one}ms`);
});

test("TelegramStorageAdapter: small downloads do not open extra connections", async () => {
  const doc = crypto.randomBytes(MB);
  const cluster = fakeCluster(doc);
  const body = await collect(adapterFor(cluster, { connections: 4 }).download(objectFor(doc)));
  assert.ok(body.equals(doc));
  assert.equal(cluster.factoryCalls, 0);
});

test("TelegramStorageAdapter: if extra connections cannot be opened the download still completes on the main one (and does not hammer)", async () => {
  const doc = crypto.randomBytes(6 * MB);
  const cluster = fakeCluster(doc, { failFactory: true });
  const adapter = adapterFor(cluster, { connections: 4 });
  assert.ok((await collect(adapter.download(objectFor(doc)))).equals(doc));
  assert.equal(cluster.main.calls.length, 24, "no pooled connection available: the main connection is the fallback");
  const attempts = cluster.factoryCalls;
  assert.ok((await collect(adapter.download(objectFor(doc)))).equals(doc));
  assert.equal(cluster.factoryCalls, attempts, "no immediate retry after a failure");
});

test("TelegramStorageAdapter: work goes to the least busy connection, so a slow one does not stall the stream", async () => {
  const doc = crypto.randomBytes(16 * MB);
  // pooled connections are fast (3 ms/chunk) except #2, which is 10x slower.
  const cluster = fakeCluster(doc, { serviceMs: 3, extraServiceMs: i => (i === 1 ? 30 : 3) });
  const body = await collect(adapterFor(cluster, { connections: 4 }).download(objectFor(doc)));
  assert.ok(body.equals(doc));
  const fairShare = doc.length / CH / 4; // 16 chunks each if work were split evenly over the 4 pooled connections
  const slow = cluster.extras[1].calls.length;
  const fast = [cluster.extras[0].calls.length, cluster.extras[2].calls.length, cluster.extras[3].calls.length];
  assert.equal(cluster.main.calls.length, 0);
  // Delivery is in order, so a slow connection still holds back the window a little (head-of-line);
  // measured: ~10 chunks on the slow one vs 17-20 on the others.
  assert.ok(slow <= fairShare * 0.8, `slow connection got ${slow} chunks (fair share ${fairShare})`);
  const fastTotal = fast.reduce((a, b) => a + b, 0);
  assert.ok(fastTotal >= 3 * fairShare + 3, `fast connections took over the slow one's work: ${fast.join("/")} (${fastTotal} of ${doc.length / CH})`);
});

test("TelegramStorageAdapter: a dead extra connection is evicted and its chunks are retried elsewhere", async () => {
  const doc = crypto.randomBytes(8 * MB);
  const cluster = fakeCluster(doc, {
    script: call => {
      if (call.client === "extra2") throw new Error("Not connected");
    }
  });
  const adapter = adapterFor(cluster, { connections: 4 });
  const body = await collect(adapter.download(objectFor(doc)));
  assert.ok(body.equals(doc), "complete and correct despite a broken connection");
  assert.equal(cluster.extras[1].disconnected, true, "dead connection was disconnected");
  assert.equal(cluster.extras[0].disconnected, false);
  assert.equal(cluster.main.disconnected, false, "the main client is never touched by the pool");
});

test("TelegramStorageAdapter: close() and idle timeout release the extra connections (never the main client)", async () => {
  const doc = crypto.randomBytes(6 * MB);
  const cluster = fakeCluster(doc);
  const adapter = adapterFor(cluster, { connections: 4, idleMs: 60 });
  assert.ok((await collect(adapter.download(objectFor(doc)))).equals(doc));
  assert.equal(cluster.extras.length, 4);
  assert.ok(cluster.extras.every(c => !c.disconnected), "kept warm for the next request");

  await new Promise(r => setTimeout(r, 200));
  assert.ok(cluster.extras.every(c => c.disconnected), "closed after the idle timeout");
  assert.equal(cluster.main.disconnected, false);

  // A later download reopens connections on demand.
  assert.ok((await collect(adapter.download(objectFor(doc)))).equals(doc));
  assert.equal(cluster.extras.length, 8);
  await adapter.close();
  assert.ok(cluster.extras.slice(4).every(c => c.disconnected), "close() releases them immediately");
  assert.equal(cluster.main.disconnected, false);
});

test("TelegramStorageAdapter: memory is bounded — a stalled consumer stops new requests", async () => {
  const doc = crypto.randomBytes(40 * MB);
  const cluster = fakeCluster(doc);
  const adapter = adapterFor(cluster, { connections: 2, prefetchChunks: 3 });
  const it = adapter.download(objectFor(doc))[Symbol.asyncIterator]();
  await it.next(); // consume one chunk, then stall
  await new Promise(r => setTimeout(r, 100));
  assert.ok(cluster.totalCalls() <= 1 + 3, `at most consumed + prefetch chunks requested (got ${cluster.totalCalls()})`);
  await it.return();
  const after = cluster.totalCalls();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(cluster.totalCalls(), after, "no requests after the consumer goes away");
});

test("TelegramStorageAdapter: with unknown size it stops at the first short chunk", async () => {
  const doc = crypto.randomBytes(2 * MB + 100);
  const cluster = fakeCluster(doc);
  const object = { ...objectFor(doc), sizeBytes: undefined };
  const body = await collect(adapterFor(cluster, { connections: 4 }).download(object));
  assert.ok(body.equals(doc));
  assert.ok(cluster.totalCalls() <= Math.ceil(doc.length / CH) + 12, "speculative requests are bounded by the window");
});

test("TelegramStorageAdapter: earlier chunks are delivered before a later chunk's error, with no unhandled rejection", async () => {
  const doc = crypto.randomBytes(8 * MB);
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const cluster = fakeCluster(doc, {
      serviceMs: 4,
      script: call => {
        if (call.offset === 3 * CH) throw rpcError("FLOOD_WAIT_9", { seconds: 9 });
        if (call.offset === 4 * CH) throw rpcError("INTERNAL");
      }
    });
    const received = [];
    await assert.rejects(
      (async () => {
        for await (const chunk of adapterFor(cluster, { connections: 4 }).download(objectFor(doc))) received.push(chunk);
      })(),
      err => err instanceof FloodWaitError && err.seconds === 9
    );
    assert.equal(received.length, 3, "chunks 0-2 were delivered before chunk 3 failed");
    assert.ok(Buffer.concat(received).equals(doc.subarray(0, 3 * CH)));
    await new Promise(r => setTimeout(r, 150)); // let the abandoned requests settle
    assert.deepEqual(unhandled, [], "abandoned in-flight requests do not leak unhandled rejections");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("TelegramStorageAdapter: a TIMEOUT is retried once; a second one fails", async () => {
  const doc = crypto.randomBytes(2 * CH);
  let timeouts = 0;
  const flaky = fakeCluster(doc, {
    script: call => {
      if (call.offset === CH && timeouts < 1) {
        timeouts++;
        throw rpcError("TIMEOUT");
      }
    }
  });
  assert.ok((await collect(adapterFor(flaky).download(objectFor(doc)))).equals(doc));
  assert.equal(timeouts, 1);

  const always = fakeCluster(doc, { script: call => { if (call.offset === CH) throw rpcError("TIMEOUT"); } });
  await assert.rejects(collect(adapterFor(always).download(objectFor(doc))), err => err.code === ErrorCode.STORAGE_UNAVAILABLE);
});

test("TelegramStorageAdapter: FILE_MIGRATE moves the download to the right data center", async () => {
  const doc = crypto.randomBytes(3 * MB);
  const cluster = fakeCluster(doc, {
    script: call => {
      if (call.dcId === 5) throw Object.assign(new Error("The file to be accessed is currently stored in DC 4"), { newDc: 4 });
    }
  });
  const body = await collect(adapterFor(cluster, { connections: 3 }).download(objectFor(doc)));
  assert.ok(body.equals(doc));
  assert.ok(cluster.all().some(c => c.dcsRequested.includes(4)), "switched to DC 4");
  assert.ok(cluster.all().flatMap(c => c.calls).filter(c => c.dcId === 4).length >= Math.ceil(doc.length / CH), "chunks were served from DC 4");
});

test("TelegramStorageAdapter: FILE_REFERENCE_EXPIRED surfaces as STORAGE_REFERENCE_EXPIRED (the connector then refreshes)", async () => {
  const doc = crypto.randomBytes(MB);
  const cluster = fakeCluster(doc, { script: () => { throw rpcError("FILE_REFERENCE_EXPIRED"); } });
  await assert.rejects(collect(adapterFor(cluster).download(objectFor(doc))), err => err.code === ErrorCode.STORAGE_REFERENCE_EXPIRED);
});

test("TelegramStorageAdapter: objects from another user's channel are refused before any request", async () => {
  const cluster = fakeCluster(Buffer.alloc(1));
  const foreign = { ...objectFor(Buffer.alloc(1)), peerId: "2002" };
  await assert.rejects(collect(adapterFor(cluster).download(foreign)), err => err.code === ErrorCode.FORBIDDEN);
  assert.equal(cluster.totalCalls(), 0);
});

test("TelegramStorageAdapter: rejects chunk sizes Telegram would refuse", () => {
  const client = fakeClient(Buffer.alloc(1));
  for (const chunkBytes of [1000, 3 * 4096, 2 * MB, 0]) {
    assert.throws(() => new TelegramStorageAdapter(client, PEER, { chunkBytes }), /chunkBytes/);
  }
  assert.doesNotThrow(() => new TelegramStorageAdapter(client, PEER, { chunkBytes: MB }));
});

test("mapTelegramError: classifies RPC errors", () => {
  const flood = mapTelegramError({ errorMessage: "FLOOD_WAIT", seconds: 42 });
  assert.ok(flood instanceof FloodWaitError);
  assert.equal(flood.seconds, 42);
  assert.equal(mapTelegramError(new Error("420: FLOOD_WAIT_17 (caused by upload.SaveFilePart)")).seconds, 17);
  assert.equal(mapTelegramError({ errorMessage: "AUTH_KEY_UNREGISTERED" }).code, ErrorCode.TELEGRAM_AUTH_REQUIRED);
  assert.equal(mapTelegramError({ errorMessage: "SESSION_REVOKED" }).code, ErrorCode.TELEGRAM_AUTH_REQUIRED);
  assert.equal(mapTelegramError({ errorMessage: "FILE_REFERENCE_EXPIRED" }).code, ErrorCode.STORAGE_REFERENCE_EXPIRED);
  assert.equal(isTransientStorageError(mapTelegramError(new Error("TIMEOUT"))), true);
  assert.equal(isTransientStorageError(mapTelegramError({ errorMessage: "CHANNEL_PRIVATE" })), false);
});

test("SessionCrypto: AES-256-GCM round-trip, tamper detection, key validation", () => {
  const key = crypto.randomBytes(32).toString("hex");
  const c = new SessionCrypto(key);
  const secret = "1BVtsOK8Bu...session-string";
  const enc = c.encrypt(secret);
  assert.equal(enc.includes(secret), false);
  assert.notEqual(c.encrypt(secret), enc, "random IV per encryption");
  assert.equal(c.decrypt(enc), secret);

  const parts = enc.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => c.decrypt(parts.join(".")));
  assert.throws(() => new SessionCrypto(crypto.randomBytes(32).toString("hex")).decrypt(enc), "wrong key fails");
  assert.throws(() => new SessionCrypto("too-short"), /32 bytes/);
  assert.throws(() => new SessionCrypto(undefined), /32 bytes/);
});

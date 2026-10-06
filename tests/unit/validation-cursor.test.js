import test from "node:test";
import assert from "node:assert/strict";
import {
  CreateFolderSchema,
  UpdateFolderSchema,
  FileIdSchema,
  FileListQuerySchema,
  encodeCursor,
  decodeCursor,
  sanitizeFileName,
  parseRangeHeader,
  resolveServedContentType,
  contentDispositionHeader
} from "../../packages/shared/dist/index.js";

test("Schemas: folder names reject traversal, separators, control chars and dot-only names", () => {
  assert.equal(CreateFolderSchema.safeParse({ name: "Laporan 2026" }).success, true);
  for (const name of ["", "   ", "..", ".", "a/b", "a\\b", "x\u0000y", "a:b", "<script>"]) {
    assert.equal(CreateFolderSchema.safeParse({ name }).success, false, `rejects ${JSON.stringify(name)}`);
  }
  assert.equal(UpdateFolderSchema.safeParse({ name: "a/b" }).success, false, "rename is validated too");
  assert.equal(UpdateFolderSchema.safeParse({}).success, false, "empty update rejected");
});

test("Schemas: ids and list queries are strict", () => {
  assert.equal(FileIdSchema.safeParse("fil_0f8fad5b-d9cb-469f-a165-70867728950e").success, true);
  assert.equal(FileIdSchema.safeParse("fil_../../etc").success, false);
  assert.equal(FileListQuerySchema.safeParse({ limit: "201" }).success, false);
  assert.equal(FileListQuerySchema.parse({}).limit, 50);
});

test("Cursor: round-trips and rejects garbage", () => {
  const c = encodeCursor({ v: "2026-10-06T00:00:00.000Z", id: "fil_x" });
  assert.deepEqual(decodeCursor(c), { v: "2026-10-06T00:00:00.000Z", id: "fil_x" });
  assert.deepEqual(decodeCursor(encodeCursor({ v: 42, id: "a" })), { v: 42, id: "a" });
  assert.equal(decodeCursor("%%%"), null);
  assert.equal(decodeCursor(Buffer.from('{"id":1}').toString("base64url")), null);
});

test("sanitizeFileName: normalizes and neutralizes dangerous names", () => {
  assert.equal(sanitizeFileName("  laporan.pdf "), "laporan.pdf");
  assert.equal(sanitizeFileName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(sanitizeFileName("a\u0000b\nc"), "a_b_c");
  assert.equal(sanitizeFileName(".."), null);
  assert.equal(sanitizeFileName("   "), null);
  const long = sanitizeFileName(`${"x".repeat(300)}.txt`);
  assert.equal(long.length, 255);
  assert.ok(long.endsWith(".txt"), "extension kept when truncating");
});

test("parseRangeHeader: RFC 9110 single ranges", () => {
  assert.equal(parseRangeHeader(undefined, 100), null);
  assert.deepEqual(parseRangeHeader("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRangeHeader("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRangeHeader("bytes=-5", 100), { start: 95, end: 99 });
  assert.deepEqual(parseRangeHeader("bytes=-500", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRangeHeader("bytes=50-5000", 100), { start: 50, end: 99 }, "end clamped");
  assert.equal(parseRangeHeader("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRangeHeader("bytes=9-3", 100), "unsatisfiable");
  assert.equal(parseRangeHeader("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRangeHeader("bytes=0-1,5-6", 100), null, "multi-range ignored → full body");
  assert.equal(parseRangeHeader("items=0-1", 100), null);
});

test("resolveServedContentType: only inert types are inline", () => {
  assert.deepEqual(resolveServedContentType("image/png", {}), { contentType: "image/png", disposition: "inline" });
  assert.deepEqual(resolveServedContentType("video/mp4", {}), { contentType: "video/mp4", disposition: "inline" });
  for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/javascript", "application/xml"]) {
    assert.deepEqual(resolveServedContentType(mime, {}), { contentType: "application/octet-stream", disposition: "attachment" }, mime);
  }
  assert.equal(resolveServedContentType("text/html", { asText: true }).contentType, "text/plain; charset=utf-8");
  assert.equal(resolveServedContentType("image/png", { attachment: true }).disposition, "attachment");
});

test("contentDispositionHeader: RFC 5987 encoding with safe ASCII fallback", () => {
  assert.equal(
    contentDispositionHeader("attachment", 'lap"oran α.pdf'),
    "attachment; filename=\"lap_oran _.pdf\"; filename*=UTF-8''lap%22oran%20%CE%B1.pdf"
  );
});

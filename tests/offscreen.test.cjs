const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../offscreen.js"), "utf8");

function avif(brand = "avif", compatible = "") {
  const data = Buffer.alloc(16 + compatible.length);
  data.writeUInt32BE(data.length, 0);
  data.write("ftyp", 4);
  data.write(brand, 8);
  data.write(compatible, 16);
  return data;
}

async function runImage(bytes, mime) {
  const downloads = [], decoded = [];
  let output;
  const context = vm.createContext({
    Blob, Uint8Array,
    URL: {
      createObjectURL(blob) { output = blob; return "blob:test"; },
      revokeObjectURL() {},
    },
    setTimeout() {},
    fetch: async () => ({
      ok: true,
      arrayBuffer: async () => bytes,
      headers: { get: () => mime },
    }),
    createImageBitmap: async (blob) => {
      decoded.push(blob.type);
      return { width: 1200, height: 800, close() {} };
    },
    OffscreenCanvas: class {
      constructor(width, height) {
        assert.equal(width, 1200);
        assert.equal(height, 800);
      }
      getContext() { return { drawImage() {} }; }
      async convertToBlob({ type }) { return new Blob(["PNG"], { type }); }
    },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (job) => { downloads.push(job); return { ok: true }; },
    } },
  });
  vm.runInContext(source, context);
  const result = await vm.runInContext(
    'runImage({ url: "https://cdn.test/photo.jpg", filename: "photos/photo", origName: "photos/photo.jpg" })',
    context,
  );
  return { result, downloads, decoded, output };
}

test("AVIF bytes served as JPEG are decoded and saved as PNG", async () => {
  for (const bytes of [avif(), avif("mif1", "avif"), avif("avis")]) {
    const r = await runImage(bytes, "image/jpeg");
    assert.equal(r.result.converted, true);
    assert.deepEqual(r.decoded, ["image/avif"]);
    assert.equal(r.downloads[0].filename, "photos/photo.png");
    assert.equal(r.output.type, "image/png");
  }
});

test("WebP bytes are converted regardless of the server MIME", async () => {
  const r = await runImage(Buffer.from("RIFF0000WEBP0000"), "application/octet-stream");
  assert.equal(r.result.converted, true);
  assert.deepEqual(r.decoded, ["image/webp"]);
  assert.equal(r.downloads[0].filename, "photos/photo.png");
});

test("non-WebP/AVIF bytes remain intact without canvas conversion", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const r = await runImage(bytes, "image/jpeg");
  assert.equal(r.result.converted, false);
  assert.deepEqual(r.decoded, []);
  assert.equal(r.downloads[0].filename, "photos/photo.jpg");
  assert.deepEqual(Buffer.from(await r.output.arrayBuffer()), bytes);
});

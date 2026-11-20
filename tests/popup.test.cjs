const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");

async function popup(settings) {
  const elements = new Map();
  const downloads = [], messages = [], saved = [];
  const context = vm.createContext({
    URL,
    setTimeout: () => 1,
    clearTimeout: () => {},
    localStorage: { getItem: () => null },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    document: {
      documentElement: { dataset: {} },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          value: "", checked: false, disabled: false, handlers: {},
          setAttribute() {},
          addEventListener(event, handler) { this.handlers[event] = handler; },
        });
        return elements.get(id);
      },
    },
    chrome: {
      tabs: { query: async () => [] },
      storage: { local: {
        get: async () => ({ settings }),
        set: async (value) => { saved.push(value); },
      } },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message, reply) {
          messages.push(message);
          reply({ ok: true, converted: message.cmd === "image" });
        },
      },
      downloads: { download: async (job) => { downloads.push(job); return downloads.length; } },
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  return {
    context, elements, downloads, messages, saved,
    evaluate: (code) => vm.runInContext(code, context),
  };
}

test("original URLs remove only resize parameters, retaining raw query encoding", async () => {
  const p = await popup();
  const cases = [
    ["https://cdn.test/image.jpg?w=300&h=200", "https://cdn.test/image.jpg"],
    ["https://cdn.test/image.jpg?W=300&%68eight=200&w=100#preview", "https://cdn.test/image.jpg#preview"],
    ["https://cdn.test/image.jpg?wid=300&hei=200&fit=crop&crop=1&rect=0,0,30,20&dpr=2&resize=300x200&size=small&scale=2&scl=1", "https://cdn.test/image.jpg"],
    ["https://cdn.test/image.jpg?maxwidth=100&maxheight=100&max-width=100&max-height=100&max_width=100&max_height=100", "https://cdn.test/image.jpg"],
    ["https://cdn.test/image.jpg?token=a%2fb+z&width=300&format=webp&q=80&signature=X%3D%3D", "https://cdn.test/image.jpg?token=a%2fb+z&format=webp&q=80&signature=X%3D%3D"],
    ["https://cdn.test/image.jpg?url=https%3A%2F%2Fother.test%2Fa%3Fw%3D100&h=50", "https://cdn.test/image.jpg?url=https%3A%2F%2Fother.test%2Fa%3Fw%3D100"],
    ["https://cdn.test/image.jpg?%ZZ=1&w=30", "https://cdn.test/image.jpg?%ZZ=1"],
    ["https://cdn.test/image.jpg?format=webp&quality=80", "https://cdn.test/image.jpg?format=webp&quality=80"],
    ["https://cdn.test/w_300/image.jpg", "https://cdn.test/w_300/image.jpg"],
    ["https://cdn.test/image.jpg#?width=100", "https://cdn.test/image.jpg#?width=100"],
    ["data:image/png;width=100", "data:image/png;width=100"],
    ["not a URL?w=100", "not a URL?w=100"],
    ["https://site.test/_next/image?url=%2Fphoto.jpg%3Fimwidth%3D300&w=600&q=75", "https://site.test/photo.jpg"],
    ["https://site.test/base/_next/image?url=https%3A%2F%2Fcdn.test%2Fphoto.jpg%3Fw%3D300%26token%3Da%252fb&w=600", "https://cdn.test/photo.jpg?token=a%2fb"],
    ["https://site.test/cdn-cgi/image/width=300,fit=cover/photo.jpg?height=200", "https://site.test/photo.jpg"],
    ["https://site.test/cdn-cgi/image/width=300/https://cdn.test/photo.jpg?token=a%2fb", "https://cdn.test/photo.jpg?token=a%2fb"],
    ["https://site.test/_next/image?url=data%3Aimage%2Fpng%3Bbase64%2CAAAA&w=300", "https://site.test/_next/image?url=data%3Aimage%2Fpng%3Bbase64%2CAAAA"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(p.evaluate(`originalImageUrl(${JSON.stringify(input)})`), expected);
  }
});

test("original choice defaults off and persists without losing the PNG preference", async () => {
  const p = await popup({ toPng: true, folder: "photos", types: ["image"] });
  const original = p.elements.get("originalToggle");
  const png = p.elements.get("pngToggle");
  assert.equal(original.checked, false);
  assert.equal(png.disabled, false);
  original.checked = true;
  original.handlers.change();
  assert.equal(png.disabled, false);
  assert.equal(png.checked, true);
  assert.equal(p.saved.at(-1).settings.originalImages, true);
  assert.equal(p.saved.at(-1).settings.folder, "photos");
  assert.equal(p.saved.at(-1).settings.toPng, true);
  original.checked = false;
  original.handlers.change();
  assert.equal(png.disabled, false);
  assert.equal(p.saved.at(-1).settings.originalImages, false);

  const restored = await popup({ originalImages: true, toPng: true });
  assert.equal(restored.elements.get("originalToggle").checked, true);
  assert.equal(restored.elements.get("pngToggle").disabled, false);
});

async function download(p, items) {
  p.elements.get("folderInput").value = "photos";
  p.evaluate(`assets = ${JSON.stringify(items)}; assets.forEach(a => selected.add(a.id));`);
  await p.evaluate("runDownload()");
}

test("original downloads without conversion strip raster and SVG URLs, leave other assets and HLS intact", async () => {
  const p = await popup({ originalImages: true, toPng: false });
  await download(p, [
    { id: "1", type: "image", name: "photo.webp", ext: "webp", url: "https://cdn.test/photo.webp?w=100&format=webp" },
    { id: "2", type: "svg", name: "icon.svg", ext: "svg", url: "https://cdn.test/icon.svg?width=20" },
    { id: "3", type: "css", name: "style.css", ext: "css", url: "https://cdn.test/style.css?width=20" },
    { id: "4", type: "media", stream: "hls", name: "movie.m3u8", url: "https://cdn.test/movie.m3u8?w=100" },
  ]);
  assert.deepEqual(p.downloads.map(d => d.url), [
    "https://cdn.test/photo.webp?format=webp",
    "https://cdn.test/icon.svg",
    "https://cdn.test/style.css?width=20",
  ]);
  assert.equal(p.downloads[0].filename, "photos/photo.webp");
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].cmd, "hls");
  assert.equal(p.messages[0].job.url, "https://cdn.test/movie.m3u8?w=100");
});

test("displayed mode preserves URLs and existing PNG conversion", async () => {
  const p = await popup();
  await download(p, [
    { id: "1", type: "image", name: "photo.webp", ext: "webp", url: "https://cdn.test/photo.webp?w=100" },
    { id: "2", type: "image", name: "photo.jpg", ext: "jpg", url: "https://cdn.test/photo.jpg?w=100" },
  ]);
  assert.equal(p.messages[0].cmd, "image");
  assert.equal(p.messages[0].job.url, "https://cdn.test/photo.webp?w=100");
  assert.equal(p.messages[1].cmd, "image");
  assert.equal(p.messages[1].job.url, "https://cdn.test/photo.jpg?w=100");
  assert.equal(p.downloads.length, 0);
});

test("original images can be converted even when AVIF is hidden behind a JPEG URL", async () => {
  const p = await popup({ originalImages: true, toPng: true });
  await download(p, [
    { id: "1", type: "image", name: "image.img", ext: "img", url: "https://site.test/_next/image?url=%2Fphoto.jpg&w=300&q=75" },
  ]);
  assert.equal(p.messages[0].cmd, "image");
  assert.equal(p.messages[0].job.url, "https://site.test/photo.jpg");
  assert.equal(p.messages[0].job.filename, "photos/photo");
  assert.equal(p.messages[0].job.origName, "photos/photo.jpg");
});

test("original download failures are reported without silently downloading resized images", async () => {
  const p = await popup({ originalImages: true, toPng: false });
  p.context.chrome.downloads.download = async () => { throw new Error("refused"); };
  await download(p, [
    { id: "1", type: "image", name: "photo.jpg", ext: "jpg", url: "https://cdn.test/photo.jpg?w=100" },
  ]);
  assert.match(p.elements.get("toast").textContent, /1 échec/);
  assert.equal(p.messages.length, 0);
  assert.equal(p.elements.get("downloadBtn").disabled, false);
});

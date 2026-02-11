import test from "node:test";
import assert from "node:assert/strict";
import { clipboardItemsToImageFile, dispatchAiExtractFile } from "../ai-extract-upload.mjs";

class TestFile {
  constructor(parts, name, options = {}) {
    this.parts = parts;
    this.name = name;
    this.type = options.type || "";
    this.lastModified = options.lastModified || Date.now();
  }
}

test("dispatchAiExtractFile forwards the selected file via shared callback", () => {
  const inputFile = { name: "clipboard-123.png", type: "image/png" };
  let received = null;
  const didDispatch = dispatchAiExtractFile(inputFile, (file) => {
    received = file;
  });

  assert.equal(didDispatch, true);
  assert.equal(received, inputFile);
});

test("clipboardItemsToImageFile converts image clipboard entries into deterministic files", () => {
  const originalFile = globalThis.File;
  globalThis.File = TestFile;

  try {
    const sourceFile = { type: "image/png" };
    const items = [
      {
        type: "text/plain",
        getAsFile() {
          return null;
        },
      },
      {
        type: "image/png",
        getAsFile() {
          return sourceFile;
        },
      },
    ];

    const result = clipboardItemsToImageFile(items, 1700000000000);

    assert.ok(result instanceof TestFile);
    assert.equal(result.name, "clipboard-1700000000000.png");
    assert.equal(result.type, "image/png");
    assert.equal(result.lastModified, 1700000000000);
  } finally {
    globalThis.File = originalFile;
  }
});

test("clipboardItemsToImageFile ignores non-image clipboard entries", () => {
  const result = clipboardItemsToImageFile([
    {
      type: "text/plain",
      getAsFile() {
        return null;
      },
    },
  ]);

  assert.equal(result, null);
});

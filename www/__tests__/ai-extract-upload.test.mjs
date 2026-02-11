import test from "node:test";
import assert from "node:assert/strict";
import {
  clipboardItemsToImageFile,
  dispatchAiExtractFile,
  handleClipboardImagePasteEvent,
} from "../ai-extract-upload.mjs";

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


test("handleClipboardImagePasteEvent dispatches image file and prevents default", () => {
  const originalFile = globalThis.File;
  globalThis.File = TestFile;

  try {
    const sourceFile = { type: "image/png" };
    const event = {
      clipboardData: {
        items: [
          {
            type: "image/png",
            getAsFile() {
              return sourceFile;
            },
          },
        ],
      },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };

    let received = null;
    const didHandle = handleClipboardImagePasteEvent(
      event,
      (file) => {
        received = file;
      },
      { timestamp: 1700000000001, filenamePrefix: "clipboard-task" },
    );

    assert.equal(didHandle, true);
    assert.equal(event.defaultPrevented, true);
    assert.ok(received instanceof TestFile);
    assert.equal(received.name, "clipboard-task-1700000000001.png");
  } finally {
    globalThis.File = originalFile;
  }
});

test("handleClipboardImagePasteEvent ignores non-image clipboard entries", () => {
  const event = {
    clipboardData: {
      items: [
        {
          type: "text/plain",
          getAsFile() {
            return null;
          },
        },
      ],
    },
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };

  let wasCalled = false;
  const didHandle = handleClipboardImagePasteEvent(event, () => {
    wasCalled = true;
  });

  assert.equal(didHandle, false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(wasCalled, false);
});

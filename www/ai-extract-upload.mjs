export function dispatchAiExtractFile(file, onFileSelected) {
  if (!file || typeof onFileSelected !== "function") return false;
  onFileSelected(file);
  return true;
}

export function clipboardItemsToImageFile(items, timestamp = Date.now(), filenamePrefix = "clipboard") {
  const list = Array.from(items || []);
  const imageItem = list.find((item) => String(item?.type || "").startsWith("image/"));
  if (!imageItem || typeof imageItem.getAsFile !== "function") return null;

  const sourceFile = imageItem.getAsFile();
  if (!sourceFile) return null;

  const safePrefix = String(filenamePrefix || "clipboard").replace(/[^a-z0-9-]+/gi, "-");

  return new File([sourceFile], `${safePrefix}-${timestamp}.png`, {
    type: sourceFile.type || "image/png",
    lastModified: timestamp,
  });
}

export function handleClipboardImagePasteEvent(
  event,
  onFileSelected,
  { timestamp = Date.now(), filenamePrefix = "clipboard" } = {},
) {
  if (!event) return false;
  const file = clipboardItemsToImageFile(event.clipboardData?.items, timestamp, filenamePrefix);
  if (!file) return false;
  if (typeof event.preventDefault === "function") {
    event.preventDefault();
  }
  return dispatchAiExtractFile(file, onFileSelected);
}

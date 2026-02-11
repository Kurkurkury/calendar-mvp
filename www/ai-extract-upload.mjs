export function dispatchAiExtractFile(file, onFileSelected) {
  if (!file || typeof onFileSelected !== "function") return false;
  onFileSelected(file);
  return true;
}

export function clipboardItemsToImageFile(items, timestamp = Date.now()) {
  const list = Array.from(items || []);
  const imageItem = list.find((item) => String(item?.type || "").startsWith("image/"));
  if (!imageItem || typeof imageItem.getAsFile !== "function") return null;

  const sourceFile = imageItem.getAsFile();
  if (!sourceFile) return null;

  return new File([sourceFile], `clipboard-${timestamp}.png`, {
    type: sourceFile.type || "image/png",
    lastModified: timestamp,
  });
}

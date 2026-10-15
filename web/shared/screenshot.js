// Shrinks a frame so its longest side is at most 1280px (the same size the
// macOS app sends) and encodes it as JPEG. Claude's [POINT] coordinates come
// back in this image's pixel space, so callers keep width/height to scale
// them back onto the real screen or page.
const SCREENSHOT_MAX_DIMENSION = 1280;

/**
 * @param {CanvasImageSource} imageSource a <video>, <img> or ImageBitmap
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 */
export function encodeScreenshot(imageSource, sourceWidth, sourceHeight) {
  const scale = Math.min(1, SCREENSHOT_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(imageSource, 0, 0, width, height);

  const base64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
  return { base64, mediaType: "image/jpeg", width, height };
}

export async function encodeScreenshotFromDataUrl(dataUrl) {
  const imageBlob = await (await fetch(dataUrl)).blob();
  const imageBitmap = await createImageBitmap(imageBlob);
  try {
    return encodeScreenshot(imageBitmap, imageBitmap.width, imageBitmap.height);
  } finally {
    imageBitmap.close();
  }
}

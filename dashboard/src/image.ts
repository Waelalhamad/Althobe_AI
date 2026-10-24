// Shrinks a photo in the browser before upload: phone photos are often 5-10 MB, WhatsApp allows 5 MB,
// and 1600px is plenty for a product photo in a chat.
export async function prepareImage(file: File, maxSide = 1600): Promise<{ mime: string; data: string; dataUrl: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { mime: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1), dataUrl };
}

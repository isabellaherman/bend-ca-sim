export function encodeUint8ToBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

export function encodeUint16ToBase64(data: Uint16Array): string {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return bytes.toString("base64");
}

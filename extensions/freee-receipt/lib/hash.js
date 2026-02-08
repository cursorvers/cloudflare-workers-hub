/**
 * Calculate SHA-256 hash of an ArrayBuffer.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<string>} Hex string.
 */
export async function calculateSHA256(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

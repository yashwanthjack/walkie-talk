/**
 * security.ts — Client-side room hashing with SHA-256
 */

export async function hashRoomWithPin(roomId: string, pin: string): Promise<string> {
  const cleanRoom = roomId.trim().toLowerCase();
  const cleanPin = pin.trim();
  if (!cleanPin) return cleanRoom;

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(`wt-room:${cleanRoom}::pin:${cleanPin}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hexSlice = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
    return `${cleanRoom}-pin-${hexSlice}`;
  } catch (err) {
    console.warn('Crypto SHA-256 fallback:', err);
    // Lightweight fallback
    let hash = 0;
    const str = `${cleanRoom}:${cleanPin}`;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return `${cleanRoom}-pin-${Math.abs(hash).toString(16)}`;
  }
}


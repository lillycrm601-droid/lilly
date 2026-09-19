export const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #00f0ff, #0072ff)', // Cyber Cyan to Neon Blue
  'linear-gradient(135deg, #ff007f, #7f00ff)', // Hot Pink to Bright Violet
  'linear-gradient(135deg, #ffff00, #ff5500)', // Neon Yellow to Neon Orange
  'linear-gradient(135deg, #39ff14, #008080)', // Lime Green to Teal
  'linear-gradient(135deg, #0070f3, #ff007f)', // Electric Blue to Magenta
  'linear-gradient(135deg, #00ff66, #00f0ff)', // Neon Green to Cyber Cyan
  'linear-gradient(135deg, #8b5cf6, #ff007f)'  // Electric Purple to Hot Pink
];

export const WORKSPACE_GRADIENT = 'linear-gradient(135deg, #00f0ff, #ff007f)';

// Stable string hash → bucket [0,6]. djb2-ish; only needs to be deterministic & well-spread.
export function gradientFor(seed) {
  if (seed == null) return AVATAR_GRADIENTS[0];
  const s = String(seed);
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length];
}

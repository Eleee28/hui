/** Ships the web app's own icon (public/pi-logo-3d.png, served as the favicon) as the desktop app's icon: it wraps
 * that existing PNG in a minimal macOS .icns container, so native and web share one image without an image library. */

/** PNG-compressed .icns entry types by square edge length. */
const entryTypes = new Map([[16, 'icp4'], [32, 'icp5'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']]);

export function appIcon(png) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 24 || !png.subarray(0, 8).equals(signature)) throw new Error('Web app icon is not a PNG.');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const type = entryTypes.get(width);
  if (!type || width !== height) {
    const sizes = [...entryTypes.keys()].join('/');
    throw new Error(`Web app icon must be square at ${sizes} pixels, not ${width}×${height}.`);
  }
  const header = Buffer.alloc(16);
  header.write('icns');
  header.writeUInt32BE(png.length + 16, 4);
  header.write(type, 8);
  header.writeUInt32BE(png.length + 8, 12);
  return { png, icns: Buffer.concat([header, png]) };
}

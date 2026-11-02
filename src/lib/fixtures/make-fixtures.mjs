// Regenerates the committed test fixtures: `node src/lib/fixtures/make-fixtures.mjs`.
// gps.jpg is a 16×16 mid-grey baseline JPEG carrying an EXIF GPS block (San Francisco)
// and a COM comment, so metadata tests never depend on a file outside the repository.
// The builders are exported for browser tests that need GPS in other containers.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const u16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value) => [
  (value >>> 24) & 0xff,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];
const segment = (marker, payload) => [0xff, marker, ...u16(payload.length + 2), ...payload];
const ascii = (text) => [...Buffer.from(text, "latin1")];
const entry = (tag, type, count, value) => [
  ...u16(tag),
  ...u16(type),
  ...u32(count),
  ...u32(value),
];
const rational = (n, d) => [...u32(n), ...u32(d)];
const letter = (char) => (char.charCodeAt(0) << 24) >>> 0;

/** Big-endian TIFF whose IFD0 holds `tags(layout)` plus a GPSInfo pointer; the GPS IFD,
 *  its rationals and then `data` follow IFD0. `tags` gets the offset where `data` starts. */
function tiffWithGpsIfd(tags, data = []) {
  const count = tags({ dataAt: 0 }).length / 12 + 1;
  const gpsAt = 8 + 2 + count * 12 + 4,
    latAt = gpsAt + 2 + 4 * 12 + 4,
    lngAt = latAt + 24,
    dataAt = lngAt + 24;
  return [
    ...ascii("MM"),
    ...u16(42),
    ...u32(8),
    ...u16(count),
    ...tags({ dataAt }),
    ...entry(0x8825, 4, 1, gpsAt), // GPSInfo pointer; highest tag, so it stays last
    ...u32(0),
    ...u16(4),
    ...entry(1, 2, 2, letter("N")), // GPSLatitudeRef
    ...entry(2, 5, 3, latAt), // GPSLatitude 37° 46' 29.64"
    ...entry(3, 2, 2, letter("W")), // GPSLongitudeRef
    ...entry(4, 5, 3, lngAt), // GPSLongitude 122° 25' 9.84"
    ...u32(0),
    ...rational(37, 1),
    ...rational(46, 1),
    ...rational(2964, 100),
    ...rational(122, 1),
    ...rational(25, 1),
    ...rational(984, 100),
    ...data,
  ];
}

/** APP1 EXIF (GPS) and a COM segment, inserted right after SOI. */
export function withGpsExif(jpeg) {
  const exif = segment(0xe1, [...ascii("Exif\0\0"), ...tiffWithGpsIfd(() => [])]);
  const comment = segment(0xfe, ascii("Taken at home"));
  return Uint8Array.from([...jpeg.subarray(0, 2), ...exif, ...comment, ...jpeg.subarray(2)]);
}

/** Uncompressed 8-bit RGB TIFF with a GPS IFD. */
export function rgbTiffWithGps(width, height, rgb) {
  return Uint8Array.from(
    tiffWithGpsIfd(
      ({ dataAt }) => [
        ...entry(256, 4, 1, width),
        ...entry(257, 4, 1, height),
        ...entry(258, 3, 3, dataAt), // BitsPerSample 8,8,8
        ...entry(259, 3, 1, 1 << 16), // no compression
        ...entry(262, 3, 1, 2 << 16), // RGB
        ...entry(273, 4, 1, dataAt + 6), // StripOffsets
        ...entry(277, 3, 1, 3 << 16), // SamplesPerPixel
        ...entry(278, 4, 1, height), // RowsPerStrip
        ...entry(279, 4, 1, rgb.length), // StripByteCounts
      ],
      [...u16(8), ...u16(8), ...u16(8), ...rgb],
    ),
  );
}

/** One grey component, DC-only blocks: a single 1-bit Huffman code for "difference 0"
 *  and one for end-of-block, so the scan is four blocks × two zero bits. */
function flatJpeg() {
  const dqt = segment(0xdb, [0, ...new Array(64).fill(1)]);
  const sof = segment(0xc0, [8, ...u16(16), ...u16(16), 1, 1, 0x11, 0]);
  const oneCode = (tableClass) => segment(0xc4, [tableClass, 1, ...new Array(15).fill(0), 0]);
  const sos = segment(0xda, [1, 1, 0x00, 0, 63, 0]);
  return Uint8Array.from([
    0xff,
    0xd8,
    ...dqt,
    ...sof,
    ...oneCode(0x00),
    ...oneCode(0x10),
    ...sos,
    0x00,
    0xff,
    0xd9,
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeFileSync(new URL("./gps.jpg", import.meta.url), withGpsExif(flatJpeg()));
}

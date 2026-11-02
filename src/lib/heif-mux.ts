import { CutoutError } from "./errors.ts";

export type StillItem = Readonly<{
  type: "hvc1" | "av01";
  width: number;
  height: number;
  displayWidth?: number;
  displayHeight?: number;
  description: Uint8Array | null;
  data: Uint8Array;
  channels: 1 | 3;
}>;

function u32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u16(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value);
  return bytes;
}

export function concat(parts: readonly Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function box(type: string, payload: Uint8Array) {
  return concat([u32(8 + payload.length), fourcc(type), payload]);
}

function fullBox(type: string, version: number, flags: number, payload: Uint8Array) {
  const head = new Uint8Array(4);
  head[0] = version;
  head[1] = (flags >> 16) & 255;
  head[2] = (flags >> 8) & 255;
  head[3] = flags & 255;
  return box(type, concat([head, payload]));
}

function fourcc(type: string) {
  return Uint8Array.of(
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  );
}

function cstr(value: string) {
  const bytes = new Uint8Array(value.length + 1);
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i);
  return bytes;
}

function ftyp(brand: "heic" | "avif") {
  const compat =
    brand === "heic"
      ? concat([fourcc("mif1"), fourcc("heic"), fourcc("miaf")])
      : // WebCodecs does not promise the AVIF Baseline profile (including auxiliary
        // stream constraints). Do not claim its optional MA1B brand from dimensions.
        concat([fourcc("avif"), fourcc("mif1"), fourcc("miaf")]);
  return box("ftyp", concat([fourcc(brand), u32(0), compat]));
}

function hdlr() {
  return fullBox("hdlr", 0, 0, concat([u32(0), fourcc("pict"), u32(0), u32(0), u32(0), cstr("")]));
}

function pitm(id: number) {
  return fullBox("pitm", 0, 0, u16(id));
}

function infe(id: number, type: string, hidden: boolean) {
  return fullBox("infe", 2, hidden ? 1 : 0, concat([u16(id), u16(0), fourcc(type), cstr("")]));
}

function iinf(items: readonly StillItem[]) {
  const entries = items.map((item, index) => infe(index + 1, item.type, item.channels === 1));
  return fullBox("iinf", 0, 0, concat([u16(items.length), ...entries]));
}

function iref(hasAlpha: boolean) {
  if (!hasAlpha) return new Uint8Array(0);
  const auxl = box("auxl", concat([u16(2), u16(1), u16(1)]));
  return fullBox("iref", 0, 0, auxl);
}

function ispe(width: number, height: number) {
  return fullBox("ispe", 0, 0, concat([u32(width), u32(height)]));
}

function pixi(channels: 1 | 3) {
  const bits = channels === 3 ? Uint8Array.of(3, 8, 8, 8) : Uint8Array.of(1, 8);
  return fullBox("pixi", 0, 0, bits);
}

function needsCrop(item: StillItem) {
  return (
    (item.displayWidth ?? item.width) !== item.width ||
    (item.displayHeight ?? item.height) !== item.height
  );
}

function clap(item: StillItem) {
  const width = item.displayWidth ?? item.width;
  const height = item.displayHeight ?? item.height;
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, width);
  view.setUint32(4, 1);
  view.setUint32(8, height);
  view.setUint32(12, 1);
  view.setInt32(16, width - item.width);
  view.setUint32(20, 2);
  view.setInt32(24, height - item.height);
  view.setUint32(28, 2);
  return box("clap", bytes);
}

function colr() {
  const body = new Uint8Array(11);
  body.set(fourcc("nclx"), 0);
  const view = new DataView(body.buffer);
  view.setUint16(4, 1);
  view.setUint16(6, 13);
  view.setUint16(8, 1);
  body[10] = 0;
  return box("colr", body);
}

function auxC() {
  return fullBox("auxC", 0, 0, cstr("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha"));
}

function codecConfig(item: StillItem) {
  if (item.type === "hvc1") {
    if (!item.description?.length) throw new Error("HEIC encoder did not return a codec config.");
    return box("hvcC", item.description);
  }
  return box("av1C", av1c(item));
}

/** AV1 §5.5 sequence header -> AV1-ISOBMFF §2.3 configuration, never a size guess. */
function av1c(item: StillItem): Uint8Array {
  const data = item.data;
  for (let offset = 0; offset < data.length;) {
    const header = data[offset++]!;
    if (header & 0x81) break;
    if (header & 4) offset++;
    let size = data.length - offset;
    if (header & 2) {
      size = 0;
      let shift = 0,
        byte: number;
      do {
        if (offset >= data.length || shift > 49) throw new Error("Invalid AV1 OBU size.");
        byte = data[offset++]!;
        size += (byte & 127) * 2 ** shift;
        shift += 7;
      } while (byte & 128);
    }
    if (!Number.isSafeInteger(size) || offset + size > data.length) break;
    if (((header >> 3) & 15) !== 1) {
      offset += size;
      continue;
    }
    const end = (offset + size) * 8;
    let bit = offset * 8;
    const read = (count: number) => {
      if (bit + count > end) throw new Error("Truncated AV1 sequence header.");
      let value = 0;
      for (let i = 0; i < count; i++, bit++)
        value = value * 2 + ((data[bit >> 3]! >> (7 - (bit & 7))) & 1);
      return value;
    };
    const profile = read(3);
    read(1); // still_picture
    const reduced = read(1);
    let level = 0,
      tier = 0;
    if (reduced) level = read(5);
    else {
      let model = 0,
        delayBits = 0;
      if (read(1)) {
        // timing_info_present_flag
        read(32);
        read(32);
        if (read(1)) {
          let leading = 0;
          while (leading < 32 && !read(1)) leading++;
          if (leading < 32) read(leading); // uvlc
        }
        model = read(1);
        if (model) {
          delayBits = read(5) + 1;
          read(32);
          read(5);
          read(5);
        }
      }
      const initialDelay = read(1),
        points = read(5) + 1;
      for (let i = 0; i < points; i++) {
        read(12);
        const opLevel = read(5),
          opTier = opLevel > 7 ? read(1) : 0;
        if (i === 0) {
          level = opLevel;
          tier = opTier;
        }
        if (model && read(1)) {
          read(delayBits);
          read(delayBits);
          read(1);
        }
        if (initialDelay && read(1)) read(4);
      }
    }
    const widthBits = read(4) + 1,
      heightBits = read(4) + 1;
    read(widthBits);
    read(heightBits);
    if (!reduced && read(1)) {
      read(4);
      read(3);
    } // frame IDs
    read(3); // superblock, filter intra, intra edge filter
    if (!reduced) {
      read(4); // interintra, masked compound, warped motion, dual filter
      const orderHint = read(1);
      if (orderHint) read(2);
      const screenTools = read(1) ? 2 : read(1);
      if (screenTools > 0 && !read(1)) read(1);
      if (orderHint) read(3);
    }
    read(3); // superres, cdef, restoration
    const high = read(1),
      twelve = profile === 2 && high ? read(1) : 0;
    const mono = profile === 1 ? 0 : read(1);
    let primaries = 2,
      transfer = 2,
      matrix = 2;
    if (read(1)) {
      primaries = read(8);
      transfer = read(8);
      matrix = read(8);
    }
    let subX = 1,
      subY = 1,
      position = 0,
      fullRange = 1;
    if (mono)
      fullRange = read(1); // monochrome implies 4:2:0 config flags
    else if (primaries === 1 && transfer === 13 && matrix === 0) {
      subX = 0;
      subY = 0;
    } else {
      fullRange = read(1);
      if (profile === 1) {
        subX = 0;
        subY = 0;
      } else if (profile === 2) {
        subX = twelve ? read(1) : 1;
        subY = twelve && subX ? read(1) : 0;
      }
      if (subX && subY) position = read(2);
    }
    // AVIF §4.1 applies to every auxiliary stream, regardless of profile brands.
    // I420 input is not a promise of monochrome output; never relabel its payload.
    if (item.channels === 1 && (!mono || !fullRange))
      throw new CutoutError(
        "export",
        "This browser cannot preserve transparency in AVIF. Choose PNG.",
        false,
        {
          cause: new Error(
            `AVIF alpha must be monochrome and full-range; got ${mono}, ${fullRange}.`,
          ),
        },
      );
    return Uint8Array.of(
      0x81,
      (profile << 5) | level,
      (tier << 7) |
        (high << 6) |
        (twelve << 5) |
        (mono << 4) |
        (subX << 3) |
        (subY << 2) |
        position,
      0,
    );
  }
  throw new Error("AVIF encoder did not return an AV1 sequence header.");
}

function ipco(items: readonly StillItem[]) {
  const parts: Uint8Array[] = [];
  for (const item of items) {
    parts.push(codecConfig(item), ispe(item.width, item.height), pixi(item.channels));
    if (item.channels === 3) parts.push(colr());
    else parts.push(auxC());
    if (needsCrop(item)) parts.push(clap(item));
  }
  return box("ipco", concat(parts));
}

function ipma(items: readonly StillItem[]) {
  const rows: Uint8Array[] = [];
  let property = 1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const count = needsCrop(item) ? 5 : 4;
    const assoc = new Uint8Array(3 + count);
    const view = new DataView(assoc.buffer);
    view.setUint16(0, index + 1);
    assoc[2] = count;
    for (let i = 0; i < count; i += 1) {
      assoc[3 + i] = 0x80 | property;
      property += 1;
    }
    rows.push(assoc);
  }
  return fullBox("ipma", 0, 0, concat([u32(items.length), ...rows]));
}

function iloc(items: readonly StillItem[], mdatStart: number) {
  const packed = Uint8Array.of(0x44, 0x00);
  const rows: Uint8Array[] = [packed, u16(items.length)];
  let offset = mdatStart;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    rows.push(concat([u16(index + 1), u16(0), u16(1), u32(offset), u32(item.data.length)]));
    offset += item.data.length;
  }
  return fullBox("iloc", 0, 0, concat(rows));
}

/**
 * Apple's HEIF decoder (Safari, Photos, Preview) shows a file whose colour and alpha hvcC
 * are byte-identical as fully transparent, and VideoToolbox returns identical ones at about
 * half of common sizes (1080x1080, 800x600). The alpha copy then gets a different
 * avgFrameRate (record bytes 19-20), which no still-image decoder reads.
 */
function distinctAlphaConfig(color: StillItem, alpha: StillItem): StillItem {
  const config = alpha.description;
  const same =
    alpha.type === "hvc1" &&
    config &&
    config.length > 22 &&
    color.description?.length === config.length &&
    color.description.every((value, index) => value === config[index]);
  if (!same) return alpha;
  const description = Uint8Array.from(config);
  description[20] = description[20]! ^ 1;
  return { ...alpha, description };
}

export function muxHeif(kind: "heic" | "avif", color: StillItem, alpha: StillItem | null): Blob {
  const items = alpha ? [color, distinctAlphaConfig(color, alpha)] : [color];
  const payload = concat(items.map((item) => item.data));
  const after = concat([
    iinf(items),
    iref(Boolean(alpha)),
    box("iprp", concat([ipco(items), ipma(items)])),
  ]);
  const before = concat([hdlr(), pitm(1)]);
  const ilocBytes = 16 + items.length * 14;
  const metaInner = 4 + before.length + ilocBytes + after.length;
  const metaSize = 8 + metaInner;
  const ftypBox = ftyp(kind);
  const mdatStart = ftypBox.length + metaSize + 8;
  const meta = fullBox("meta", 0, 0, concat([before, iloc(items, mdatStart), after]));
  const file = concat([ftypBox, meta, box("mdat", payload)]);
  return new Blob([file], { type: kind === "heic" ? "image/heic" : "image/avif" });
}

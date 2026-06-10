import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "assets", "cliboard-icon-source.png");
const iconDir = path.join(root, "src-tauri", "icons");
const publicDir = path.join(root, "public");
const workDir = path.join(iconDir, "Cliboard.iconset");

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function parsePng(filePath) {
  const bytes = readFileSync(filePath);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`${filePath} is not a PNG`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error("Only non-interlaced 8-bit PNG files are supported");
      }
      if (colorType !== 2 && colorType !== 6) {
        throw new Error("Only RGB/RGBA PNG files are supported");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  let input = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[input];
    input += 1;
    const row = Buffer.from(inflated.subarray(input, input + stride));
    input += stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 255;
      else if (filter === 2) row[x] = (row[x] + up) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
    }

    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      rgba[dst] = row[src];
      rgba[dst + 1] = row[src + 1];
      rgba[dst + 2] = row[src + 2];
      rgba[dst + 3] = channels === 4 ? row[src + 3] : 255;
    }
    previous = row;
  }

  return { width, height, rgba };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function sampleBilinear(image, x, y) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(image.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
  const tx = x - x0;
  const ty = y - y0;
  const out = [0, 0, 0, 0];

  for (const [px, py, weight] of [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty],
  ]) {
    const index = (py * image.width + px) * 4;
    out[0] += image.rgba[index] * weight;
    out[1] += image.rgba[index + 1] * weight;
    out[2] += image.rgba[index + 2] * weight;
    out[3] += image.rgba[index + 3] * weight;
  }

  return out.map(Math.round);
}

function roundedRectAlpha(x, y, size) {
  const left = size * 0.03;
  const top = size * 0.018;
  const right = size * 0.97;
  const bottom = size * 0.957;
  const radius = size * 0.145;
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  const distance = Math.hypot(x - cx, y - cy);
  return Math.max(0, Math.min(1, radius + 0.75 - distance));
}

function renderIcon(image, size) {
  const output = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const srcX = ((x + 0.5) / size) * image.width - 0.5;
      const srcY = ((y + 0.5) / size) * image.height - 0.5;
      const [r, g, b, a] = sampleBilinear(image, srcX, srcY);
      const index = (y * size + x) * 4;
      output[index] = r;
      output[index + 1] = g;
      output[index + 2] = b;
      output[index + 3] = Math.round(a * roundedRectAlpha(x + 0.5, y + 0.5, size));
    }
  }
  return output;
}

function writePng(image, name, size) {
  const png = encodePng(size, size, renderIcon(image, size));
  writeFileSync(path.join(iconDir, name), png);
  return png;
}

function writePublicPng(image, name, size) {
  const png = encodePng(size, size, renderIcon(image, size));
  writeFileSync(path.join(publicDir, name), png);
  return png;
}

function writeIco(image) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => encodePng(size, size, renderIcon(image, size)));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  writeFileSync(path.join(iconDir, "icon.ico"), Buffer.concat([header, ...images]));
}

function writeIcns(image) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const spec = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  for (const [name, size] of spec) {
    writeFileSync(path.join(workDir, name), encodePng(size, size, renderIcon(image, size)));
  }
  execFileSync("iconutil", ["-c", "icns", workDir, "-o", path.join(iconDir, "icon.icns")]);
  rmSync(workDir, { recursive: true, force: true });
}

mkdirSync(iconDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });
const source = parsePng(sourcePath);
writePng(source, "icon.png", 1024);
writePng(source, "32x32.png", 32);
writePng(source, "128x128.png", 128);
writePng(source, "128x128@2x.png", 256);
writePng(source, "Square30x30Logo.png", 30);
writePng(source, "Square44x44Logo.png", 44);
writePng(source, "Square71x71Logo.png", 71);
writePng(source, "Square89x89Logo.png", 89);
writePng(source, "Square107x107Logo.png", 107);
writePng(source, "Square142x142Logo.png", 142);
writePng(source, "Square150x150Logo.png", 150);
writePng(source, "Square284x284Logo.png", 284);
writePng(source, "Square310x310Logo.png", 310);
writePng(source, "StoreLogo.png", 50);
writePublicPng(source, "favicon.png", 64);
writeIco(source);
writeIcns(source);

console.log(`Generated app icons from ${sourcePath}`);

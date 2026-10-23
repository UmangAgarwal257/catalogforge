import { createReadStream } from "node:fs";
import { mkdir, open, link, unlink, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { IngestionError, LIMITS } from "./contracts";

export interface OriginalStorage {
  save(bytes: Uint8Array): Promise<string>;
  open(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

// Development only: both host applications must share this private directory.
export class LocalOriginalStorage implements OriginalStorage {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error("LOCAL_UPLOAD_DIR must be an absolute private directory.");
  }
  private path(key: string): string {
    if (!/^[0-9a-f-]{36}\.original$/.test(key)) throw new IngestionError("INVALID_STORAGE_KEY", "Invalid original-file key.");
    return resolve(this.directory, key);
  }
  async save(bytes: Uint8Array): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = `${randomUUID()}.original`;
    const temporary = resolve(this.directory, `.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      // Hard-link publishes a complete file atomically, without overwriting a key.
      await link(temporary, this.path(key));
      return key;
    } finally {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
  async open(key: string): Promise<Readable> {
    const path = this.path(key);
    if (await realpath(path) !== path) throw new IngestionError("INVALID_STORAGE_KEY", "Original-file symlinks are not supported.");
    return createReadStream(path);
  }
  async remove(key: string): Promise<void> { await unlink(this.path(key)); }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readOriginal(storage: OriginalStorage, key: string): Promise<Buffer> {
  const stream = await storage.open(key);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > LIMITS.fileBytes) throw new IngestionError("FILE_TOO_LARGE", "Stored spreadsheet exceeds 10 MiB.");
      chunks.push(bytes);
    }
  } finally { stream.destroy(); }
  return Buffer.concat(chunks);
}

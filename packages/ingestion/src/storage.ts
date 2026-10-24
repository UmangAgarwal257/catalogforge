import { mkdir, open, link, unlink, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { IngestionError, LIMITS } from "./contracts";

export interface OriginalStorage {
  save(bytes: Uint8Array): Promise<string>;
  open(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

// Test adapter only; application runtimes always use shared private object storage.
export class LocalOriginalStorage implements OriginalStorage {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error("Test storage directory must be absolute.");
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
    const { createReadStream } = await import("node:fs");
    return createReadStream(path);
  }
  async remove(key: string): Promise<void> { await unlink(this.path(key)); }
}

/** Private shared storage for production web and worker processes. Keys stay opaque and store data is never exposed via public buckets. */
export class SupabaseOriginalStorage implements OriginalStorage {
  private readonly client: SupabaseClient;
  constructor(url: string, serviceRoleKey: string, private readonly bucket = "catalogforge-private") {
    if (!URL.canParse(url) || !serviceRoleKey) throw new Error("Supabase private storage configuration is incomplete.");
    this.client = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  }
  private validateKey(key: string) {
    if (!/^[0-9a-f-]{36}\.original$/.test(key)) throw new IngestionError("INVALID_STORAGE_KEY", "Invalid original-file key.");
    return key;
  }
  async ensurePrivateBucket() {
    const { data } = await this.client.storage.getBucket(this.bucket);
    if (data) {
      if (data.public) throw new Error("Configured storage bucket must be private.");
      return;
    }
    const { error } = await this.client.storage.createBucket(this.bucket, { public: false, fileSizeLimit: LIMITS.fileBytes });
    if (error && !/already exists/i.test(error.message)) throw new Error("Supabase private storage bucket could not be initialized.");
    const verified = await this.client.storage.getBucket(this.bucket);
    if (verified.error || verified.data?.public !== false) throw new Error("Configured storage bucket must be private.");
  }
  async save(bytes: Uint8Array): Promise<string> {
    const key = `${randomUUID()}.original`;
    const { error } = await this.client.storage.from(this.bucket).upload(key, bytes, { contentType: "application/octet-stream", upsert: false });
    if (error) throw new Error("Original asset could not be stored in private object storage.");
    return key;
  }
  async open(key: string): Promise<Readable> {
    const { data, error } = await this.client.storage.from(this.bucket).download(this.validateKey(key));
    if (error || !data) throw new IngestionError("STORAGE_READ_FAILED", "Stored asset is unavailable.", 503);
    if (data.size > LIMITS.fileBytes) throw new IngestionError("FILE_TOO_LARGE", "Stored asset exceeds the configured size limit.");
    return Readable.from(Buffer.from(await data.arrayBuffer()));
  }
  async remove(key: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([this.validateKey(key)]);
    if (error) throw new Error("Stored asset could not be removed.");
  }
  async verifyPrivateBucket() {
    const { data, error } = await this.client.storage.getBucket(this.bucket);
    if (error || !data || data.public) throw new Error("Configured Supabase storage bucket is missing or public.");
  }
}

export function createOriginalStorage(): OriginalStorage {
  return new SupabaseOriginalStorage(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", process.env.SUPABASE_STORAGE_BUCKET || "catalogforge-private");
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

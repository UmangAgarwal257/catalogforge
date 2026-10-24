import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalOriginalStorage, SupabaseOriginalStorage, createOriginalStorage, readOriginal, sha256 } from "./storage";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("preserves exact original bytes, uses opaque keys, and cleans its staging files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "catalogforge-storage-")); directories.push(directory);
  const storage = new LocalOriginalStorage(directory);
  const bytes = Buffer.from("\ufeffSKU;Notes\r\n001;original\r\n");
  const key = await storage.save(bytes);
  expect(await readOriginal(storage, key)).toEqual(bytes);
  expect(sha256(await readOriginal(storage, key))).toBe(sha256(bytes));
  expect(await readdir(directory)).toEqual([key]);
  await expect(storage.open("../outside")).rejects.toThrow(/key/);
  await storage.remove(key);
  expect(await readdir(directory)).toEqual([]);
});

it("rejects relative storage directories", () => {
  expect(() => new LocalOriginalStorage("public/uploads")).toThrow(/absolute/);
});

it("never selects filesystem storage for an application runtime", () => {
  const old = { NODE_ENV: process.env.NODE_ENV, LOCAL_UPLOAD_DIR: process.env.LOCAL_UPLOAD_DIR, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  try {
    process.env.NODE_ENV = "development";
    process.env.LOCAL_UPLOAD_DIR = "/tmp/should-not-be-selected";
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-server-key";
    expect(createOriginalStorage()).toBeInstanceOf(SupabaseOriginalStorage);
  } finally {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

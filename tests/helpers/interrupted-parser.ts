// Real process-death fixture: stop after one committed batch, without cleanup.
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { processParseImport } from "@catalogforge/ingestion/processing";
import { LocalOriginalStorage } from "@catalogforge/ingestion/storage";

const [queueName, storeId, directory] = process.argv.slice(2);
if (!queueName || !storeId || !directory || !process.env.REDIS_URL) throw new Error("Missing isolated fixture configuration");
const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const worker = new Worker(queueName, async (job) => {
  await processParseImport(job.data.importId, storeId, new LocalOriginalStorage(directory), {
    batchSize: 1,
    afterBatch: async () => {
      console.log("BATCH_COMMITTED");
      await new Promise<void>(() => { /* Parent kills this process. */ });
    }
  });
}, { connection, lockDuration: 1000, stalledInterval: 1000 });
worker.on("error", () => console.error("Fixture worker error"));
await worker.waitUntilReady();

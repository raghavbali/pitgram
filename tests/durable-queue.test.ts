import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DurableQueue } from "../dist/durable-queue.js";

const execute = promisify(execFile);
const update = (id: number) => ({ update_id: id, message: { text: `message ${id}`, message_id: id + 100 } });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pitgram-durable-"));
  const queue = new DurableQueue<ReturnType<typeof update>>(directory, "fixture-bot");
  await queue.load();
  return { directory, queue, async close() { await queue.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("synced raw batches and running entries survive abrupt process exit; completed data stays removed", async () => {
  const app = await fixture();
  try {
    await app.queue.close();
    const script = `import { DurableQueue } from ${JSON.stringify(new URL("../dist/durable-queue.js", import.meta.url).href)};
      const queue = new DurableQueue(process.argv[1], 'fixture-bot');
      await queue.load();
      await queue.ingest([{update_id:101,message:{text:'A'}},{update_id:102,message:{text:'B'}}]);
      await queue.running([101]);
      process.exit(0);`;
    await execute(process.execPath, ["--input-type=module", "-e", script, app.directory]);
    await app.queue.load();
    assert.equal(app.queue.lastUpdateId, 102);
    assert.deepEqual(app.queue.entries.map(entry => [entry.update.update_id, entry.state, entry.attempts]), [
      [101, "pending", 1], [102, "pending", 0],
    ]);
    await app.queue.running([101]);
    await app.queue.complete([101]);
    await app.queue.complete([102]);
    await app.queue.close();
    await app.queue.load();
    await app.queue.ingest([{ update_id: 101 }, { update_id: 102 }]);
    assert.deepEqual(app.queue.entries, [], "Repeated fetched batches must not replay completed updates");
    assert.equal(app.queue.lastUpdateId, 102);
    assert.ok(!(await readFile(app.queue.path, "utf8")).includes('"text"'), "Completed payload is pruned");
  } finally { await app.close(); }
});

test("a competing bridge cannot reset running entries or overwrite the owner's snapshot", async () => {
  const app = await fixture();
  const second = new DurableQueue(app.directory, "fixture-bot");
  try {
    await app.queue.ingest([update(101)]);
    await app.queue.running([101]);
    await assert.rejects(second.load(), /Another Pitgram bridge/);
    assert.equal(app.queue.entries[0].state, "running");
    await assert.rejects(second.ingest([update(102)]), /not open/);
    await app.queue.close();
    await second.load();
    assert.equal(second.entries[0].state, "pending");
  } finally { await second.close(); await app.close(); }
});

test("failed snapshot writes preserve the previous in-memory checkpoint and clean temporary files", async () => {
  const app = await fixture();
  try {
    await app.queue.ingest([update(101)]);
    await rm(app.queue.path);
    await mkdir(app.queue.path); // Force atomic rename to fail without relying on OS permissions.
    await assert.rejects(app.queue.ingest([update(102)]));
    assert.equal(app.queue.lastUpdateId, 101);
    assert.deepEqual(app.queue.entries.map(entry => entry.update.update_id), [101]);
    assert.equal((await readdir(app.directory)).some(name => name.endsWith(".tmp")), false);
  } finally { await app.close(); }
});

test("failed and aborted entries stay held across restart until an explicit retry", async () => {
  const app = await fixture();
  try {
    await app.queue.ingest([update(101), update(102)]);
    await app.queue.running([101]);
    await app.queue.fail([101]);
    await app.queue.close();
    await app.queue.load();
    assert.deepEqual(app.queue.counts, { pending: 1, running: 0, failed: 1 });
    assert.deepEqual(await app.queue.retry(999), []);
    assert.deepEqual(await app.queue.retry(101), [101]);
    await app.queue.running([101]);
    assert.equal(app.queue.entries[0].attempts, 2);
  } finally { await app.close(); }
});

test("queue files are owner-only, namespaces are isolated, and corruption never resets the checkpoint", async () => {
  const app = await fixture();
  const other = new DurableQueue(app.directory, "other-bot");
  try {
    await app.queue.ingest([update(101)]);
    assert.equal((await stat(app.queue.path)).mode & 0o777, 0o600);
    assert.equal((await stat(app.directory)).mode & 0o777, 0o700);
    assert.ok(!app.queue.path.includes("fixture-bot"));
    await other.load();
    assert.deepEqual(other.entries, []);
    await app.queue.close();
    await writeFile(app.queue.path, '{"version":1,"entries":"corrupt"}');
    await assert.rejects(app.queue.load(), /Invalid.*Pitgram/);
    assert.equal(await readFile(app.queue.path, "utf8"), '{"version":1,"entries":"corrupt"}');
  } finally { await other.close(); await app.close(); }
});

test("concurrent mutations within one owner preserve FIFO and update identities", async () => {
  const app = await fixture();
  try {
    await Promise.all([app.queue.ingest([update(101)]), app.queue.ingest([update(102)]), app.queue.running([101])]);
    assert.deepEqual(app.queue.entries.map(entry => [entry.update.update_id, entry.state]), [[101, "running"], [102, "pending"]]);
    await app.queue.ingest([update(101), update(102)]);
    assert.equal(app.queue.entries.length, 2);
  } finally { await app.close(); }
});

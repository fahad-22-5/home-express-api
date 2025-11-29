// worker.js
const amqplib = require("amqplib");
const fs = require("fs");             // keep for streams etc.
const fsp = require("fs").promises; 
const path = require("path");

// async function getUniquePath(destPath) {
//   let ext = path.extname(destPath);
//   let base = path.basename(destPath, ext);
//   let dir = path.dirname(destPath);
//   let candidate = destPath;
//   let counter = 1;

//   while (true) {
//     try {
//       await fs.access(candidate); // file exists
//       candidate = path.join(dir, `${base}(${counter})${ext}`);
//       counter++;
//     } catch {
//       return candidate; // file does not exist
//     }
//   }
// }


function getUniquePath(targetPath) {
  let dir = path.dirname(targetPath);
  let base = path.basename(targetPath, path.extname(targetPath));
  let ext = path.extname(targetPath);
  let finalPath = targetPath;
  let counter = 1;

  while (fs.existsSync(finalPath)) {   // ✅ use fs here
    finalPath = path.join(dir, `${base}(${counter})${ext}`);
    counter++;
  }

  return finalPath;
}


const JOB_STATE_DIR = path.join(__dirname, ".job-state");

async function updateJobState(id, update) {
  const p = path.join(JOB_STATE_DIR, `${id}.json`);
  try {
    let current = {};
    try {
      const json = await fsp.readFile(p, "utf8");
      current = JSON.parse(json);
    } catch {}
    const merged = { ...current, ...update, updatedAt: Date.now() };
    await fsp.writeFile(p, JSON.stringify(merged, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to update job state:", err);
  }
}


async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(src);
    const writeStream = fs.createWriteStream(dest);

    readStream.on("error", reject);
    writeStream.on("error", reject);

    writeStream.on("close", async () => {
      try {
        await fsp.unlink(src); // delete temp file after successful copy
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    readStream.pipe(writeStream);
  });
}


async function startWorker() {
  const conn = await amqplib.connect("amqp://localhost");
  const channel = await conn.createChannel();
  await channel.assertQueue("file_uploads");
  await channel.assertQueue("job_updates", { durable: true });

channel.consume("file_uploads", async (msg) => {
  const { jobId, tempPath, targetPath } = JSON.parse(msg.content.toString());
  try {
    //await moveFile(tempPath, targetPath);

    let finalPath = await getUniquePath(targetPath);
    await moveFile(tempPath, finalPath);
    //await fs.unlink(tmpPath);
    await updateJobState(jobId, { status: "done", file: path.basename(finalPath) });
    console.log(`✔️ File moved: ${finalPath}`);

    await channel.sendToQueue(
      "job_updates",
      Buffer.from(JSON.stringify({
        id: jobId,
        status: "done",
        updatedAt: Date.now()
      }))
    );

    channel.ack(msg);
  } catch (err) {
    await updateJobState(jobId, { status: "failed", error: err.message });
    console.error("❌ Error moving file:", err);
    await channel.sendToQueue(
      "job_updates",
      Buffer.from(JSON.stringify({
        id: jobId,
        status: "error",
        updatedAt: Date.now()
      }))
    );
    channel.ack(msg);
  }
});


  console.log("Worker is running...");
}

startWorker();

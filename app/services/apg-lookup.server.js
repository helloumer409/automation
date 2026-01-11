import ftp from "basic-ftp";
import fs from "fs";
import path from "path";
import unzipper from "unzipper";

export async function downloadAndExtractAPGFeed() {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  const tmpDir = "/tmp/apg";
  const zipPath = path.join(tmpDir, "premier_data_feed_master.zip");

  try {
    // Ensure temp dir exists
    fs.mkdirSync(tmpDir, { recursive: true });

    await client.access({
      host: process.env.APG_FTP_HOST,
      user: process.env.APG_FTP_USERNAME,
      password: process.env.APG_FTP_PASSWORD,
      port: Number(process.env.APG_FTP_PORT),
      secure: false,
    });

    // Download ZIP
    await client.downloadTo(zipPath, "premier_data_feed_master.zip");
    console.log("✅ APG ZIP downloaded:", zipPath);

    // Extract ZIP
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: tmpDir }))
      .promise();

    console.log("✅ APG ZIP extracted to:", tmpDir);

    // Find CSV file dynamically
    const files = fs.readdirSync(tmpDir);
    const csvFile = files.find(f => f.endsWith(".csv"));

    if (!csvFile) {
      throw new Error("CSV file not found after extraction");
    }

    const csvPath = path.join(tmpDir, csvFile);
    console.log("✅ APG CSV ready:", csvPath);

    return csvPath;
  } catch (err) {
    console.error("❌ APG FTP ERROR:", err);
    throw err;
  } finally {
    client.close();
  }
}

import ftp from "basic-ftp";
import fs from "fs";
import path from "path";
import unzipper from "unzipper";

export async function downloadAndExtractAPGFeed() {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  const tmpDir = path.resolve("./tmp");
  const zipPath = path.join(tmpDir, "premier_data_feed_master.zip");
  const extractDir = path.join(tmpDir, "apg");

  try {
    // Ensure directories exist
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir);

    // FTP Login
    await client.access({
      host: process.env.APG_FTP_HOST,
      user: process.env.APG_FTP_USERNAME,
      password: process.env.APG_FTP_PASSWORD,
      port: Number(process.env.APG_FTP_PORT || 21),
      secure: false,
    });

    // Download ZIP
    await client.downloadTo(zipPath, "premier_data_feed_master.zip");
    console.log("✅ APG ZIP downloaded");

    // Extract ZIP
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();

    console.log("✅ APG ZIP extracted");

    return extractDir;
  } catch (error) {
    console.error("❌ APG FTP ERROR:", error);
    throw error;
  } finally {
    client.close();
  }
}

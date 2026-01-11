import ftp from "basic-ftp";
import fs from "fs";
import path from "path";
import unzipper from "unzipper";

export async function downloadAndPrepareAPGCSV() {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  const tmpDir = path.resolve("./tmp");
  const zipPath = path.join(tmpDir, "premier_data_feed_master.zip");
  const extractDir = path.join(tmpDir, "apg");

  try {
    // Ensure dirs
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir);

    // FTP connect
    await client.access({
      host: process.env.APG_FTP_HOST,
      user: process.env.APG_FTP_USERNAME,
      password: process.env.APG_FTP_PASSWORD,
      port: Number(process.env.APG_FTP_PORT),
      secure: false,
    });

    // Download ZIP
    await client.downloadTo(zipPath, "premier_data_feed_master.zip");
    console.log("✅ APG ZIP downloaded");

    // Unzip
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();

    console.log("✅ APG ZIP extracted");

    // Find CSV
    const files = fs.readdirSync(extractDir);
    const csvFile = files.find(f => f.endsWith(".csv"));

    if (!csvFile) {
      throw new Error("No CSV found inside ZIP");
    }

    return path.join(extractDir, csvFile);
  } finally {
    client.close();
  }
}

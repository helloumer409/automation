import ftp from "basic-ftp";
import fs from "fs";
import path from "path";

export async function downloadAPGFeed() {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  try {
    const downloadDir = path.resolve("./tmp");
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir);
    }

    await client.access({
      host: "datafeed.pppwd.com",
      user: "77-0001025",
      password: "premierpass",
      port: 21,
      secure: false,
    });

    const localZipPath = path.join(downloadDir, "premier_data_feed_master.zip");

    await client.downloadTo(
      localZipPath,
      "premier_data_feed_master.zip"
    );

    console.log("✅ APG ZIP downloaded:", localZipPath);
  } catch (err) {
    console.error("❌ FTP ERROR:", err);
  } finally {
    client.close();
  }
}

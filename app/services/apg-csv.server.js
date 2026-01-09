import fs from "fs";
import path from "path";
import csv from "csv-parser";

export async function readAPGCSV() {
  const filePath = path.join(
    process.cwd(),
    "tmp",
    "premier_data_feed_master.csv"
  );

  if (!fs.existsSync(filePath)) {
    throw new Error("CSV file not found");
  }

  const results = [];

  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        // Calculate total inventory from all warehouse columns
        const nvWhse = Number(row["NV whse"] || row["NV whse"] || 0) || 0;
        const kyWhse = Number(row["KY whse"] || row["KY whse"] || 0) || 0;
        const mfgInvt = Number(row["MFG Invt"] || row["MFG Invt"] || 0) || 0;
        const waWhse = Number(row["WA whse"] || row["WA whse"] || 0) || 0;
        const totalInventory = nvWhse + kyWhse + mfgInvt + waWhse;
        
        // Preserve original row structure for compatibility
        const processedRow = {
          upc: row["Upc"]?.trim(),
          premierPartNumber: row["Premier Part Number"]?.trim(),
          priceMAP: row["MAP"],
          inventory: totalInventory, // Use calculated total from warehouses
          // Keep original fields for sync function compatibility
          Upc: row["Upc"]?.trim(),
          "Premier Part Number": row["Premier Part Number"]?.trim(),
          MAP: row["MAP"],
          "Customer Price": row["Customer Price"] || row["Customer Price (USD)"] || row["Cost"],
          "Mfg Part Number": row["Mfg Part Number"] || row["Manufacturer Part Number"],
          "USA Item Availability": totalInventory, // Use calculated total
          // Warehouse breakdown (for reference)
          "NV whse": nvWhse,
          "KY whse": kyWhse,
          "MFG Invt": mfgInvt,
          "WA whse": waWhse,
          // Keep entire original row for flexibility
          ...row
        };
        results.push(processedRow);
      })
      .on("end", () => {
        console.log("✅ CSV parsed. Total rows:", results.length);
        if (results.length > 0) {
          console.log("📝 Sample CSV row fields:", Object.keys(results[0]));
          console.log("📝 Sample row MAP value:", results[0].MAP || results[0].map || "not found");
        }
        resolve(results);
      })
      .on("error", reject);
  });
}

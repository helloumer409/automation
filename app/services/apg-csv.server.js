import fs from "fs";
import path from "path";
import csv from "csv-parser";

/**
 * Converts UPC from scientific notation (e.g., 8.34532E+11) to proper number string
 */
function normalizeUPC(upcRaw) {
  if (!upcRaw) return "";
  let upc = String(upcRaw).trim();
  
  // Convert scientific notation to full number (e.g., 8.34532E+11 -> 834532000000)
  if (upc.includes("E+") || upc.includes("e+") || upc.includes("E-") || upc.includes("e-")) {
    try {
      const numValue = parseFloat(upc);
      upc = Math.round(numValue).toString();
    } catch (e) {
      // Keep original if conversion fails
    }
  }
  
  return upc;
}

export async function readAPGCSV() {
  // Try multiple possible locations for CSV file
  const possiblePaths = [
    path.join(process.cwd(), "tmp", "premier_data_feed_master.csv"),
    path.join(process.cwd(), "tmp", "apg", "premier_data_feed_master.csv"),
    path.join("/tmp", "apg", "premier_data_feed_master.csv"),
    path.join(process.env.TMPDIR || process.env.TMP || "/tmp", "apg", "premier_data_feed_master.csv"),
  ];

  let filePath = null;
  for (const possiblePath of possiblePaths) {
    if (fs.existsSync(possiblePath)) {
      filePath = possiblePath;
      break;
    }
  }

  // Also try to find any CSV file in tmp/apg directories
  if (!filePath) {
    const tmpDirs = [
      path.join(process.cwd(), "tmp", "apg"),
      path.join("/tmp", "apg"),
      path.join(process.env.TMPDIR || process.env.TMP || "/tmp", "apg"),
    ];
    
    for (const tmpDir of tmpDirs) {
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir);
        const csvFile = files.find(f => f.endsWith(".csv"));
        if (csvFile) {
          filePath = path.join(tmpDir, csvFile);
          break;
        }
      }
    }
  }

  if (!filePath) {
    throw new Error(`CSV file not found. Checked paths: ${possiblePaths.join(", ")}`);
  }

  const results = [];

  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        // Handle UPC - convert scientific notation (e.g., 8.34532E+11) to proper number
        const upc = normalizeUPC(row["Upc"] || row["UPC"] || row["upc"] || "");
        
        // Use "USA Item Availability" as primary inventory source
        const usaAvailability = Number(row["USA Item Availability"] || 0) || 0;
        
        // Also calculate from warehouse columns as backup
        const nvWhse = Number(row["NV whse"] || row["NV Whse"] || 0) || 0;
        const kyWhse = Number(row["KY whse"] || row["KY Whse"] || 0) || 0;
        const mfgInvt = Number(row["MFG Invt"] || row["MFG Invt"] || 0) || 0;
        const waWhse = Number(row["WA whse"] || row["WA Whse"] || 0) || 0;
        const warehouseTotal = nvWhse + kyWhse + mfgInvt + waWhse;
        
        // Prefer "USA Item Availability", fallback to warehouse total
        const totalInventory = usaAvailability > 0 ? usaAvailability : warehouseTotal;
        
        // Try multiple possible field names for MAP and Cost
        const mapPrice = row["MAP"] || row["Map"] || row["map"] || row["MAP Price"] || row["MAP Price (USD)"];
        const customerPrice = row["Customer Price"] || row["Customer Price (USD)"] || row["Cost"] || row["cost"] || row["COST"];
        
        // Preserve original row structure for compatibility
        const processedRow = {
          upc: upc,
          premierPartNumber: row["Premier Part Number"]?.trim() || row["Premier Part #"]?.trim(),
          priceMAP: mapPrice,
          inventory: totalInventory,
          // Keep original fields for sync function compatibility
          Upc: upc,
          "Premier Part Number": row["Premier Part Number"]?.trim() || row["Premier Part #"]?.trim(),
          MAP: mapPrice,
          "Customer Price": customerPrice,
          "Customer Price (USD)": customerPrice,
          Cost: customerPrice,
          cost: customerPrice,
          "Mfg Part Number": row["Mfg Part Number"] || row["Manufacturer Part Number"] || row["Mfg Part #"],
          "USA Item Availability": usaAvailability, // Use actual column value
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
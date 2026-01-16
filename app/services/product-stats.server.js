import { getAPGIndex } from "./apg-lookup.server";
import { forEachShopifyProduct, countShopifyCatalog } from "./shopify-products.server";

/**
 * Gets basic product statistics quickly (without APG matching)
 * This is fast and shows immediately on dashboard
 */
export async function getBasicProductStats(admin) {
  try {
    if (!admin || !admin.graphql) {
      throw new Error("Admin context is missing - cannot fetch product stats");
    }
    
    // Use countShopifyCatalog for fast counting
    const { totalProducts, totalVariants } = await countShopifyCatalog(admin);
    
    // Now stream quickly to get status breakdown
    let activeProducts = 0;
    let draftProducts = 0;
    let archivedProducts = 0;
    let productsWithInventory = 0;
    
    // Stream products to get status counts (fast, no APG matching)
    await forEachShopifyProduct(admin, (product) => {
      if (product.status === "ACTIVE") {
        activeProducts++;
      } else if (product.status === "DRAFT") {
        draftProducts++;
      } else if (product.status === "ARCHIVED") {
        archivedProducts++;
      }
      
      // Check if product has inventory tracking enabled
      const variants = product.variants?.nodes || [];
      for (const variant of variants) {
        if (variant.inventoryItem?.id) {
          productsWithInventory++;
          break; // Count product once if any variant has inventory
        }
      }
    });
    
    return {
      totalProducts,
      totalVariants,
      activeProducts,
      draftProducts,
      archivedProducts,
      productsWithInventory,
      productsWithInventoryCount: 0, // Will be filled later
      matchedWithAPG: 0, // Will be filled later by full stats
      unmatchedWithAPG: 0, // Will be filled later by full stats
      mapZeroProducts: 0, // Will be filled later by full stats
      inventoryStats: {
        withInventory: productsWithInventory,
        withoutInventory: totalProducts - productsWithInventory,
        totalQuantity: 0,
      },
    };
  } catch (error) {
    console.error("❌ Error fetching basic product stats:", error);
    throw error;
  }
}

/**
 * Gets comprehensive product statistics with APG matching
 * This is slower but provides full details
 */
export async function getProductStats(admin) {
  try {
    // Validate admin context
    if (!admin || !admin.graphql) {
      throw new Error("Admin context is missing - cannot fetch product stats");
    }
    
    // Get APG index for matching (cache this to speed up)
    const apgIndex = await getAPGIndex();
    
    // Use streaming approach instead of loading all products into memory
    let totalProducts = 0;
    let totalVariants = 0;
    let activeProducts = 0;
    let draftProducts = 0;
    let archivedProducts = 0;
    let productsWithInventory = 0;
    let productsWithInventoryCount = 0;
    let matchedWithAPG = 0;
    let unmatchedWithAPG = 0;
    let mapZeroProducts = 0;
    
    // Track inventory status
    const inventoryStats = {
      withInventory: 0,
      withoutInventory: 0,
      totalQuantity: 0,
    };
    
    // Stream products one by one to calculate stats
    await forEachShopifyProduct(admin, (product) => {
      totalProducts++;
      
      // Count product status
      if (product.status === "ACTIVE") {
        activeProducts++;
      } else if (product.status === "DRAFT") {
        draftProducts++;
      } else if (product.status === "ARCHIVED") {
        archivedProducts++;
      }
      
      // Count variants
      const variants = product.variants?.nodes || [];
      totalVariants += variants.length;
      
      // Check if product has inventory
      let productHasInventory = false;
      let productInventoryTotal = 0;
      
      for (const variant of variants) {
        // Check inventory - query inventory levels if available
        if (variant.inventoryItem?.id) {
          productHasInventory = true;
        }
        
        // Check if variant matches APG
        let matched = false;
        if (variant.barcode || variant.sku) {
          const barcodeStr = variant.barcode ? String(variant.barcode).trim() : "";
          const normalizedBarcode = barcodeStr.replace(/^0+/, "");
          const padded12 = normalizedBarcode.padStart(12, "0");
          const padded13 = normalizedBarcode.padStart(13, "0");
          const padded14 = normalizedBarcode.padStart(14, "0");
          
          const lookupKeys = [barcodeStr, normalizedBarcode, padded12, padded13, padded14];
          
          for (const key of lookupKeys) {
            if (key && apgIndex.has(key)) {
              matched = true;
              break;
            }
          }
          
          // Try SKU matching (same logic as sync.server.js for consistency)
          if (!matched && variant.sku) {
            const skuStr = String(variant.sku).trim();
            const skuParts = skuStr.split(/[-_]/); // Split on dash or underscore
            
            // Strategy 1: Try full SKU match first (case-insensitive)
            matched = apgIndex.has(skuStr) || apgIndex.has(skuStr.toUpperCase());
            
            // Strategy 2: Try matching by part number substring
            // Example: SKU "BHXS-ZT2-XTG6" contains "ZT2-XTG6" which should match "ACTZT2-XTG6"
            if (!matched && skuParts.length > 0) {
              // Try matching the last part(s) of SKU against Premier Part Number
              // For "BHXS-ZT2-XTG6", try "ZT2-XTG6", then "XTG6"
              for (let i = skuParts.length - 1; i >= 0 && i >= skuParts.length - 2; i--) {
                const partialSku = skuParts.slice(i).join("-");
                const partialUpper = partialSku.toUpperCase();
                // Try direct match in index (already indexed uppercase)
                if (apgIndex.has(partialUpper)) {
                  matched = true;
                  break;
                }
                
                // Try substring matching against part numbers
                for (const [key, item] of apgIndex.entries()) {
                  const partNum = String(item["Premier Part Number"] || "").trim().toUpperCase();
                  const mfgPartNum = String(item["Mfg Part Number"] || "").trim().toUpperCase();
                  // Check if part number contains the SKU fragment or vice versa
                  if ((partNum && (partNum.includes(partialUpper) || partialUpper.includes(partNum))) ||
                      (mfgPartNum && (mfgPartNum.includes(partialUpper) || partialUpper.includes(mfgPartNum)))) {
                    matched = true;
                    break;
                  }
                }
                if (matched) break;
              }
            }
            
            // Strategy 3: Try matching by extracting suffix (skip first prefix)
            // For "BHXS-ZT2-XTG6", extract "ZT2-XTG6" and try to match
            if (!matched && skuParts.length > 1) {
              const suffixParts = skuParts.slice(1); // Skip first prefix (e.g., "BHXS")
              const suffix = suffixParts.join("-");
              const suffixUpper = suffix.toUpperCase();
              // Try direct match
              if (apgIndex.has(suffixUpper)) {
                matched = true;
              } else {
                // Try substring matching
                for (const [key, item] of apgIndex.entries()) {
                  const partNum = String(item["Premier Part Number"] || "").trim().toUpperCase();
                  const mfgPartNum = String(item["Mfg Part Number"] || "").trim().toUpperCase();
                  if (partNum.includes(suffixUpper) || mfgPartNum.includes(suffixUpper) ||
                      suffixUpper.includes(partNum) || suffixUpper.includes(mfgPartNum)) {
                    matched = true;
                    break;
                  }
                }
              }
            }
          }
          
          // Check if MAP is 0 for matched products
          if (matched) {
            // Find the matched APG item using the same logic as finding the match
            let apgItem = null;
            const matchedKey = lookupKeys.find(k => k && apgIndex.has(k));
            if (matchedKey) {
              apgItem = apgIndex.get(matchedKey);
            } else if (variant.sku) {
              // Use same SKU matching logic to find the APG item
              const skuStr = String(variant.sku).trim();
              const skuParts = skuStr.split(/[-_]/);
              
              // Try full SKU match
              apgItem = apgIndex.get(skuStr) || apgIndex.get(skuStr.toUpperCase());
              
              // Try partial match
              if (!apgItem && skuParts.length > 0) {
                for (let i = skuParts.length - 1; i >= 0 && i >= skuParts.length - 2; i--) {
                  const partialSku = skuParts.slice(i).join("-");
                  const partialUpper = partialSku.toUpperCase();
                  if (apgIndex.has(partialUpper)) {
                    apgItem = apgIndex.get(partialUpper);
                    break;
                  }
                  // Try substring matching
                  for (const [key, item] of apgIndex.entries()) {
                    const partNum = String(item["Premier Part Number"] || "").trim().toUpperCase();
                    const mfgPartNum = String(item["Mfg Part Number"] || "").trim().toUpperCase();
                    if ((partNum && (partNum.includes(partialUpper) || partialUpper.includes(partNum))) ||
                        (mfgPartNum && (mfgPartNum.includes(partialUpper) || partialUpper.includes(mfgPartNum)))) {
                      apgItem = item;
                      break;
                    }
                  }
                  if (apgItem) break;
                }
              }
              
              // Try suffix match
              if (!apgItem && skuParts.length > 1) {
                const suffixParts = skuParts.slice(1);
                const suffix = suffixParts.join("-");
                const suffixUpper = suffix.toUpperCase();
                if (apgIndex.has(suffixUpper)) {
                  apgItem = apgIndex.get(suffixUpper);
                } else {
                  for (const [key, item] of apgIndex.entries()) {
                    const partNum = String(item["Premier Part Number"] || "").trim().toUpperCase();
                    const mfgPartNum = String(item["Mfg Part Number"] || "").trim().toUpperCase();
                    if (partNum.includes(suffixUpper) || mfgPartNum.includes(suffixUpper) ||
                        suffixUpper.includes(partNum) || suffixUpper.includes(mfgPartNum)) {
                      apgItem = item;
                      break;
                    }
                  }
                }
              }
            }
            
            if (apgItem) {
              const mapPriceStr = apgItem.MAP || apgItem.map || apgItem["MAP Price"] || "0";
              const mapPrice = parseFloat(String(mapPriceStr).replace(/[$,\s]/g, "").trim()) || 0;
              if (mapPrice === 0) {
                mapZeroProducts++;
              }
            }
          }
        }
        
        if (matched) {
          matchedWithAPG++;
        } else {
          unmatchedWithAPG++;
        }
      }
      
      if (productHasInventory) {
        productsWithInventory++;
        inventoryStats.withInventory++;
        productsWithInventoryCount += productInventoryTotal;
        inventoryStats.totalQuantity += productInventoryTotal;
      } else {
        inventoryStats.withoutInventory++;
      }
    });
    
    return {
      totalProducts,
      totalVariants,
      activeProducts,
      draftProducts,
      archivedProducts,
      productsWithInventory,
      productsWithInventoryCount,
      matchedWithAPG,
      unmatchedWithAPG,
      mapZeroProducts,
      inventoryStats: {
        withInventory: inventoryStats.withInventory,
        withoutInventory: inventoryStats.withoutInventory,
        totalQuantity: inventoryStats.totalInventoryQuantity,
      },
    };
  } catch (error) {
    console.error("❌ Error fetching product stats:", error);
    throw error;
  }
}

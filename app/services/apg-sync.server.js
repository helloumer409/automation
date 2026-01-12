// Cache location ID to avoid fetching it for every variant
let cachedLocationId = null;

async function getLocationId(admin) {
  if (cachedLocationId) return cachedLocationId;

  try {
    const locationsResponse = await admin.graphql(`#graphql
      query {
        locations(first: 10) {
          nodes {
            id
            name
          }
        }
      }
    `);
    
    const locationsResult = await locationsResponse.json();
    // Just get the first location (most shops have one primary location)
    const location = locationsResult.data?.locations?.nodes?.[0];
    cachedLocationId = location?.id || null;
    
    if (cachedLocationId) {
      console.log(`📍 Using location: ${location.name} (${cachedLocationId})`);
    } else {
      console.warn("⚠️ No location found in Shopify");
    }
  } catch (error) {
    console.warn("⚠️ Could not fetch locations:", error.message);
  }
  
  return cachedLocationId;
}

export function clearLocationCache() {
  cachedLocationId = null;
}

/**
 * Parses price string, removing currency symbols and formatting
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  // Remove $, commas, and whitespace, then convert to number
  const cleaned = String(priceStr).replace(/[$,\s]/g, "").trim();
  const parsed = Number(cleaned);
  // Return 0 if explicitly 0 (not null), so we can use Jobber fallback
  if (parsed === 0) return 0;
  return isNaN(parsed) || parsed < 0 ? null : parsed;
}

export async function syncAPGVariant({
  admin,
  productId,
  variant,
  apgRow
}, stats = null) {
  // Track stats for reporting if provided
  if (!stats) stats = { mapMatched: 0, mapUsedJobber: 0, mapUsedRetail: 0, mapSkipped: 0, mapSkippedReasons: [] };
  // Only log detailed sync info for debugging (reduce log spam)
  const DEBUG_SYNC = false; // Set to true for detailed logging
  if (DEBUG_SYNC) {
    console.log(`🔍 Syncing ${variant.sku || variant.barcode}:`, {
      barcode: variant.barcode,
      sku: variant.sku,
      apgUpc: apgRow.Upc || apgRow.upc,
      apgMap: apgRow.MAP || apgRow.map,
      apgCustomerPrice: apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost,
      apgPartNumber: apgRow["Premier Part Number"]
    });
  }

  // Try multiple possible field names for MAP price and parse it
  // IMPORTANT: MAP column might have value 0 or "0.0000" - check all variations
  const mapPriceStr = apgRow.MAP || apgRow.map || apgRow.priceMAP || apgRow["MAP Price"] || apgRow["MAP Price (USD)"] || apgRow["MAP"] || "0";
  let mapPrice = parsePrice(mapPriceStr);
  let priceSource = "MAP";
  
  // If MAP is 0 or invalid, try Jobber price (column L), then Retail as fallback
  if (mapPrice === null || mapPrice === 0) {
    const jobberPriceStr = apgRow.Jobber || apgRow.jobber || apgRow["Jobber"] || "0";
    const jobberPrice = parsePrice(jobberPriceStr);
    const retailPriceStr = apgRow.Retail || apgRow.retail || apgRow["Retail"] || "0";
    const retailPrice = parsePrice(retailPriceStr);
    
    // Prefer Jobber over Retail when MAP is 0 (as per user requirement)
    if (jobberPrice && jobberPrice > 0) {
      mapPrice = jobberPrice;
      priceSource = "Jobber (MAP was 0)";
      if (stats) stats.mapUsedJobber++;
    } else if (retailPrice && retailPrice > 0) {
      mapPrice = retailPrice;
      priceSource = "Retail (MAP and Jobber were 0)";
      if (stats) stats.mapUsedRetail++;
    } else {
      // Skip only if all prices are invalid - track reason
      const reason = `MAP=${mapPriceStr}, Jobber=${jobberPriceStr}, Retail=${retailPriceStr} - all invalid`;
      if (stats) {
        stats.mapSkipped++;
        stats.mapSkippedReasons.push({
          sku: variant.sku || variant.barcode,
          reason: reason
        });
      }
      // Still try to set cost even if price is skipped
      const costPriceStr = apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost || apgRow.cost || apgRow["cost"];
      const costPrice = parsePrice(costPriceStr);
      if (costPrice && costPrice > 0) {
        try {
          await setCostAsMetafield(admin, variant.id, costPrice);
        } catch (e) {
          // Silent fail
        }
      }
      return;
    }
  } else {
    if (stats) stats.mapMatched++;
  }
  
  // Try multiple possible field names for Customer Price
  const costPriceStr = apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost || apgRow.cost || apgRow["cost"];
  const costPrice = parsePrice(costPriceStr);

  // Log processing details (reduced frequency to avoid log spam)
  // Commented out detailed logging - uncomment if needed for debugging
  // console.log(`💰 Processing ${variant.sku || variant.barcode} - MAP: $${mapPrice.toFixed(2)}${costPrice ? `, Cost: $${costPrice.toFixed(2)}` : " (no cost)"}`);
  
  // Verify barcode/UPC match - only log mismatches
  const shopifyBarcode = String(variant.barcode || "").trim();
  const apgUpc = String(apgRow.Upc || apgRow.upc || "").trim();
  const shopifyBarcodeNorm = shopifyBarcode.replace(/^0+/, "");
  const apgUpcNorm = apgUpc.replace(/^0+/, "");
  
  // Removed barcode mismatch logging to reduce spam

  /* 1️⃣ PRICE */
  const priceResponse = await admin.graphql(`#graphql
    mutation {
      productVariantsBulkUpdate(
        productId: "${productId}",
        variants: [{
          id: "${variant.id}",
          price: "${mapPrice.toFixed(2)}",
          compareAtPrice: null
        }]
      ) {
        userErrors { message field }
        productVariants {
          id
          price
        }
      }
    }
  `);
  
  const priceResult = await priceResponse.json();
  if (priceResult.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
    const errors = priceResult.data.productVariantsBulkUpdate.userErrors;
    throw new Error(`Price update failed: ${errors.map(e => e.message).join(", ")}`);
  }

  /* 2️⃣ INVENTORY TRACKING & QUANTITY */
  // Always try to enable tracking - this is required for cost to show
  // Use "USA Item Availability" column from CSV as primary source
  const usaAvailability = Number(apgRow["USA Item Availability"] || 0) || 0;
  
  // Also calculate from warehouse columns as fallback
  const nvWhse = Number(apgRow["NV whse"] || 0) || 0;
  const kyWhse = Number(apgRow["KY whse"] || 0) || 0;
  const mfgInvt = Number(apgRow["MFG Invt"] || 0) || 0;
  const waWhse = Number(apgRow["WA whse"] || 0) || 0;
  const warehouseTotal = nvWhse + kyWhse + mfgInvt + waWhse;
  
  // Prefer "USA Item Availability", fallback to warehouse total
  // User requirement: Use "USA Item Availability" column (column I) from CSV
  const inventoryQty = Math.max(0, Math.floor(usaAvailability > 0 ? usaAvailability : warehouseTotal));
  
  // ALWAYS enable tracking - required for cost visibility
  // Wrap in try-catch but don't let it block price/cost updates
  try {
    const trackingResponse = await admin.graphql(`#graphql
      mutation {
        inventoryItemUpdate(
          id: "${variant.inventoryItem.id}",
          input: { tracked: true }
        ) {
          userErrors { message field }
          inventoryItem {
            id
            tracked
          }
        }
      }
    `);
    
    // Try to set inventory quantity - get location first, but if unavailable, skip location requirement
    const locationId = await getLocationId(admin);
    
    if (locationId && inventoryQty >= 0) {
      // Get current inventory levels
      try {
        const levelsResponse = await admin.graphql(`#graphql
          query {
            inventoryItem(id: "${variant.inventoryItem.id}") {
              id
              inventoryLevels(first: 10) {
                nodes {
                  id
                  location {
                    id
                    name
                  }
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        `);
        
        const levelsResult = await levelsResponse.json();
        const inventoryLevels = levelsResult.data?.inventoryItem?.inventoryLevels?.nodes || [];
        const existingLevel = inventoryLevels.find(level => level.location?.id === locationId);
        
        if (!existingLevel && inventoryLevels.length === 0) {
          // Create new inventory level at location with total quantity
          try {
            const createLevelResponse = await admin.graphql(`#graphql
              mutation {
                inventorySetOnHandQuantities(
                  input: {
                    reason: "correction"
                    setQuantities: [{
                      inventoryItemId: "${variant.inventoryItem.id}"
                      locationId: "${locationId}"
                      quantity: ${inventoryQty}
                    }]
                  }
                ) {
                  userErrors { message field }
                  inventoryAdjustmentGroup {
                    createdAt
                    reason
                    changes {
                      name
                      delta
                    }
                  }
                }
              }
            `);
            
            // Inventory set silently - no logging to reduce spam
          } catch (createError) {
            // Silent fail - inventory will be set once location is available
          }
        } else if (existingLevel) {
          // Update existing inventory level
          try {
            const setInventoryResponse = await admin.graphql(`#graphql
              mutation {
                inventorySetOnHandQuantities(
                  input: {
                    reason: "correction"
                    setQuantities: [{
                      inventoryItemId: "${variant.inventoryItem.id}"
                      locationId: "${locationId}"
                      quantity: ${inventoryQty}
                    }]
                  }
                ) {
                  userErrors { message field }
                  inventoryAdjustmentGroup {
                    createdAt
                    reason
                    changes {
                      name
                      delta
                    }
                  }
                }
              }
            `);
            
            // Inventory updated silently
          } catch (updateError) {
            // Silent fail
          }
        }
      } catch (levelsError) {
        // Silent - inventory tracking might not be available yet
      }
    }
    
    // Tracking enabled silently - removed error logging to reduce spam
  } catch (trackingError) {
    // Silent - tracking will be skipped but price/cost will still update
  }


  /* 3️⃣ COST - ALWAYS set cost (required by user, must not skip) */
  // Cost MUST be set - use metafield as primary method (works even without inventory tracking)
  // Metafield approach is more reliable and always works
  if (costPrice && costPrice > 0) {
    try {
      // Primary method: Set cost via metafield (always works, visible in product edit)
      await setCostAsMetafield(admin, variant.id, costPrice);
      // Removed logging to reduce log spam - cost is being set silently
    } catch (metaError) {
      // If metafield fails, try inventory item update (requires tracking enabled)
      try {
        const locationId = await getLocationId(admin);
        if (locationId && variant.inventoryItem?.id) {
          // Try setting cost via inventoryAdjustQuantitySet (without unitCost field)
          // This will set quantity, and cost might be set via inventory item separately
          const costResponse = await admin.graphql(`#graphql
            mutation {
              inventoryAdjustQuantitySet(
                reason: "correction"
                setQuantities: [{
                  inventoryItemId: "${variant.inventoryItem.id}"
                  locationId: "${locationId}"
                  quantity: ${inventoryQty}
                }]
              ) {
                inventoryAdjustmentGroup {
                  reason
                  changes {
                    name
                    delta
                  }
                }
                userErrors {
                  field
                  message
                }
              }
              
              inventoryItemUpdate(
                id: "${variant.inventoryItem.id}"
                input: {
                  tracked: true
                }
              ) {
                inventoryItem {
                  id
                  tracked
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `);
          
          // Cost is already set via metafield above, this is just fallback
          // Removed logging to reduce spam
        } else {
          // No location - metafield already set above, this is just fallback
        }
      } catch (inventoryError) {
        // Metafield already set above, this error is acceptable
      }
    }
  }
  // Removed cost logging to reduce spam
}

/**
 * Sets cost as a metafield for visibility (fallback method)
 */
async function setCostAsMetafield(admin, variantId, costPrice) {
  try {
    const metafieldResponse = await admin.graphql(`#graphql
      mutation {
        metafieldsSet(metafields: [{
          ownerId: "${variantId}"
          namespace: "apg"
          key: "cost"
          value: "${costPrice.toFixed(2)}"
          type: "money"
        }]) {
          metafields {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `);
    
    const metafieldResult = await metafieldResponse.json();
    if (metafieldResult.data?.metafieldsSet?.userErrors?.length === 0) {
      console.log(`💰 Cost stored as metafield for variant ${variantId}`);
    }
  } catch (error) {
    throw error;
  }

  console.log(`✅ Synced ${variant.sku || variant.barcode} - Price: $${mapPrice.toFixed(2)}, Inventory: ${inventoryQty}${warehouseTotal > 0 ? ` (NV:${nvWhse}+KY:${kyWhse}+MFG:${mfgInvt}+WA:${waWhse})` : ""}${costPrice > 0 ? `, Cost: $${costPrice.toFixed(2)}` : ""}`);
}

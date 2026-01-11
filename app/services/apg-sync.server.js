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
  return isNaN(parsed) || parsed <= 0 ? null : parsed;
}

export async function syncAPGVariant({
  admin,
  productId,
  variant,
  apgRow
}) {
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
  const mapPriceStr = apgRow.MAP || apgRow.map || apgRow.priceMAP || apgRow["MAP Price"] || apgRow["MAP Price (USD)"];
  const mapPrice = parsePrice(mapPriceStr);
  
  // Try multiple possible field names for Customer Price
  const costPriceStr = apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost || apgRow.cost || apgRow["cost"];
  const costPrice = parsePrice(costPriceStr);

  if (!mapPrice) {
    console.log(`⏭ MAP invalid for ${variant.sku || variant.barcode}, skipping. MAP value: "${mapPriceStr}"`);
    return;
  }

  // Log processing details (reduced frequency to avoid log spam)
  // Commented out detailed logging - uncomment if needed for debugging
  // console.log(`💰 Processing ${variant.sku || variant.barcode} - MAP: $${mapPrice.toFixed(2)}${costPrice ? `, Cost: $${costPrice.toFixed(2)}` : " (no cost)"}`);
  
  // Verify barcode/UPC match - only log mismatches
  const shopifyBarcode = String(variant.barcode || "").trim();
  const apgUpc = String(apgRow.Upc || apgRow.upc || "").trim();
  const shopifyBarcodeNorm = shopifyBarcode.replace(/^0+/, "");
  const apgUpcNorm = apgUpc.replace(/^0+/, "");
  
  if (shopifyBarcode && apgUpc && shopifyBarcodeNorm !== apgUpcNorm) {
    console.warn(`⚠️ Barcode mismatch - Shopify: "${shopifyBarcode}" vs APG: "${apgUpc}"`);
  }

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
    
    const trackingResult = await trackingResponse.json();
    if (trackingResult.data?.inventoryItemUpdate?.userErrors?.length > 0) {
      const errors = trackingResult.data.inventoryItemUpdate.userErrors;
      // If it's a scope error, warn but continue
      const isScopeError = errors.some(e => e.message.includes("access") || e.message.includes("scope") || e.message.includes("permission"));
      if (isScopeError) {
        console.warn(`⚠️ Inventory tracking skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}. Price updated successfully.`);
      } else {
        console.warn(`⚠️ Inventory tracking warning for ${variant.sku || variant.barcode}: ${errors.map(e => e.message).join(", ")}`);
      }
    } else if (trackingResult.data?.inventoryItemUpdate?.inventoryItem?.tracked) {
      console.log(`✓ Tracking enabled for ${variant.sku || variant.barcode}`);
    }
  } catch (trackingError) {
    // Catch GraphQL errors - the client throws when there are GraphQL errors
    const errorMessage = trackingError.message || String(trackingError);
    const isScopeError = errorMessage.includes("access") || errorMessage.includes("scope") || errorMessage.includes("permission") || errorMessage.includes("write_inventory");
    if (isScopeError) {
      console.warn(`⚠️ Inventory tracking skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}. Price updated successfully. Reinstall app to grant inventory permissions.`);
    } else {
      console.warn(`⚠️ Could not enable tracking for ${variant.sku || variant.barcode}: ${errorMessage}. Continuing with price update...`);
    }
  }

  // Get location ID for inventory level (cached)
  const locationId = await getLocationId(admin);
  
  if (!locationId) {
    console.warn(`⚠️ No location found - cannot set inventory for ${variant.sku || variant.barcode}. Price updated successfully.`);
  } else {
    // Wrap inventory operations in try-catch to not fail entire sync if inventory scope is missing
    try {
    // Get current inventory levels
    const inventoryLevelsResponse = await admin.graphql(`#graphql
      query {
        inventoryItem(id: "${variant.inventoryItem.id}") {
          id
          inventoryLevels(first: 10) {
            nodes {
              id
              location {
                id
              }
              available
            }
          }
        }
      }
    `);
    
    const inventoryLevelsResult = await inventoryLevelsResponse.json();
    let inventoryLevelId = inventoryLevelsResult.data?.inventoryItem?.inventoryLevels?.nodes?.find(
      level => level.location.id === locationId
    )?.id;
    
      // Create inventory level if it doesn't exist
      if (!inventoryLevelId) {
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
          
          const createLevelResult = await createLevelResponse.json();
          if (createLevelResult.data?.inventorySetOnHandQuantities?.userErrors?.length > 0) {
            const errors = createLevelResult.data.inventorySetOnHandQuantities.userErrors;
            console.warn(`⚠️ Inventory level creation warning: ${errors.map(e => e.message).join(", ")}`);
          } else {
            console.log(`📦 Inventory set to ${inventoryQty} for ${variant.sku || variant.barcode}`);
          }
        } catch (createError) {
          const errorMsg = createError.message || String(createError);
          const isScopeError = errorMsg.includes("access") || errorMsg.includes("scope") || errorMsg.includes("permission") || errorMsg.includes("write_inventory");
          if (isScopeError) {
            console.warn(`⚠️ Inventory creation skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
          } else {
            console.warn(`⚠️ Inventory creation failed: ${errorMsg}`);
          }
        }
      } else {
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
          
          const setInventoryResult = await setInventoryResponse.json();
          if (setInventoryResult.data?.inventorySetOnHandQuantities?.userErrors?.length > 0) {
            const errors = setInventoryResult.data.inventorySetOnHandQuantities.userErrors;
            console.warn(`⚠️ Inventory quantity update warning: ${errors.map(e => e.message).join(", ")}`);
          } else {
            console.log(`📦 Inventory updated to ${inventoryQty} for ${variant.sku || variant.barcode}`);
          }
        } catch (updateError) {
          const errorMsg = updateError.message || String(updateError);
          const isScopeError = errorMsg.includes("access") || errorMsg.includes("scope") || errorMsg.includes("permission") || errorMsg.includes("write_inventory");
          if (isScopeError) {
            console.warn(`⚠️ Inventory update skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
          } else {
            console.warn(`⚠️ Inventory update failed: ${errorMsg}`);
          }
        }
      }
    } catch (inventoryError) {
      // If inventory update fails (e.g., scope error), continue with cost update
      const errorMsg = inventoryError.message || String(inventoryError);
      const isScopeError = errorMsg.includes("access") || errorMsg.includes("scope") || errorMsg.includes("permission") || errorMsg.includes("write_inventory");
      if (isScopeError) {
        console.warn(`⚠️ Inventory update skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
      } else {
        console.warn(`⚠️ Inventory update failed for ${variant.sku || variant.barcode}: ${errorMsg}`);
      }
    }
  }

  /* 3️⃣ COST - Set cost (visible in product edit page when tracking is enabled) */
  // Cost MUST be set after tracking is enabled
  if (costPrice && costPrice > 0) {
    try {
      // Get location ID first (needed for cost setting)
      const locationId = await getLocationId(admin);
      
      if (locationId) {
        // Use inventoryAdjustQuantitySet to set both quantity and cost together
        // This is the most reliable way to set cost in Shopify
        const costResponse = await admin.graphql(`#graphql
          mutation {
            inventoryAdjustQuantitySet(
              reason: "correction"
              setQuantities: [{
                inventoryItemId: "${variant.inventoryItem.id}"
                locationId: "${locationId}"
                quantity: ${inventoryQty}
                unitCost: "${costPrice.toFixed(2)}"
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
          }
        `);
        
        const costResult = await costResponse.json();
        if (costResult.data?.inventoryAdjustQuantitySet?.userErrors?.length > 0) {
          const errors = costResult.data.inventoryAdjustQuantitySet.userErrors;
          const isScopeError = errors.some(e => e.message.includes("access") || e.message.includes("scope") || e.message.includes("permission"));
          if (isScopeError) {
            console.warn(`⚠️ Cost update skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
          } else {
            console.warn(`⚠️ Cost update warning: ${errors.map(e => e.message).join(", ")}`);
            // Try metafield as fallback for visibility
            try {
              await setCostAsMetafield(admin, variant.id, costPrice);
            } catch (metaError) {
              // Silently fail - cost will show once scope is granted
            }
          }
        } else {
          console.log(`💰 Cost set to $${costPrice.toFixed(2)} for ${variant.sku || variant.barcode} (visible in product edit page)`);
        }
      } else {
        // No location - try metafield only
        try {
          await setCostAsMetafield(admin, variant.id, costPrice);
        } catch (metaError) {
          console.warn(`⚠️ Cost update skipped (no location found) for ${variant.sku || variant.barcode}`);
        }
      }
    } catch (costError) {
      const errorMsg = costError.message || String(costError);
      const isScopeError = errorMsg.includes("access") || errorMsg.includes("scope") || errorMsg.includes("permission") || errorMsg.includes("write_inventory");
      if (isScopeError) {
        console.warn(`⚠️ Cost update skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
      } else {
        // Try metafield as last resort
        try {
          await setCostAsMetafield(admin, variant.id, costPrice);
        } catch (metaError) {
          console.warn(`⚠️ Cost update failed: ${errorMsg}`);
        }
      }
    }
  } else {
    console.log(`⚠️ No valid cost price found for ${variant.sku || variant.barcode}. Cost fields checked:`, {
      "Customer Price": apgRow["Customer Price"],
      "Customer Price (USD)": apgRow["Customer Price (USD)"],
      "Cost": apgRow.Cost,
      "cost": apgRow.cost
    });
  }
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

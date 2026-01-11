/**
 * APG Order Fulfillment Service
 * Handles order placement with APG API using Premier API v5 format
 * Documentation: https://developer.premierwd.com/
 */

const APG_API_BASE_URL = process.env.APG_API_BASE_URL || "https://api.premierwd.com/api/v5";
const APG_API_KEY = process.env.APG_API_KEY || "3720887b-7625-43ec-a57e-62ddbf3edf64";

let sessionToken = null;
let tokenTime = null;
const TOKEN_TTL = 1000 * 60 * 50; // 50 minutes

async function authenticateAPG() {
  if (sessionToken && tokenTime && (Date.now() - tokenTime) < TOKEN_TTL) {
    return sessionToken;
  }

  const url = `${APG_API_BASE_URL}/authenticate?apiKey=${APG_API_KEY}`;
  console.log("🔐 Authenticating with APG for order placement...");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("❌ APG authentication failed for orders");
  }

  const json = await res.json();
  sessionToken = json.sessionToken;
  tokenTime = Date.now();

  console.log("✅ APG authenticated successfully for orders");
  return sessionToken;
}

/**
 * Fulfills an order via APG API
 * @param {Array} lineItems - Array of order line items with SKU/barcode, quantity, etc.
 * @param {Object} orderInfo - Order information (shipping address, etc.)
 * @returns {Promise<Object>} Order confirmation from APG
 */
export async function fulfillOrderViaAPG(lineItems, orderInfo) {
  try {
    console.log(`📤 Preparing to send order #${orderInfo.order_number || orderInfo.id} to APG...`);

    // Authenticate first
    const token = await authenticateAPG();

    // Prepare order payload according to Premier API v5 sales-orders format
    // Based on: https://developer.premierwd.com/
    const shippingAddr = orderInfo.shipping_address || orderInfo.shippingAddress || {};
    const billingAddr = orderInfo.billing_address || orderInfo.billingAddress || {};

    const orderPayload = {
      customerPurchaseOrderNumber: `SHOPIFY-${orderInfo.order_number || orderInfo.id}`,
      note: `Order from Shopify Store - Order #${orderInfo.order_number || orderInfo.id}`,
      shipToAddress: {
        name: shippingAddr.name || billingAddr.name || orderInfo.customer?.name || "",
        addressLine1: shippingAddr.address1 || shippingAddr.address_line1 || "",
        addressLine2: shippingAddr.address2 || shippingAddr.address_line2 || "",
        city: shippingAddr.city || "",
        regionCode: shippingAddr.province_code || shippingAddr.province || shippingAddr.state_code || "",
        postalCode: shippingAddr.zip || shippingAddr.postal_code || "",
        countryCode: (shippingAddr.country_code || shippingAddr.country || "US").substring(0, 2).toUpperCase(),
        phone: shippingAddr.phone || billingAddr.phone || orderInfo.phone || ""
      },
      salesOrderLines: lineItems.map(item => ({
        itemNumber: item.sku || item.barcode || item.itemNumber,
        quantity: Number(item.quantity) || 1
      }))
    };

    // Use the correct Premier API v5 endpoint
    const endpoint = `${APG_API_BASE_URL}/sales-orders`;
    console.log(`📡 Sending order to APG API: ${endpoint}`);
    console.log(`📦 Order payload:`, JSON.stringify(orderPayload, null, 2));

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderPayload),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`✅ Order #${orderInfo.order_number || orderInfo.id} successfully placed with APG!`);
      console.log(`📋 APG Sales Order Number: ${result.salesOrderNumber || result.customerPurchaseOrderNumber || "N/A"}`);
      return {
        success: true,
        apgOrderNumber: result.salesOrderNumber || result.customerPurchaseOrderNumber,
        shopifyOrderNumber: orderInfo.order_number || orderInfo.id,
        response: result
      };
    } else {
      const errorText = await response.text();
      console.error(`❌ APG API returned status ${response.status}:`, errorText);
      throw new Error(`APG API error: Status ${response.status} - ${errorText}`);
    }
  } catch (error) {
    console.error(`❌ Error fulfilling order #${orderInfo.order_number || orderInfo.id} via APG:`, error);
    throw error;
  }
}

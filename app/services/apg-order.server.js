/**
 * APG Order Fulfillment Service
 * Handles order placement with APG API
 */

const APG_API_BASE_URL = process.env.APG_API_BASE_URL || "https://api.premierwd.com/api/v1";
const APG_API_KEY = process.env.APG_API_KEY || "3720887b-7625-43ec-a57e-62ddbf3edf64";

/**
 * Fulfills an order via APG API
 * @param {Array} lineItems - Array of order line items with SKU, quantity, etc.
 * @param {Object} orderInfo - Order information (shipping address, etc.)
 * @returns {Promise<Object>} Order confirmation from APG
 */
export async function fulfillOrderViaAPG(lineItems, orderInfo) {
  try {
    console.log("📤 Sending order to APG API...");

    // Prepare order payload for APG API
    // Note: This structure may need to be adjusted based on actual APG API documentation
    const orderPayload = {
      items: lineItems.map(item => ({
        partNumber: item.sku || item.barcode,
        quantity: item.quantity,
        // Add other required fields based on APG API docs
      })),
      shippingAddress: {
        name: orderInfo.shipping_address?.name || orderInfo.billing_address?.name,
        address1: orderInfo.shipping_address?.address1,
        address2: orderInfo.shipping_address?.address2,
        city: orderInfo.shipping_address?.city,
        province: orderInfo.shipping_address?.province,
        zip: orderInfo.shipping_address?.zip,
        country: orderInfo.shipping_address?.country_code || orderInfo.shipping_address?.country,
        phone: orderInfo.shipping_address?.phone,
      },
      billingAddress: {
        name: orderInfo.billing_address?.name,
        address1: orderInfo.billing_address?.address1,
        address2: orderInfo.billing_address?.address2,
        city: orderInfo.billing_address?.city,
        province: orderInfo.billing_address?.province,
        zip: orderInfo.billing_address?.zip,
        country: orderInfo.billing_address?.country_code || orderInfo.billing_address?.country,
        phone: orderInfo.billing_address?.phone,
      },
      orderNumber: orderInfo.order_number || orderInfo.id,
      customerEmail: orderInfo.email,
      customerPhone: orderInfo.phone,
      // Add other fields as required by APG API
    };

    // Try common order endpoints
    const endpoints = [
      "/orders",
      "/orders/create",
      "/order",
      "/order/create",
    ];

    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        const url = `${APG_API_BASE_URL}${endpoint}`;
        console.log(`📡 Trying order endpoint: ${url}`);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${APG_API_KEY}`,
            "X-API-Key": APG_API_KEY,
            "Accept": "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(orderPayload),
        });

        if (response.ok) {
          const result = await response.json();
          console.log(`✅ Order placed successfully via ${endpoint}`);
          return result;
        } else {
          const errorText = await response.text();
          console.warn(`⚠️ Endpoint ${endpoint} returned status ${response.status}: ${errorText}`);
          lastError = `Status ${response.status}: ${errorText}`;
        }
      } catch (error) {
        console.warn(`⚠️ Error trying ${endpoint}:`, error.message);
        lastError = error.message;
        continue;
      }
    }

    throw new Error(`Order API call failed. Last error: ${lastError || "No successful endpoint found"}`);
  } catch (error) {
    console.error("❌ Error fulfilling order via APG:", error);
    throw error;
  }
}

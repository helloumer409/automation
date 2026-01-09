/**
 * Webhook handler for order creation
 * Automatically fulfills orders via APG API
 */
import { authenticate } from "../shopify.server.js";
import { fulfillOrderViaAPG } from "../services/apg-order.server";

export async function action({ request }) {
  const { payload, topic, shop, admin } = await authenticate.webhook(request);

  console.log(`📦 Received ${topic} webhook for ${shop}`);

  try {
    // Only process paid orders
    if (payload.financial_status !== "paid" && payload.financial_status !== "pending") {
      console.log(`⏭ Skipping order ${payload.order_number} - financial status: ${payload.financial_status}`);
      return new Response("OK", { status: 200 });
    }

    // Get order details
    const order = payload;
    const lineItems = order.line_items || [];

    console.log(`🛒 Processing order #${order.order_number || order.id} with ${lineItems.length} items`);

    // Fetch variant details to get SKU/barcode for APG API
    const orderItems = [];
    for (const item of lineItems) {
      if (item.variant_id) {
        try {
          // Fetch variant details from Shopify
          const variantResponse = await admin.graphql(`#graphql
            query {
              productVariant(id: "${item.variant_id}") {
                id
                sku
                barcode
                title
              }
            }
          `);
          
          const variantResult = await variantResponse.json();
          const variant = variantResult.data?.productVariant;
          
          orderItems.push({
            sku: variant?.sku || item.sku,
            barcode: variant?.barcode,
            quantity: item.quantity,
            title: item.title || variant?.title,
          });
        } catch (error) {
          console.warn(`⚠️ Could not fetch variant ${item.variant_id}:`, error.message);
          // Fallback to item data
          orderItems.push({
            sku: item.sku,
            quantity: item.quantity,
            title: item.title,
          });
        }
      } else {
        orderItems.push({
          sku: item.sku,
          quantity: item.quantity,
          title: item.title,
        });
      }
    }

    console.log("📋 Order items prepared:", JSON.stringify(orderItems, null, 2));

    // Call APG API to place order
    try {
      const result = await fulfillOrderViaAPG(orderItems, order);
      console.log(`✅ Order #${order.order_number || order.id} fulfilled via APG:`, result);
    } catch (error) {
      console.error(`❌ Failed to fulfill order #${order.order_number || order.id} via APG:`, error.message);
      // Don't fail the webhook - log error but return OK
      // You might want to implement retry logic or notification here
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("❌ Error processing order webhook:", error);
    // Return OK to prevent webhook retries for unexpected errors
    // Log the error for manual investigation
    return new Response("OK", { status: 200 });
  }
}

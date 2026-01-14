/**
 * Webhook handler for order creation
 * DISABLED: Order fulfillment is now MANUAL via button click in order dashboard
 * This webhook just logs orders but does not auto-fulfill
 * 
 * Users must click "Send Order to APG" button in order details page to fulfill orders
 */
import { authenticate } from "../shopify.server.js";

export async function action({ request }) {
  const { payload, topic, shop, admin } = await authenticate.webhook(request);

  console.log(`📦 Received ${topic} webhook for ${shop} - Order #${payload.order_number || payload.id}`);
  console.log(`ℹ️  Automatic order fulfillment is DISABLED. Use manual "Send to APG" button in order details page.`);

  // Just acknowledge the webhook - don't auto-fulfill
  // Orders must be manually sent to APG via button click
  return new Response("OK", { status: 200 });
  
  /* DISABLED AUTO-FULFILLMENT CODE - User wants manual button click only
  try {
    // Only process paid orders
    if (payload.financial_status !== "paid" && payload.financial_status !== "pending") {
      console.log(`⏭ Skipping order ${payload.order_number} - financial status: ${payload.financial_status}`);
      return new Response("OK", { status: 200 });
    }

    // Get order details
    const order = payload;
    const lineItems = order.line_items || [];

    console.log(`🛒 Auto-fulfilling order #${order.order_number || order.id} with ${lineItems.length} items`);

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

    // Call APG API to place order
    const result = await fulfillOrderViaAPG(orderItems, order);
    console.log(`✅ Order #${order.order_number || order.id} auto-fulfilled via APG:`, result);
    
    // Store APG order info in order metafields for tracking
    if (admin && order.id) {
      try {
        await admin.graphql(`#graphql
          mutation {
            orderUpdate(
              id: "${order.id}",
              input: {
                note: "APG Order Number: ${result.apgOrderNumber || 'Pending'}"
                customAttributes: [
                  {key: "apg_order_number", value: "${result.apgOrderNumber || 'Pending'}"}
                  {key: "apg_order_status", value: "submitted"}
                  {key: "apg_order_date", value: "${new Date().toISOString()}"}
                ]
              }
            ) {
              order {
                id
                note
                customAttributes {
                  key
                  value
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `);
      } catch (metaError) {
        console.warn(`⚠️ Could not update order metafields:`, metaError.message);
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error(`❌ Failed to auto-fulfill order #${payload.order_number || payload.id} via APG:`, error.message);
    
    // Store error status in metafields
    if (admin && payload.id) {
      try {
        await admin.graphql(`#graphql
          mutation {
            orderUpdate(
              id: "${payload.id}",
              input: {
                customAttributes: [
                  {key: "apg_order_status", value: "failed"}
                  {key: "apg_order_error", value: "${String(error.message).substring(0, 100)}"}
                ]
              }
            ) {
              order {
                id
                customAttributes {
                  key
                  value
                }
              }
            }
          }
        `);
      } catch (metaError) {
        // Ignore metafield update errors
      }
    }
    
    // Return OK to prevent webhook retries for unexpected errors
    return new Response("OK", { status: 200 });
  }
}

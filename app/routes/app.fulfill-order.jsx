/**
 * Manual Order Fulfillment Route
 * Allows manual sending of orders to APG API via button click
 * Accessible from order details page or order dashboard
 */
import { authenticate } from "../shopify.server";
import { fulfillOrderViaAPG } from "../services/apg-order.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const orderId = formData.get("orderId");

    if (!orderId) {
      return {
        success: false,
        error: "Order ID is required",
      };
    }

    console.log(`📤 Manual order fulfillment requested for order: ${orderId}`);

    // Fetch order details from Shopify
    const orderResponse = await admin.graphql(`#graphql
      query {
        order(id: "${orderId}") {
          id
          name
          orderNumber
          email
          phone
          financialStatus
          fulfillmentStatus
          shippingAddress {
            name
            address1
            address2
            city
            provinceCode
            zip
            countryCode
            phone
          }
          billingAddress {
            name
            address1
            address2
            city
            provinceCode
            zip
            countryCode
            phone
          }
          lineItems(first: 250) {
            nodes {
              id
              title
              quantity
              variant {
                id
                sku
                barcode
              }
            }
          }
        }
      }
    `);

    const orderResult = await orderResponse.json();

    if (orderResult.errors) {
      return {
        success: false,
        error: orderResult.errors.map(e => e.message).join(", "),
      };
    }

    const order = orderResult.data?.order;

    if (!order) {
      return {
        success: false,
        error: "Order not found",
      };
    }

    // Check if order is already fulfilled to APG
    const existingApgNumber = order.customAttributes?.find(attr => attr.key === "apg_order_number");
    if (existingApgNumber && existingApgNumber.value !== "Pending") {
      return {
        success: false,
        error: `Order already sent to APG. APG Order Number: ${existingApgNumber.value}`,
      };
    }

    // Prepare order items
    const orderItems = order.lineItems.nodes.map(item => ({
      sku: item.variant?.sku || "",
      barcode: item.variant?.barcode || "",
      quantity: item.quantity,
      title: item.title,
    }));

    console.log(`📋 Preparing to send order #${order.orderNumber} with ${orderItems.length} items to APG...`);

    // Send to APG
    const result = await fulfillOrderViaAPG(orderItems, {
      order_number: order.orderNumber,
      id: order.id,
      email: order.email,
      phone: order.phone,
      shipping_address: order.shippingAddress,
      billing_address: order.billingAddress,
    });

    // Update order with APG info
    if (result.apgOrderNumber) {
      await admin.graphql(`#graphql
        mutation {
          orderUpdate(
            id: "${order.id}",
            input: {
              note: "APG Order Number: ${result.apgOrderNumber}"
              customAttributes: [
                {key: "apg_order_number", value: "${result.apgOrderNumber}"}
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
    }

    return {
      success: true,
      apgOrderNumber: result.apgOrderNumber,
      message: `Order #${order.orderNumber} successfully sent to APG. Order Number: ${result.apgOrderNumber}`,
    };
  } catch (error) {
    console.error("❌ Manual order fulfillment error:", error);
    return {
      success: false,
      error: error.message || "Failed to fulfill order",
    };
  }
}
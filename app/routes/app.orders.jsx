import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getRecentOrders } from "../services/shopify-orders.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Load a larger slice of recent orders for the dedicated Orders page
  const recentOrders = await getRecentOrders(admin, 50);

  return { recentOrders };
};

export default function OrdersPage() {
  const { recentOrders } = useLoaderData();
  const fulfillFetcher = useFetcher();

  return (
    <s-page heading="Orders → APG Fulfillment">
      <s-section heading="📃 Recent Shopify Orders">
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          {recentOrders && recentOrders.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "700px" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Order</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Customer</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Created</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Total</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Status</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>APG</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOrders.map((order) => {
                    const total = order.totalPriceSet?.shopMoney;
                    const created = order.createdAt
                      ? new Date(order.createdAt).toLocaleString()
                      : "";
                    const apgSent =
                      order.customAttributes?.some(
                        (attr) => attr.key === "apg_order_number" && attr.value && attr.value !== "Pending",
                      ) || false;

                    return (
                      <tr key={order.id}>
                        <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                          <strong>{order.name || `#${order.orderNumber}`}</strong>
                        </td>
                        <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                          {order.customer?.displayName || order.customer?.email || "Guest"}
                        </td>
                        <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>{created}</td>
                        <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                          {total ? `${Number(total.amount).toFixed(2)} ${total.currencyCode}` : "-"}
                        </td>
                        <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                          <div>
                            <div>{order.displayFinancialStatus || "-"}</div>
                            <div style={{ fontSize: "11px", color: "#637381" }}>
                              {order.displayFulfillmentStatus || ""}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                          {apgSent ? (
                            <s-text variant="bodySm" tone="success">
                              Already sent to APG
                            </s-text>
                          ) : (
                            <fulfillFetcher.Form method="post" action="/app/fulfill-order">
                              <input type="hidden" name="orderId" value={order.id} />
                              <s-button
                                size="slim"
                                variant="primary"
                                loading={fulfillFetcher.state === "submitting"}
                                disabled={fulfillFetcher.state === "submitting"}
                              >
                                {fulfillFetcher.state === "submitting" ? "Sending…" : "Send to APG"}
                              </s-button>
                            </fulfillFetcher.Form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {fulfillFetcher.data && (
                <s-text
                  variant="bodySm"
                  tone={fulfillFetcher.data.success ? "success" : "critical"}
                  style={{ marginTop: "0.75rem" }}
                >
                  {fulfillFetcher.data.message || fulfillFetcher.data.error}
                </s-text>
              )}
            </div>
          ) : (
            <s-text tone="subdued">
              No recent orders found or unable to load orders. Make sure the app has read_orders access.
            </s-text>
          )}
        </s-box>
      </s-section>
    </s-page>
  );
}


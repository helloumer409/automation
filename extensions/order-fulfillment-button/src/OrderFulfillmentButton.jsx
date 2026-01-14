import { useState } from "react";
import { useAppQuery, useAuthenticatedFetch } from "@shopify/app-bridge-react";
import {
  Button,
  Banner,
  Spinner,
  Text,
  BlockStack,
} from "@shopify/polaris";

export default function OrderFulfillmentButton({ orderId, orderNumber }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const fetch = useAuthenticatedFetch();

  const handleSendToAPG = async () => {
    if (!confirm(`Are you sure you want to send order #${orderNumber || orderId} to APG? This will submit the order for fulfillment with all order information.`)) {
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      // Use JSON body for better compatibility
      const response = await fetch("/app/fulfill-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderId: orderId,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setResult({
          type: "success",
          message: data.message || `Order #${orderNumber} successfully sent to APG!`,
        });
        // Refresh the page after 2 seconds to show updated order info
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        setResult({
          type: "error",
          message: data.error || "Failed to send order to APG",
        });
      }
    } catch (error) {
      setResult({
        type: "error",
        message: error.message || "An error occurred while sending order to APG",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <BlockStack gap="400">
      <Button
        variant="primary"
        onClick={handleSendToAPG}
        loading={loading}
        disabled={loading}
      >
        {loading ? "Sending to APG..." : "Send Order to APG"}
      </Button>

      {result && (
        <Banner
          status={result.type === "success" ? "success" : "critical"}
          onDismiss={() => setResult(null)}
        >
          <Text variant="bodyMd">{result.message}</Text>
        </Banner>
      )}
    </BlockStack>
  );
}

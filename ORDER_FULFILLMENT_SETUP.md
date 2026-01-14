# Order Fulfillment Button Setup

## Overview
The order fulfillment functionality allows you to manually send orders to APG after verifying payment and order validity.

## Current Implementation

The order fulfillment route is available at `/app/fulfill-order` and accepts POST requests with an `orderId` parameter.

## Adding Button to Order Details Page

### Option 1: Using Shopify Admin Action Extension (Recommended)

1. **Generate the extension** (if not already created):
   ```bash
   shopify app generate extension
   ```
   Select "Admin Action" and choose "Order details page"

2. **The extension files are located in** `extensions/order-fulfillment-button/`

3. **Deploy the extension**:
   ```bash
   shopify app deploy
   ```

### Option 2: Manual Button (Temporary Solution)

You can manually add a button to order details by:

1. Going to the order details page in Shopify Admin
2. Using browser developer tools to inject a button that calls:
   ```javascript
   fetch('/app/fulfill-order', {
     method: 'POST',
     headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
     body: new URLSearchParams({ orderId: 'gid://shopify/Order/ORDER_ID' })
   })
   ```

### Option 3: Use Shopify Flow or Scripts

You can create a Shopify Flow that triggers on order creation and calls the fulfillment endpoint.

## API Endpoint

**POST** `/app/fulfill-order`

**Body:**
```
orderId=gid://shopify/Order/123456789
```

**Response:**
```json
{
  "success": true,
  "apgOrderNumber": "APG-12345",
  "message": "Order #1001 successfully sent to APG. Order Number: APG-12345"
}
```

## Testing

1. Create a test order in your Shopify store
2. Navigate to the order details page
3. Click "Send Order to APG" button (if extension is installed)
4. Verify the order is sent to APG and order note is updated

## Troubleshooting

- **Button not appearing**: Ensure the extension is deployed and the app is installed
- **401 Unauthorized**: Check that the app has `write_orders` scope
- **Order already sent**: The system prevents duplicate submissions

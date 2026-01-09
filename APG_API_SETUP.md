# APG API Configuration Guide

## Overview
This application can fetch product data either from:
1. **API** (Recommended) - Real-time data directly from APG API
2. **CSV File** - Data from CSV file in `tmp/premier_data_feed_master.csv`

## API Setup

### Environment Variables

Add these to your `.env` file (or set them in your hosting environment):

```bash
# Enable/disable API usage (set to false to use CSV instead)
APG_USE_API=true

# APG API Base URL
# Contact your supplier for the correct API endpoint URL
APG_API_BASE_URL=https://api.premierwd.com/api/v1

# APG API Key (provided by your supplier)
APG_API_KEY=3720887b-7625-43ec-a57e-62ddbf3edf64
```

### API Key
Your current API key: `3720887b-7625-43ec-a57e-62ddbf3edf64`

### API Endpoints
The service will automatically try these common endpoint patterns:
- `/inventory`
- `/products/inventory`
- `/inventory/all`
- `/products`
- `/datafeed`

If your supplier uses a different endpoint structure, you can:
1. Set `APG_API_BASE_URL` to match your supplier's API base URL
2. The service will try multiple common endpoint patterns automatically

### Testing API Connection
1. Set `APG_USE_API=true` in your environment
2. Run the sync process
3. Check console logs for:
   - `✅ Successfully fetched from [endpoint]` - API working
   - `⚠️ API fetch failed, falling back to CSV` - Will use CSV as fallback

## CSV Fallback

If API is unavailable or `APG_USE_API=false`:
- The system will automatically use CSV files
- Place your CSV file at: `tmp/premier_data_feed_master.csv`
- CSV format should match the Premier data feed structure

## Data Fields Mapping

The API response will be automatically normalized to match CSV structure. Expected fields:
- `Upc` / `upc` - Product UPC/Barcode
- `MAP` / `map` - Minimum Advertised Price
- `Customer Price` / `cost` - Cost per item
- `USA Item Availability` / `inventory` - Inventory quantity
- `Premier Part Number` - Part number
- `Mfg Part Number` - Manufacturer part number

## Troubleshooting

### API Not Working
1. **Check API Key**: Verify `APG_API_KEY` is correct
2. **Check Base URL**: Verify `APG_API_BASE_URL` matches your supplier's API
3. **Check Network**: Ensure your server can reach the API endpoint
4. **Check Logs**: Look for specific error messages in console

### Inventory Not Updating
- Ensure inventory tracking is enabled in Shopify
- Check that location is configured in Shopify
- Verify inventory quantity values in API/CSV data

### Cost Not Showing
- Ensure inventory tracking is enabled (required for cost tracking)
- Verify `Customer Price` field exists in API/CSV data
- Check console logs for cost update warnings

## Support
If you need help:
1. Check console logs for specific error messages
2. Verify environment variables are set correctly
3. Test with CSV fallback first to isolate API issues

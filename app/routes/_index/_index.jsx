import { Page, Card, Text, Button, Stack } from "@shopify/polaris";

export default function Dashboard() {
  return (
    <Page title="CPG Automation">
      <Stack vertical gap="400">
        <Card>
          <Text variant="headingMd" as="h2">
            Welcome to CPG Automation 🚀
          </Text>
          <Text as="p">
            This dashboard will control product matching, pricing, inventory,
            and order automation.
          </Text>
        </Card>

        <Card>
          <Button primary>
            Start Product Sync (Phase 1)
          </Button>
        </Card>
      </Stack>
    </Page>
  );
}

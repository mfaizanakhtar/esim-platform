import {
  reactExtension,
  useAppMetafields,
  Text,
} from '@shopify/ui-extensions-react/customer-account';

export default reactExtension('customer-account.order.action.menu-item.render', () => (
  <EsimMenuItem />
));

function EsimMenuItem() {
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;

  let hasEsim = false;
  if (tokensRaw) {
    try {
      const map = JSON.parse(tokensRaw) as Record<string, string>;
      hasEsim = Object.keys(map).length > 0;
    } catch {
      // ignore
    }
  }

  if (!hasEsim) return null;

  return <Text>View eSIM Details</Text>;
}

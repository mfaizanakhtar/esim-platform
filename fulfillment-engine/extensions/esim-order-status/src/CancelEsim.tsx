import {
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
} from '@shopify/ui-extensions-react/customer-account';
import { useState, useCallback } from 'react';

const BACKEND_URL = 'https://esim-api-production-a56a.up.railway.app';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCancelEsim(accessToken: string | undefined, onSuccess: () => void) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const handleCancel = useCallback(async () => {
    if (!accessToken) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/esim/delivery/${accessToken}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (res.ok) {
        setConfirmingCancel(false);
        onSuccess();
      } else if (body.error === 'esim_already_activated') {
        setCancelError('This eSIM has already been installed and cannot be cancelled.');
      } else {
        setCancelError(body.message ?? 'Cancel failed. Please contact support.');
      }
    } catch {
      setCancelError('Network error. Please try again.');
    } finally {
      setCancelling(false);
    }
  }, [accessToken, onSuccess]);

  const startCancel = useCallback(() => setConfirmingCancel(true), []);
  const abortCancel = useCallback(() => {
    setConfirmingCancel(false);
    setCancelError(null);
  }, []);

  return { confirmingCancel, cancelling, cancelError, startCancel, abortCancel, handleCancel };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CancelSectionProps {
  accessToken: string | undefined;
  cancelled: boolean;
  onCancelled: () => void;
}

export function CancelSection({ accessToken, cancelled, onCancelled }: CancelSectionProps) {
  const { confirmingCancel, cancelling, cancelError, startCancel, abortCancel, handleCancel } =
    useCancelEsim(accessToken, onCancelled);

  if (!accessToken || cancelled) return null;

  if (!confirmingCancel) {
    return (
      <Button appearance="critical" onPress={startCancel}>
        Cancel eSIM
      </Button>
    );
  }

  return (
    <BlockStack spacing="base">
      <Text>
        Are you sure you want to cancel this eSIM? This will deactivate the eSIM and refund your
        order. This action cannot be undone if the eSIM has already been installed.
      </Text>
      {cancelError && (
        <Banner status="critical">
          <Text>{cancelError}</Text>
        </Banner>
      )}
      <InlineStack spacing="base">
        <Button appearance="critical" onPress={handleCancel} loading={cancelling}>
          Yes, Cancel eSIM
        </Button>
        <Button appearance="secondary" onPress={abortCancel}>
          Keep eSIM
        </Button>
      </InlineStack>
    </BlockStack>
  );
}

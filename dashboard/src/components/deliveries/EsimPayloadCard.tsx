import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, ChevronDown, ChevronUp, Check } from 'lucide-react';
import type { EsimPayload } from '@/lib/types';

interface EsimPayloadCardProps {
  payload: EsimPayload;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="ml-2 p-1 rounded hover:bg-muted transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground font-medium">{label}</p>
      <div className="flex items-center">
        <code className="text-xs bg-muted px-2 py-1 rounded font-mono break-all flex-1">
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

export function EsimPayloadCard({ payload }: EsimPayloadCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">eSIM Credentials</h3>
        <button
          onClick={() => setExpanded((p) => !p)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" /> Collapse
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> Expand
            </>
          )}
        </button>
      </div>

      {payload.lpa && (
        <div className="flex justify-center">
          <QRCodeSVG value={payload.lpa} size={200} />
        </div>
      )}

      {expanded && (
        <div className="space-y-3">
          {payload.iccid && <Field label="ICCID" value={payload.iccid} />}
          {payload.lpa && <Field label="LPA String" value={payload.lpa} />}
          {payload.activationCode && (
            <Field label="Activation Code" value={payload.activationCode} />
          )}
        </div>
      )}
    </div>
  );
}

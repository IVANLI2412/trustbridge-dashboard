"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";

import { AddressQr } from "@/components/AddressQr";
import { TrustlineStatusBadge } from "@/components/TrustlineStatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { computeNextAction, WIZARD_ACTION_COPY } from "@/lib/action-lookup";
import {
  checkAddressViaApi,
  describeCheckOutcome,
  type CheckOutcome,
} from "@/lib/check-api-client";
import { isValidGAddress, normalizeGAddress } from "@/lib/stellar-address";
import { cn } from "@/lib/utils";
import type { HorizonCheckResult } from "@/types";

interface AddressInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

type TerminalCheckOutcome = Exclude<
  CheckOutcome,
  { kind: "ok" } | { kind: "aborted" }
>;

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "result"; result: HorizonCheckResult }
  | { status: "outcome"; outcome: TerminalCheckOutcome };

export function AddressInput({
  value,
  onChange,
  disabled,
  className,
}: AddressInputProps) {
  const [checkState, setCheckState] = useState<CheckState>({ status: "idle" });
  const [debouncedValue, setDebouncedValue] = useState(value);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // Guards against debounce/network races: a newer check aborts the previous
  // request and only the most recently started one may update visible state.
  const requestIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  const normalized = normalizeGAddress(value);
  const addressValid = isValidGAddress(normalized);

  useEffect(() => {
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    setCheckState((current) =>
      current.status === "checking" ? { status: "idle" } : current
    );
    const timer = setTimeout(() => setDebouncedValue(value), 500);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(
    () => () => {
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    },
    []
  );

  const checkAddress = useCallback(async (address: string) => {
    const requestId = ++requestIdRef.current;

    if (!address.trim()) {
      setCheckState({ status: "idle" });
      return;
    }

    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;

    setCheckState({ status: "checking" });
    const outcome = await checkAddressViaApi(address, {
      signal: controller.signal,
    });

    if (activeControllerRef.current === controller) {
      activeControllerRef.current = null;
    }
    if (controller.signal.aborted || requestIdRef.current !== requestId) return;

    if (outcome.kind === "aborted") return;
    if (outcome.kind === "ok") {
      setCheckState({ status: "result", result: outcome.result });
      return;
    }
    setCheckState({ status: "outcome", outcome });
  }, []);

  useEffect(() => {
    checkAddress(debouncedValue);
  }, [debouncedValue, checkAddress]);

  const isChecking = checkState.status === "checking";
  const result = checkState.status === "result" ? checkState.result : null;
  const outcome = checkState.status === "outcome" ? checkState.outcome : null;
  const statusText = isChecking
    ? "Checking this address with Horizon…"
    : outcome
      ? describeCheckOutcome(outcome)
      : "";

  async function copyAddress() {
    if (!addressValid) return;
    try {
      await navigator.clipboard.writeText(normalized);
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setCopied(false);
    }
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="space-y-2">
        <Label htmlFor="stellar-address">
          Your Stellar wallet address (starts with G)
        </Label>
        <p id="stellar-address-help" className="text-xs text-muted-foreground">
          Paste the public address only — the one starting with a capital G.
          Never paste your secret key (it starts with S). We check the wallet as
          you type and show what is still missing. When the address is valid, a
          QR code appears so you can double-check it on another device.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="relative min-w-0 flex-1">
            <Input
              id="stellar-address"
              data-testid="stellar-address-input"
              placeholder="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              disabled={disabled}
              className="font-mono pr-10"
              spellCheck={false}
              autoComplete="off"
              aria-describedby="stellar-address-help"
              aria-busy={isChecking}
            />
            {isChecking && (
              <Loader2
                className="absolute right-3 top-2.5 h-5 w-5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void copyAddress()}
            disabled={disabled || !addressValid}
            aria-disabled={disabled || !addressValid}
            data-testid="copy-address"
            aria-label={
              addressValid
                ? "Copy Stellar address to clipboard"
                : "Copy disabled until the address is a valid G-address"
            }
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="copy-address-status"
        >
          {copied
            ? "Address copied to clipboard"
            : copyFailed
              ? "Could not copy address"
              : ""}
        </p>
        {copyFailed && (
          <p
            className="text-xs text-destructive"
            role="alert"
            data-testid="copy-address-error"
          >
            Could not reach the clipboard. Select the address above and copy it
            manually.
          </p>
        )}
        {value.trim() && !addressValid && (
          <p
            className="text-xs text-amber-700 dark:text-amber-300"
            role="status"
            data-testid="address-invalid-hint"
          >
            Enter a full checksum-valid G-address (56 characters) to enable copy
            and QR. Typos here often cause PAYMENT_NO_TRUST failures.
          </p>
        )}
        <p
          className={cn(
            "text-xs",
            outcome &&
              (outcome.kind === "rate_limited" ||
                outcome.kind === "network_error" ||
                outcome.kind === "error")
              ? "text-destructive"
              : outcome &&
                  (outcome.kind === "circuit_open" ||
                    outcome.kind === "timeout")
                ? "text-amber-700 dark:text-amber-300"
                : "text-muted-foreground",
            !statusText ? "sr-only" : undefined
          )}
          role="status"
          aria-live="polite"
          aria-busy={isChecking}
          data-testid="address-check-status"
        >
          {statusText}
        </p>
      </div>

      {addressValid && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Scan to verify this address</p>
          <AddressQr address={normalized} />
        </div>
      )}

      {result && (
        <div
          className="rounded-lg border bg-muted/40 p-4 space-y-3"
          aria-live="polite"
          data-testid="address-check-result"
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">Can this wallet be paid?</span>
            <TrustlineStatusBadge status={result.readiness} />
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Wallet exists on Stellar</dt>
              <dd className="font-medium">{result.funded ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">USDC turned on</dt>
              <dd className="font-medium">{result.trustline ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Approved by USDC issuer</dt>
              <dd className="font-medium">
                {result.trustline
                  ? result.trustline_authorized
                    ? "Yes"
                    : "Not yet — waiting on the issuer"
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">XLM in the wallet</dt>
              <dd className="font-medium">{result.xlm_balance} XLM</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">XLM you can actually use</dt>
              <dd className="font-medium">{result.spendable_xlm_balance} XLM</dd>
            </div>
          </dl>
          {result.errors.length > 0 && (
            <ul className="text-sm text-destructive space-y-1">
              {result.errors.map((error) => (
                <li key={error}>• {error}</li>
              ))}
            </ul>
          )}
          <p className="text-sm font-medium" data-testid="next-action-copy">
            What to do next: {WIZARD_ACTION_COPY[computeNextAction(result)]}
          </p>
        </div>
      )}
    </div>
  );
}

export type { HorizonCheckResult };

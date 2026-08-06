export function requireSupportedAiScriptProvider(capability, provider, supportedProviders) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (!supportedProviders.includes(normalized)) {
    throw new Error(
      `AI ${capability} provider "${normalized || "unknown"}" is not supported.`,
    );
  }
  return normalized;
}

export function sanitizeAiScriptError(error, secrets = []) {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "AI provider request failed.";

  if (/(?:api[_ -]?key|authorization|x-api-key|bearer|access[_ -]?token|secret)/i.test(rawMessage)) {
    return "AI provider credential error [redacted].";
  }

  let message = rawMessage;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join("[redacted]");
  }

  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_ -]?key|authorization|x-api-key|token|secret))\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1[redacted]@");
}

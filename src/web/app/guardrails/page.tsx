"use client";

import React from "react";
import { useSearchParams, useRouter } from "next/navigation";
import CrisisIntervention from "../../components/guardrails/CrisisIntervention";
import { useAuth } from "../../contexts/AuthContext";

export default function GuardrailsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();

  const severityParam = searchParams.get("severity") as
    | "info"
    | "warning"
    | "critical"
    | null;
  const trigger = searchParams.get("trigger");
  const cooldownParam = searchParams.get("cooldown");

  const severity = severityParam || "warning";
  const cooldownMinutes = cooldownParam ? parseInt(cooldownParam, 10) : 15;

  const handleDismiss = () => {
    router.push("/dashboard");
  };

  if (authLoading) return null;

  return (
    <CrisisIntervention
      severity={severity}
      trigger={trigger || undefined}
      cooldownMinutes={cooldownMinutes}
      onDismiss={handleDismiss}
      onContactSupport={handleDismiss}
      userId={user?.id}
    />
  );
}

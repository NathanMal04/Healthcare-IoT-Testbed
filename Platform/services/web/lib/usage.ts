import { apiRequest } from "@/lib/api";

export interface Usage {
  period: string;
  budget: { monthlyLimit: number; spent: number; held: number; available: number; heavyEnabled: boolean };
  totals: Record<string, number>;
  total: number;
  entries: {
    source: string;
    kind: string;
    amount: number;
    resource?: string;
    seconds?: number;
    minutes?: number;
    runId?: string;
    recordedAt?: string;
  }[];
  truncated: boolean;
}

export function getUsage(period?: string): Promise<Usage> {
  return apiRequest("GET", "/usage", { query: { period } });
}

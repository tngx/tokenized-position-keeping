import { parseUnits } from "ethers";

export function formatQty(quantity: bigint, decimals: number): string {
    const negative = quantity < 0n;
    const abs = negative ? -quantity : quantity;
    const base = 10n ** BigInt(decimals);
    const whole = (abs / base).toString();
    const text = decimals > 0 ? `${whole}.${(abs % base).toString().padStart(decimals, "0")}` : whole;
    return negative ? `-${text}` : text;
}

export function parseQty(quantity: string, decimals: number): bigint {
    const value = parseUnits(quantity.trim(), decimals);
    if (value <= 0n) throw new Error("Quantity must be positive");
    return value;
}

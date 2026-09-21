import { invoke } from "@tauri-apps/api/core";
import { getOkxDcdRealizedYield, type OkxDcdOrder } from "./okxAccount";

// Quote every field, preserve source decimals, and neutralize spreadsheet formulas.
export function csvCell(value: string | null): string {
  if (value === null) return '""';
  const safe = /^[\s]*[=+@-]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value)
    ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildOkxDcdCsv(orders: OkxDcdOrder[], chinese: boolean): string {
  const headers = chinese
    ? ["订单ID", "产品ID", "类型", "状态", "目标价", "申购本金", "本金币种", "年化收益率(小数)", "实际收益", "收益币种", "结算数量", "结算币种", "结算价", "申购时间(UTC)", "到期时间(UTC)", "结算或赎回时间(UTC)", "更新时间(UTC)"]
    : ["Order ID", "Product ID", "Type", "State", "Target price", "Principal", "Principal currency", "APR (decimal)", "Realized yield", "Yield currency", "Settlement amount", "Settlement currency", "Settlement price", "Subscribed (UTC)", "Expiry (UTC)", "Settled or redeemed (UTC)", "Updated (UTC)"];
  const rows = orders.map(order => {
    const realized = getOkxDcdRealizedYield(order);
    const settledAt = order.state === "redeemed" ? order.updatedAt : order.state === "settled" ? order.settledAt : null;
    return [order.orderId, order.productId, order.optionType, order.state, order.strike,
      order.principal, order.principalCurrency, order.annualizedYield,
      realized === null ? null : realized.amount, realized === null ? null : realized.currency,
      order.settledAmount, order.settledCurrency, order.settlementPrice,
      new Date(order.createdAt).toISOString(), new Date(order.expiresAt).toISOString(),
      settledAt === null ? null : new Date(settledAt).toISOString(), new Date(order.updatedAt).toISOString()];
  });
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function saveOkxDcdCsv(orders: OkxDcdOrder[], chinese: boolean): Promise<string> {
  return invoke<string>("okx_save_dcd_csv", { csv: buildOkxDcdCsv(orders, chinese) });
}

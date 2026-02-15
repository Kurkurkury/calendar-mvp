const CURRENCY_SYMBOLS = ["CHF", "EUR", "€", "Fr", "SFR"];

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function detectCurrency(line) {
  const hit = CURRENCY_SYMBOLS.find((symbol) => new RegExp(`\\b${symbol}\\b|${symbol}`, "i").test(line));
  if (!hit) return "CHF";
  if (hit === "€" || hit === "EUR") return "EUR";
  return "CHF";
}

function extractPrices(line) {
  const matches = [...String(line || "").matchAll(/(?:CHF|EUR|€|Fr\.?|SFR\s*)?\s*(\d{1,4}(?:[.,]\d{1,2}))(?!\d)/gi)];
  return matches
    .map((match) => ({
      raw: match[0],
      value: toNumber(match[1]),
      index: match.index || 0,
    }))
    .filter((entry) => Number.isFinite(entry.value));
}

function extractQty(rawLine) {
  const line = normalizeWhitespace(rawLine);
  const match = line.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml|stk|st\.|x|pack|pkt)\b/i);
  if (!match) return { qty: null, unit: null };
  return {
    qty: toNumber(match[1]),
    unit: String(match[2] || "").replace(".", "").toLowerCase(),
  };
}

function cleanName(rawLine) {
  return normalizeWhitespace(
    String(rawLine || "")
      .replace(/\b(total|summe|gesamt|betrag|zu zahlen|kasse)\b/gi, "")
      .replace(/(?:CHF|EUR|€|Fr\.?|SFR\s*)?\s*\d{1,4}(?:[.,]\d{1,2})/gi, "")
      .replace(/\b\d+(?:[.,]\d+)?\s*(kg|g|l|ml|stk|st\.|x|pack|pkt)\b/gi, "")
      .replace(/[|*_~]+/g, " ")
  );
}

function confidenceFor({ hasName, hasPrice, hasQty, totalLine }) {
  let score = 0.2;
  if (hasName) score += 0.35;
  if (hasPrice) score += 0.35;
  if (hasQty) score += 0.1;
  if (totalLine) score -= 0.15;
  return Math.max(0.05, Math.min(0.99, score));
}

function parseExpenseText(rawText) {
  const text = String(rawText || "");
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  let total = null;
  let foundAnyPrice = false;
  const parsedItems = [];
  const priceOnlyEntries = [];

  lines.forEach((line) => {
    const lower = line.toLowerCase();
    const prices = extractPrices(line);
    const hasPrice = prices.length > 0;
    foundAnyPrice = foundAnyPrice || hasPrice;

    const isTotalLine = /(total|summe|gesamt|betrag|zu zahlen)/i.test(lower);
    if (isTotalLine && hasPrice) {
      total = prices[prices.length - 1].value;
      return;
    }

    if (!hasPrice && line.length < 2) return;

    const { qty, unit } = extractQty(line);
    const name = cleanName(line);
    const hasName = Boolean(name && /[a-zäöü]/i.test(name));
    const currency = detectCurrency(line);

    if (hasName) {
      parsedItems.push({
        rawName: line,
        normalizedName: name,
        qty,
        unit,
        price: hasPrice ? prices[0].value : null,
        currency: hasPrice ? currency : null,
        confidence: confidenceFor({ hasName: true, hasPrice, hasQty: qty !== null, totalLine: false }),
      });
      return;
    }

    if (hasPrice) {
      prices.forEach((price) => {
        priceOnlyEntries.push({ price: price.value, currency });
      });
    }
  });

  if (!parsedItems.length && total !== null) {
    parsedItems.push({
      rawName: "Einkauf (Total)",
      normalizedName: "Einkauf (Total)",
      qty: null,
      unit: null,
      price: total,
      currency: "CHF",
      confidence: 0.55,
    });
  }

  if (!parsedItems.length && priceOnlyEntries.length) {
    priceOnlyEntries.forEach((entry, index) => {
      parsedItems.push({
        rawName: `Unbekannt ${index + 1}`,
        normalizedName: `Unbekannt ${index + 1}`,
        qty: null,
        unit: null,
        price: entry.price,
        currency: entry.currency || "CHF",
        confidence: 0.35,
      });
    });
  }

  const foundTotal = Number.isFinite(total);
  const hasSignal = parsedItems.length > 0 || foundAnyPrice || foundTotal;
  const warnings = [];
  if (!hasSignal) {
    warnings.push("Konnte wenig erkennen – bitte prüfen");
  }
  if (parsedItems.some((item) => item.price === null)) {
    warnings.push("Einige Positionen ohne Preis erkannt");
  }

  return {
    parsedItems,
    total: foundTotal ? total : null,
    foundAnyPrice,
    foundTotal,
    hasSignal,
    warnings,
  };
}

export { parseExpenseText };
